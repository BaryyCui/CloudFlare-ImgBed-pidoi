import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';

const DAY = 86400000;
const LEASE_MS = 60000;
const PREVIEW_MS = 15 * 60000;
const DEFAULT_CONFIG = Object.freeze({ enabled: false, retentionDays: 7, runAt: '03:00', timezone: 'Asia/Shanghai', folder: 'videos', version: 0 });
const iso = value => value == null ? null : new Date(value).toISOString();
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));

function problem(code, message, status = 400) {
    return Object.assign(new Error(message), { code, status });
}

function safeFailureCode(error) {
    const code = error?.code;
    if (typeof code === 'string' && /^(?:SQLITE_[A-Z0-9_]{1,40}|E[A-Z0-9]{1,20})$/.test(code)) return code;
    return ['file_changed', 'lease_lost'].includes(code) ? code : 'cleanup_failed';
}

function logWorkerFailure(stage, error) {
    // Never log database messages, paths, SQL, credentials or source URLs.
    console.error(`Retention ${stage} failed (${safeFailureCode(error)}); its persisted journal remains available for recovery.`);
}

// Shanghai has a fixed UTC+08 offset. Always choose a strictly future slot;
// a late restart catches up once, then advances directly beyond the current day.
function nextSlot(time, runAt) {
    const local = new Date(time + 8 * 3600000);
    const [hours, minutes] = runAt.split(':').map(Number);
    let slot = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hours - 8, minutes);
    if (slot <= time) slot += DAY;
    return slot;
}

function mediaMetadata(row, cutoff) {
    let metadata;
    try { metadata = JSON.parse(row.metadata); } catch { return null; }
    const timestamp = metadata?.TimeStamp;
    if (metadata?.Channel !== 'CloudflareR2' || !/^(image|video|audio)\//.test(metadata.FileType || '') ||
        !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp >= cutoff) return null;
    return metadata;
}

