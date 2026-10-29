'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, finish, runPreview } = require('./retention-fixture.cjs');

describe('Local retention candidates and durable deletion', function () {
    let f;
    beforeEach(async () => { f = await fixture(); });
    afterEach(async () => { await f.cleanup(); });

    it('defaults disabled and previews only expired local media under the exact videos subtree without deleting', async () => {
        const service = await f.service();
        await f.file('videos/old.mp4');
        await f.file('videos/nested/photo.png', { type: 'image/png' });
        await f.file('videos/sound.mp3', { type: 'audio/mpeg' });
        await f.file('videos-old/no.mp4');
        await f.file('photos/no.mp4');
        await f.file('videos/remote.mp4', { channel: 'S3' });
        await f.file('videos/not-media.txt', { type: 'text/plain' });
        await f.file('videos/new-object.mp4', { mtime: f.clock });
        await f.file('videos/boundary.mp4', { timestamp: Date.parse('2026-10-22T12:00:00Z') });
        const preview = await service.preview();
        assert.equal((await service.getStatus()).config.enabled, false);
        assert.equal(preview.count, 3);
        assert.equal(preview.cutoff, '2026-10-22T12:00:00.000Z');
        assert.deepEqual(preview.samples.map(item => item.key).sort(), ['videos/nested/photo.png', 'videos/old.mp4', 'videos/sound.mp3']);
        assert.equal(f.database.prepare('SELECT COUNT(*) n FROM files').get().n, 9);
        assert.equal(f.exists('videos/old.mp4'), true);
    });

    it('requires a current preview and confirmation, and invalidates previews when settings change', async () => {
        const service = await f.service();
        const preview = await service.preview();
        await assert.rejects(() => service.startManual({ previewToken: preview.previewToken }), { code: 'confirmation_required' });
        await service.saveConfig({ enabled: false, retentionDays: 8, runAt: '04:30' });
        await assert.rejects(() => service.startManual({ previewToken: preview.previewToken, confirmation: 'DELETE_EXPIRED_FILES' }), { code: 'preview_expired' });
        for (const input of [{ enabled: 'false', retentionDays: 7, runAt: '03:00' }, { enabled: false, retentionDays: 0, runAt: '03:00' }, { enabled: false, retentionDays: 7, runAt: '24:00' }]) {
            await assert.rejects(() => service.saveConfig(input), { code: 'invalid_config' });
        }
    });

    it('deletes objects and metadata and only the exactly matching import replay record', async () => {
        const service = await f.service();
        await f.file('videos/old.mp4', { metadata: { ImportIdentity: 'matching' } });
        await f.file('videos/other.mp4', { metadata: { ImportIdentity: 'mismatched' } });
        const insert = f.database.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
        insert.run('manage@import@matching', JSON.stringify({ result: { src: '/file/videos/old.mp4' } }));
        insert.run('manage@import@mismatched', JSON.stringify({ result: { src: '/file/videos/new.mp4' } }));
        const run = await finish(service, (await runPreview(service)).id);
        assert.equal(run.status, 'completed');
        assert.equal(run.deleted, 2);
        assert.equal(run.freedBytes, 18);
        assert.equal(f.exists('videos/old.mp4'), false);
        assert.equal(f.record('videos/old.mp4'), undefined);
        assert.equal(f.database.prepare('SELECT value FROM settings WHERE key=?').get('manage@import@matching'), undefined);
        assert.ok(f.database.prepare('SELECT value FROM settings WHERE key=?').get('manage@import@mismatched'));
    });

    it('preserves a replacement object and changed metadata after preview', async () => {
        const service = await f.service();
        await f.file('videos/replaced.mp4');
        await f.file('videos/metadata.mp4');
        const preview = await service.preview();
        await f.storage.put('videos/replaced.mp4', 'new bytes');
        f.database.prepare('UPDATE files SET metadata=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(f.record('videos/metadata.mp4').metadata), Tags: ['keep'] }), 'videos/metadata.mp4');
        const run = await finish(service, (await service.startManual({ previewToken: preview.previewToken, confirmation: 'DELETE_EXPIRED_FILES' })).id);
        assert.equal(run.deleted, 0);
        assert.equal(run.skipped, 2);
        assert.equal(fs.readFileSync(path.join(f.root, 'r2/videos/replaced.mp4'), 'utf8'), 'new bytes');
        assert.ok(f.record('videos/metadata.mp4'));
    });

    it('recovers metadata finalization after object unlink succeeded and SQLite commit failed', async () => {
        let service = await f.service();
        await f.file('videos/recover.mp4');
        f.database.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'temporary database failure'); END");
        const run = await finish(service, (await runPreview(service)).id);
        assert.equal(run.status, 'partial');
        assert.equal(f.exists('videos/recover.mp4'), false);
        assert.ok(f.record('videos/recover.mp4'));
        await service.close();
        f.database.exec('DROP TRIGGER fail_cleanup');
        f.clock += 60000;
        service = await f.service();
        await service.start();
        const recovered = await finish(service, run.id);
        assert.equal(recovered.status, 'completed');
        assert.equal(f.record('videos/recover.mp4'), undefined);
        assert.equal(recovered.deleted, 1);
    });

    it('yields during preview and rejects its snapshot if configuration changes during scanning', async () => {
        const service = await f.service();
        for (let i = 0; i < 201; i++) await f.file(`videos/${i}.mp4`);
        let previewFinished = false;
        const pending = service.preview().then(value => { previewFinished = true; return value; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(previewFinished, false);
        await service.saveConfig({ enabled: false, retentionDays: 8, runAt: '03:00' });
        const preview = await pending;
        await assert.rejects(() => service.startManual({ previewToken: preview.previewToken, confirmation: 'DELETE_EXPIRED_FILES' }), { code: 'preview_expired' });
    });

    it('defers missing-object recovery while a replacement upload is active', async () => {
        let service = await f.service();
        await f.file('videos/recover.mp4');
        f.database.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'temporary failure'); END");
        const run = await finish(service, (await runPreview(service)).id);
        await service.close();
        f.database.exec('DROP TRIGGER fail_cleanup');
        f.clock += 60000;
        let controller;
        const stream = new ReadableStream({ start(value) { controller = value; } });
        const writing = f.storage.put('videos/recover.mp4', stream);
        service = await f.service();
        try {
            await service.start();
            await finish(service, run.id);
            assert.ok(f.record('videos/recover.mp4'));
        } finally { controller.close(); await writing; }
    });

    it('does not retain in-memory counters when the final run write rolls back deletion', async () => {
        let service = await f.service();
        await f.file('videos/counter.mp4');
        let rejectOnce = true;
        f.database.function('reject_final_run_once', payload => {
            if (rejectOnce && JSON.parse(payload).deleted === 1) {
                rejectOnce = false;
                throw new Error('Simulated final run write failure');
            }
            return 1;
        });
        f.database.exec('CREATE TRIGGER reject_final_run BEFORE UPDATE ON retention_runs BEGIN SELECT reject_final_run_once(NEW.payload); END');
        const run = await finish(service, (await runPreview(service)).id);
        assert.equal(run.status, 'partial');
        assert.equal(run.deleted, 0);
        assert.equal(run.freedBytes, 0);
        assert.ok(f.record('videos/counter.mp4'));
        assert.equal(f.exists('videos/counter.mp4'), false);
        await service.close();
        f.database.exec('DROP TRIGGER reject_final_run');
        f.clock += 60000;
        service = await f.service();
        await service.start();
        const recovered = await finish(service, run.id);
        assert.equal(recovered.deleted, 1);
        assert.equal(recovered.freedBytes, 9);
    });

    it('records a safe storage or SQLite error code without exposing its raw message', async () => {
        const service = await f.service();
        await f.file('videos/full.mp4');
        f.database.function('simulate_full', () => { throw Object.assign(new Error('Secret path /private/database.sqlite is full'), { code: 'SQLITE_FULL' }); });
        f.database.exec('CREATE TRIGGER fail_cleanup BEFORE DELETE ON files BEGIN SELECT simulate_full(); END');
        const run = await finish(service, (await runPreview(service)).id);
        assert.equal(run.status, 'partial');
        assert.equal(run.failures[0].reason, 'SQLITE_FULL');
        assert.equal(JSON.stringify(run).includes('/private/'), false);
    });

    it('keeps the web process alive when run-state writes and lease release both fail', async function () {
        this.timeout(10000);
        const { execFile } = require('node:child_process');
        const { promisify } = require('node:util');
        const script = `
            const assert = require('node:assert/strict');
            const http = require('node:http');
            const { fixture, finish, runPreview } = require('./test/retention-fixture.cjs');
            (async () => {
                const f = await fixture();
                const server = http.createServer((request, response) => response.end('alive'));
                await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
                try {
                    let service = await f.service();
                    await f.file('videos/journal.mp4');
                    const run = await runPreview(service);
                    f.database.exec("CREATE TRIGGER fail_run_state BEFORE UPDATE ON retention_runs BEGIN SELECT RAISE(ABORT, 'secret run path'); END");
                    f.database.exec("CREATE TRIGGER fail_release BEFORE UPDATE OF owner ON retention_lease WHEN NEW.owner IS NULL BEGIN SELECT RAISE(ABORT, 'secret lease path'); END");
                    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
                    assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), 'alive');
                    await service.close();
                    assert.ok(f.record('videos/journal.mp4'));
                    f.database.exec('DROP TRIGGER fail_run_state; DROP TRIGGER fail_release');
                    f.clock += 61000;
                    service = await f.service();
                    await service.start();
                    assert.equal((await finish(service, run.id)).status, 'completed');
                    console.log('worker-failure-contained');
                } finally {
                    await f.cleanup();
                    await new Promise(resolve => server.close(resolve));
                }
            })().catch(error => { console.error(error); process.exitCode = 1; });
        `;
        const result = await promisify(execFile)(process.execPath, ['--unhandled-rejections=strict', '-e', script], { cwd: path.join(__dirname, '..'), timeout: 8000 });
        assert.match(result.stdout, /worker-failure-contained/);
        assert.doesNotMatch(result.stderr, /secret (run|lease) path/);
    });
});
