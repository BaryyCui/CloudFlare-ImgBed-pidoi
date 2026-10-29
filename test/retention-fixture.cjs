'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

async function fixture() {
    const { SqliteD1 } = await import('../deploy/server/sqliteD1.js');
    const { LocalR2Storage } = await import('../deploy/server/r2Storage.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imgbed-retention-'));
    const binding = new SqliteD1(path.join(root, 'database.sqlite'));
    binding.exec(fs.readFileSync(path.join(__dirname, '../database/init.sql'), 'utf8'));
    const database = binding.db;
    const storage = new LocalR2Storage(path.join(root, 'r2'));
    let clock = Date.parse('2026-10-29T12:00:00Z');
    const services = [];
    return {
        root, binding, database, storage,
        get clock() { return clock; }, set clock(value) { clock = value; },
        async service(options = {}) {
            const { createRetentionService } = await import('../deploy/server/retention/index.js');
            const service = createRetentionService({ database, storage, dataDir: root, now: () => clock, ...options });
            services.push(service); return service;
        },
        async file(key, options = {}) {
            const timestamp = options.timestamp ?? Date.parse('2026-10-20T12:00:00Z');
            const metadata = { TimeStamp: timestamp, FileType: options.type || 'video/mp4', Channel: options.channel || 'CloudflareR2', FileSize: '0.01', ...options.metadata };
            await storage.put(key, options.body || 'old bytes');
            const mtime = new Date(options.mtime ?? timestamp);
            fs.utimesSync(path.join(root, 'r2', key), mtime, mtime);
            database.prepare('INSERT OR REPLACE INTO files(id,value,metadata,timestamp,channel,file_type) VALUES(?,?,?,?,?,?)').run(key, '', JSON.stringify(metadata), timestamp, metadata.Channel, metadata.FileType);
            return metadata;
        },
        exists(key) { return fs.existsSync(path.join(root, 'r2', key)); },
        record(key) { return database.prepare('SELECT * FROM files WHERE id=?').get(key); },
        async cleanup() { for (const service of services) await service.close(); database.close(); fs.rmSync(root, { recursive: true, force: true }); },
    };
}

async function finish(service, id) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const run = await service.getRun(id);
        if (run.status !== 'running') return run;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('retention did not finish');
}
async function runPreview(service) {
    const preview = await service.preview();
    return service.startManual({ previewToken: preview.previewToken, confirmation: 'DELETE_EXPIRED_FILES' });
}
module.exports = { fixture, finish, runPreview };