/** Docker-only retention. All SQL and paths are supplied by the ImgBed host. */
export function createRetentionService({ database, storage, dataDir, now = Date.now }) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS retention_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retention_previews (token TEXT PRIMARY KEY, version INTEGER NOT NULL, cutoff INTEGER NOT NULL, expires_at INTEGER NOT NULL, summary TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retention_preview_items (token TEXT NOT NULL, file_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(token,file_id));
        CREATE TABLE IF NOT EXISTS retention_runs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS retention_items (run_id TEXT NOT NULL, file_id TEXT NOT NULL, snapshot TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, PRIMARY KEY(run_id,file_id));
        CREATE TABLE IF NOT EXISTS retention_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, token INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0, run_id TEXT);
        INSERT OR IGNORE INTO retention_lease(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS retention_tombstones (file_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_retention_items_state ON retention_items(run_id,state);
    `);
    const owner = randomUUID();
    let closed = false;
    let interval;
    let runningPromise;
    let activeId;
    let ticking = false;
    const readState = key => {
        const row = database.prepare('SELECT value FROM retention_state WHERE key=?').get(key);
        return row ? JSON.parse(row.value) : null;
    };
    const writeState = (key, value) => database.prepare('INSERT OR REPLACE INTO retention_state(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
    const config = () => readState('config') || { ...DEFAULT_CONFIG };
    const readRun = id => {
        const row = database.prepare('SELECT payload FROM retention_runs WHERE id=?').get(id);
        return row ? JSON.parse(row.payload) : null;
    };
    const writeRun = run => database.prepare('UPDATE retention_runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id);
    const rowFor = key => database.prepare('SELECT id,value,metadata FROM files WHERE id=?').get(key);
    const sameRecord = (row, snapshot) => row && row.metadata === snapshot.metadata && row.value === snapshot.value;

    function leaseValid(id, token) {
        const lease = database.prepare('SELECT * FROM retention_lease WHERE id=1').get();
        return lease.owner === owner && lease.token === token && lease.run_id === id && lease.expires_at > now();
    }
    function assertLease(id, token) {
        if (!leaseValid(id, token)) throw problem('lease_lost', 'Cleanup ownership changed; this worker stopped.', 409);
    }
    function release(id, token) {
        database.prepare('UPDATE retention_lease SET owner=NULL,expires_at=0,run_id=NULL WHERE id=1 AND owner=? AND token=? AND run_id=?').run(owner, token, id);
    }
    function claim(id) {
        const lease = database.prepare('SELECT * FROM retention_lease WHERE id=1').get();
        if (lease.owner && lease.expires_at > now()) throw problem('run_active', 'A cleanup is already running.', 409);
        const token = lease.token + 1;
        database.prepare('UPDATE retention_lease SET owner=?,token=?,expires_at=?,run_id=? WHERE id=1').run(owner, token, now() + LEASE_MS, id);
        return token;
    }

    async function getRun(id) {
        const run = readRun(id);
        if (!run) throw problem('run_not_found', 'Cleanup run was not found.', 404);
        return run;
    }

    async function getStatus() {
        const rows = database.prepare('SELECT payload FROM retention_runs ORDER BY created_at DESC,rowid DESC LIMIT 20').all();
        const recentRuns = rows.map(row => JSON.parse(row.payload));
        let disk = null;
        try {
            const stats = statfsSync(dataDir);
            disk = { totalBytes: stats.blocks * stats.bsize, availableBytes: stats.bavail * stats.bsize };
        } catch { /* Capacity is informational; unsupported filesystems can omit it. */ }
        return { supported: true, config: config(), nextRunAt: iso(readState('nextRunAt')), activeRun: recentRuns.find(run => run.status === 'running') || null, recentRuns, disk };
    }

    async function saveConfig(input) {
        if (!input || typeof input.enabled !== 'boolean' || !Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650 ||
            typeof input.runAt !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.runAt)) {
            throw problem('invalid_config', 'Use a boolean enabled value, 1–3650 retention days and an HH:mm daily time.');
        }
        database.transaction(() => {
            const previous = config();
            const changed = previous.enabled !== input.enabled || previous.retentionDays !== input.retentionDays || previous.runAt !== input.runAt;
            if (!changed) return;
            const updated = { ...DEFAULT_CONFIG, enabled: input.enabled, retentionDays: input.retentionDays, runAt: input.runAt, version: previous.version + 1 };
            writeState('config', updated);
            writeState('nextRunAt', updated.enabled ? nextSlot(now(), updated.runAt) : null);
        }).immediate();
        return getStatus();
    }

    async function makePreview() {
        const current = config();
        const cutoff = now() - current.retentionDays * DAY;
        const token = randomUUID();
        const samples = [];
        let count = 0;
        let scanned = 0;
        let skipped = 0;
        let bytes = 0;
        let cursor = 'videos/';
        database.transaction(() => {
            database.prepare('DELETE FROM retention_preview_items WHERE token IN (SELECT token FROM retention_previews WHERE expires_at<=?)').run(now());
            database.prepare('DELETE FROM retention_previews WHERE expires_at<=?').run(now());
            // An unfinished snapshot cannot be consumed: its token is not
            // returned and its summary is finalized only after the last page.
            database.prepare('INSERT INTO retention_previews VALUES(?,?,?,?,?)').run(token, current.version, cutoff, now() + PREVIEW_MS, '{}');
        }).immediate();
        try {
            while (true) {
                if (closed) throw problem('service_closed', 'Cleanup service is stopping.', 503);
                const rows = database.prepare("SELECT id,value,metadata FROM files WHERE id>? AND id<'videos0' ORDER BY id LIMIT 100").all(cursor);
                if (!rows.length) break;
                const candidates = [];
                for (const row of rows) {
                    cursor = row.id;
                    scanned++;
                    const metadata = mediaMetadata(row, cutoff);
                    if (!metadata) { skipped++; continue; }
                    const object = storage.inspectForRetention(row.id);
                    if (!object.safe || !object.exists || object.active || !Number.isFinite(object.mtimeMs) || object.mtimeMs <= 0 || object.mtimeMs >= cutoff) { skipped++; continue; }
                    candidates.push({ key: row.id, value: row.value, metadata: row.metadata, identity: object.identity, bytes: object.size });
                    count++;
                    bytes += object.size;
                    if (samples.length < 20) samples.push({ key: row.id, bytes: object.size, uploadedAt: iso(metadata.TimeStamp) });
                }
                database.transaction(() => {
                    const insert = database.prepare('INSERT INTO retention_preview_items VALUES(?,?,?)');
                    for (const candidate of candidates) insert.run(token, candidate.key, JSON.stringify(candidate));
                    database.prepare('UPDATE retention_previews SET expires_at=? WHERE token=?').run(now() + PREVIEW_MS, token);
                }).immediate();
                // Uploads, request handlers and lease renewals run between pages.
                await yieldTurn();
            }
            const expiresAt = now() + PREVIEW_MS;
            const summary = { previewToken: token, cutoff: iso(cutoff), expiresAt: iso(expiresAt), count, bytes, samples, skipped };
            database.prepare('UPDATE retention_previews SET expires_at=?,summary=? WHERE token=?').run(expiresAt, JSON.stringify({ ...summary, scanned }), token);
            return summary;
        } catch (error) {
            database.prepare('DELETE FROM retention_preview_items WHERE token=?').run(token);
            database.prepare('DELETE FROM retention_previews WHERE token=?').run(token);
            throw error;
        }
    }

    async function preview() { return makePreview(); }

    function createRun(token, trigger) {
        return database.transaction(() => {
            const snapshot = database.prepare('SELECT * FROM retention_previews WHERE token=?').get(token);
            if (!snapshot || snapshot.expires_at <= now() || snapshot.version !== config().version) throw problem('preview_expired', 'Preview expired or settings changed; preview again.', 409);
            if (trigger === 'scheduled' && (!config().enabled || readState('nextRunAt') == null || readState('nextRunAt') > now())) throw problem('schedule_changed', 'This scheduled slot has already been handled.', 409);
            const id = randomUUID();
            const fence = claim(id);
            const summary = JSON.parse(snapshot.summary);
            const run = { id, status: 'running', trigger, startedAt: iso(now()), finishedAt: null, cutoff: iso(snapshot.cutoff), scanned: summary.scanned, eligible: summary.count, deleted: 0, freedBytes: 0, skipped: 0, failed: 0, error: null, failures: [] };
            database.prepare('INSERT INTO retention_runs VALUES(?,?,?)').run(id, now(), JSON.stringify(run));
            database.prepare("INSERT INTO retention_items(run_id,file_id,snapshot) SELECT ?,file_id,snapshot FROM retention_preview_items WHERE token=?").run(id, token);
            database.prepare('DELETE FROM retention_preview_items WHERE token=?').run(token);
            database.prepare('DELETE FROM retention_previews WHERE token=?').run(token);
            if (trigger === 'scheduled') writeState('nextRunAt', nextSlot(now(), config().runAt));
            return { run, fence };
        }).immediate();
    }

    function noteItem(run, item, state, reason = null) {
        database.prepare('UPDATE retention_items SET state=?,error=? WHERE run_id=? AND file_id=?').run(state, reason, run.id, item.file_id);
        if (state === 'skipped') run.skipped++;
        if (state === 'failed' || reason) {
            run.failed++;
            if (run.failures.length < 20) run.failures.push({ key: item.file_id, reason: reason || 'storage_failed' });
        }
        writeRun(run);
    }

    function finalize(run, item, snapshot, fence) {
        // SQLite rollback cannot undo JavaScript mutations. Publish counters to
        // the running worker only after the whole database transaction commits.
        const updatedRun = { ...run, failures: [...run.failures] };
        database.transaction(() => {
            assertLease(run.id, fence);
            const row = rowFor(item.file_id);
            if (row && !sameRecord(row, snapshot)) {
                noteItem(updatedRun, item, 'skipped');
                return;
            }
            database.prepare('DELETE FROM files WHERE id=? AND metadata=? AND value IS ?').run(item.file_id, snapshot.metadata, snapshot.value);
            database.prepare('INSERT OR REPLACE INTO retention_tombstones(file_id,deleted_at) VALUES(?,?)').run(item.file_id, now());
            const identity = JSON.parse(snapshot.metadata).ImportIdentity;
            if (typeof identity === 'string' && identity) {
                const key = `manage@import@${identity}`;
                const previous = database.prepare('SELECT value FROM settings WHERE key=?').get(key);
                try {
                    if (previous && JSON.parse(previous.value)?.result?.src === `/file/${item.file_id}`) database.prepare('DELETE FROM settings WHERE key=? AND value=?').run(key, previous.value);
                } catch { /* Do not delete an unrecognized import record. */ }
            }
            database.prepare("UPDATE retention_items SET state='done',error=NULL WHERE run_id=? AND file_id=?").run(run.id, item.file_id);
            updatedRun.deleted++;
            updatedRun.freedBytes += snapshot.bytes;
            writeRun(updatedRun);
        }).immediate();
        Object.assign(run, updatedRun);
    }

    function processItem(run, item, fence) {
        assertLease(run.id, fence);
        const snapshot = JSON.parse(item.snapshot);
        const row = rowFor(item.file_id);
        if (row && !sameRecord(row, snapshot)) return noteItem(run, item, 'skipped');
        if (!row && item.state !== 'deleting') return noteItem(run, item, 'skipped');
        const inspected = storage.inspectForRetention(item.file_id);
        if (inspected.active && item.state === 'deleting') return noteItem(run, item, 'deleting', 'active_write');
        if (!inspected.exists && inspected.safe && item.state === 'deleting') return finalize(run, item, snapshot, fence);
        if (!inspected.exists || !inspected.safe || inspected.active) return noteItem(run, item, 'skipped');
        // Journal the intent before unlink. Recovery can finish the database half
        // only if this exact metadata still owns the now-missing object.
        database.prepare("UPDATE retention_items SET state='deleting',error=NULL WHERE run_id=? AND file_id=?").run(run.id, item.file_id);
        const deleted = storage.deleteForRetention(item.file_id, snapshot.identity, () => {
            assertLease(run.id, fence);
            if (!sameRecord(rowFor(item.file_id), snapshot)) throw problem('file_changed', 'The file changed during cleanup.', 409);
        });
        if (!deleted.deleted) return noteItem(run, item, 'skipped');
        return finalize(run, item, snapshot, fence);
    }

    function persistTerminal(run) {
        database.transaction(() => {
            writeRun(run);
            const retryKey = `recovery@${run.id}`;
            const unresolved = database.prepare("SELECT 1 FROM retention_items WHERE run_id=? AND state IN ('pending','deleting') LIMIT 1").get(run.id);
            if (unresolved && ['partial', 'failed'].includes(run.status)) {
                const attempts = (readState(retryKey)?.attempts || 0) + 1;
                const delay = Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6));
                writeState(retryKey, { attempts, nextAt: now() + delay });
            } else {
                database.prepare('DELETE FROM retention_state WHERE key=?').run(retryKey);
            }
        }).immediate();
    }

    function launch(id, fence) {
        activeId = id;
        runningPromise = (async () => {
            await yieldTurn();
            let run;
            try {
                run = readRun(id);
                let cursor = '';
                while (!closed) {
                    assertLease(id, fence);
                    database.prepare('UPDATE retention_lease SET expires_at=? WHERE id=1 AND owner=? AND token=?').run(now() + LEASE_MS, owner, fence);
                    const item = database.prepare("SELECT * FROM retention_items WHERE run_id=? AND file_id>? AND state IN ('pending','deleting') ORDER BY file_id LIMIT 1").get(id, cursor);
                    if (!item) break;
                    cursor = item.file_id;
                    try { processItem(run, item, fence); }
                    catch (error) {
                        if (error.code === 'lease_lost') throw error;
                        // A failed database finalization keeps the deleting journal;
                        // it is recoverable without attempting an unconditional unlink.
                        const state = database.prepare('SELECT state FROM retention_items WHERE run_id=? AND file_id=?').get(id, item.file_id)?.state;
                        noteItem(run, item, state === 'deleting' ? 'deleting' : 'failed', safeFailureCode(error));
                    }
                    await yieldTurn();
                }
                if (leaseValid(id, fence)) {
                    run = readRun(id);
                    run.status = closed ? 'interrupted' : run.failed ? 'partial' : 'completed';
                    run.finishedAt = iso(now());
                    persistTerminal(run);
                }
            } catch (error) {
                try {
                    if (leaseValid(id, fence)) {
                        run = readRun(id);
                        run.status = 'failed'; run.error = 'Cleanup stopped; unresolved items will be retried after a delay.'; run.finishedAt = iso(now()); persistTerminal(run);
                    }
                } catch (persistError) {
                    // Disk-full and I/O errors can also prevent recording failure.
                    // Keep the previous journal and let the persisted lease expire.
                    logWorkerFailure('terminal state persistence', persistError);
                }
            } finally {
                try { release(id, fence); }
                catch (releaseError) { logWorkerFailure('lease release', releaseError); }
                if (activeId === id) activeId = null;
                runningPromise = null;
            }
        })().catch(error => {
            // This worker is detached from the request that started it. Always
            // consume a final rejection so a cleanup fault cannot stop Node.
            logWorkerFailure('background worker', error);
        });
    }

    async function startManual(input) {
        if (closed) throw problem('service_closed', 'Cleanup service is stopping.', 503);
        if (input?.confirmation !== 'DELETE_EXPIRED_FILES') throw problem('confirmation_required', 'Confirm deletion explicitly before running cleanup.');
        if (typeof input.previewToken !== 'string') throw problem('preview_expired', 'Create a preview before running cleanup.', 409);
        const { run, fence } = createRun(input.previewToken, 'manual');
        launch(run.id, fence);
        return run;
    }

    function recover() {
        if (activeId) return true;
        const lease = database.prepare('SELECT * FROM retention_lease WHERE id=1').get();
        if (lease.owner && lease.expires_at > now()) return true;
        const rows = database.prepare("SELECT r.id FROM retention_runs r LEFT JOIN retention_state retry ON retry.key='recovery@'||r.id WHERE (json_extract(r.payload,'$.status') IN ('running','interrupted') OR EXISTS (SELECT 1 FROM retention_items i WHERE i.run_id=r.id AND i.state IN ('pending','deleting'))) AND (retry.value IS NULL OR json_extract(retry.value,'$.nextAt')<=?) ORDER BY r.created_at LIMIT 1").all(now());
        if (!rows.length) return false;
        const id = rows[0].id;
        const fence = database.transaction(() => {
            const token = claim(id);
            const run = readRun(id);
            run.status = 'running'; run.finishedAt = null; run.failed = 0; run.failures = []; run.error = null;
            writeRun(run);
            return token;
        }).immediate();
        launch(id, fence);
        return true;
    }

    async function tick() {
        if (closed || activeId || ticking) return;
        ticking = true;
        try {
            const lease = database.prepare('SELECT * FROM retention_lease WHERE id=1').get();
            if (lease.owner && lease.expires_at > now()) return;
            const current = config();
            const planned = readState('nextRunAt');
            // A permanently broken old journal must not starve newly due files.
            // Run one due daily snapshot first; recovery remains durable and is
            // retried with a persisted, bounded exponential delay between slots.
            if (current.enabled && planned != null && planned <= now()) {
                const snapshot = await makePreview();
                const { run, fence } = createRun(snapshot.previewToken, 'scheduled');
                launch(run.id, fence);
            } else {
                recover();
            }
        } catch (error) {
            if (!['run_active', 'schedule_changed', 'preview_expired', 'service_closed'].includes(error.code)) console.error('Retention scheduler could not start cleanup.');
        } finally { ticking = false; }
    }

    async function start() {
        if (interval || closed) return;
        await tick();
        interval = setInterval(() => { void tick(); }, 30000);
        interval.unref?.();
    }

    async function close() {
        closed = true;
        clearInterval(interval);
        interval = null;
        if (runningPromise) {
            try { await runningPromise; }
            catch (error) { logWorkerFailure('shutdown', error); }
        }
    }

    // Every cached read passes this barrier, including snapshots published by a
    // merge that began before deletion. A real new row wins over the tombstone;
    // use its metadata so old operations cannot disguise the new generation.
    const barrierExists = database.prepare('SELECT 1 FROM retention_tombstones LIMIT 1');
    function hasDeletionBarriers() { return !!barrierExists.get(); }

    async function filterIndexFiles(files) {
        if (!hasDeletionBarriers()) return files;
        const result = new Map();
        const currentRows = database.prepare('SELECT id,metadata FROM files WHERE id IN (SELECT value FROM json_each(?))');
        for (let offset = 0; offset < files.length; offset += 500) {
            const batch = new Map(files.slice(offset, offset + 500).map(file => [file.id, file]));
            // Old add -> move sequences can rename a deleted key into a new
            // ghost key. Validate all cached entries, using one query per batch.
            for (const row of currentRows.all(JSON.stringify([...batch.keys()]))) {
                try { result.set(row.id, { ...batch.get(row.id), metadata: JSON.parse(row.metadata) }); }
                catch { /* Invalid records stay hidden. */ }
            }
            await yieldTurn();
        }
        // A delayed remove can erase a new generation from the old snapshot.
        // Page through live replacements rather than loading all tombstones.
        const replacements = database.prepare('SELECT t.file_id,f.metadata FROM retention_tombstones t JOIN files f ON f.id=t.file_id WHERE t.file_id>? ORDER BY t.file_id LIMIT 500');
        let cursor = '';
        while (true) {
            const rows = replacements.all(cursor);
            if (!rows.length) break;
            for (const row of rows) {
                cursor = row.file_id;
                try { result.set(row.file_id, { id: row.file_id, metadata: JSON.parse(row.metadata) }); }
                catch { result.delete(row.file_id); }
            }
            await yieldTurn();
        }
        return [...result.values()].sort((a, b) => (b.metadata?.TimeStamp || 0) - (a.metadata?.TimeStamp || 0));
    }

    function validateImportReplay(identity, previous) {
        const src = previous?.result?.src;
        if (typeof src !== 'string' || !src.startsWith('/file/')) return false;
        const key = src.slice('/file/'.length);
        const row = rowFor(key);
        if (!row) return false;
        try {
            const metadata = JSON.parse(row.metadata);
            if (metadata.ImportIdentity !== identity) return false;
            if (metadata.Channel !== 'CloudflareR2') return true;
            const object = storage.inspectForRetention(key);
            return object.safe && object.exists && !object.active;
        } catch { return false; }
    }

    return { getStatus, saveConfig, preview, startManual, getRun, start, close, hasDeletionBarriers, filterIndexFiles, validateImportReplay };
}
