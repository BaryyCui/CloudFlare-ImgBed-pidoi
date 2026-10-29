'use strict';
const assert = require('node:assert/strict');
const { fixture, finish, runPreview } = require('./retention-fixture.cjs');

describe('Retention barriers against stale index and import replay', function () {
    let f;
    beforeEach(async () => { f = await fixture(); });
    afterEach(async () => { await f.cleanup(); });
    const save = (f, key, value) => f.database.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
    async function oldIndex(f, metadata) {
        save(f, 'manage@index@meta', { chunkCount: 1, chunkSize: 500, totalCount: 1, lastUpdated: Date.now(), lastOperationId: null, totalSizeMB: 0.01 });
        save(f, 'manage@index_0', [{ id: 'videos/old.mp4', metadata }]);
    }
    function context(f, service) {
        return { env: { img_d1: f.binding, RETENTION_SERVICE: service }, request: new Request('https://local.example/api/manage/list'), waitUntil: promise => promise.catch(() => {}) };
    }

    it('preserves cached quota metadata without reading chunks before any deletion barrier exists', async () => {
        const { getIndexMeta } = await import('../functions/utils/indexManager.js');
        const service = await f.service();
        save(f, 'manage@index@meta', { chunkCount: 2, totalCount: 12, totalSizeMB: 42, channelStats: { local: { fileCount: 12, usedMB: 42 } }, lastUpdated: 1 });
        // A metadata-only quota read remains usable independently of chunk reads.
        const stats = await getIndexMeta(context(f, service));
        assert.equal(stats.totalCount, 12);
        assert.equal(stats.totalSizeMB, 42);
        assert.deepEqual(stats.channelStats.local, { fileCount: 12, usedMB: 42 });
    });

    it('yields between authoritative query batches while preserving fresh metadata and dropping missing files', async () => {
        const service = await f.service();
        await f.file('videos/deleted.mp4');
        await finish(service, (await runPreview(service)).id);
        const cached = [];
        f.database.transaction(() => {
            const insert = f.database.prepare('INSERT INTO files(id,value,metadata) VALUES(?,?,?)');
            for (let i = 0; i < 1201; i++) {
                const id = `videos/current-${i}.mp4`;
                insert.run(id, '', JSON.stringify({ TimeStamp: f.clock + i, FileName: `current-${i}` }));
                cached.push({ id, metadata: { TimeStamp: 1, FileName: 'stale' } });
            }
        })();
        cached.push({ id: 'videos/ghost.mp4', metadata: { TimeStamp: 1 } });
        let finished = false;
        const pending = Promise.resolve(service.filterIndexFiles(cached)).then(result => { finished = true; return result; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished, false);
        const result = await pending;
        assert.equal(result.length, 1201);
        assert.equal(result[0].metadata.FileName, 'current-1200');
        assert.equal(result.some(file => file.id === 'videos/ghost.mp4'), false);
    });

    it('filters a stale writer snapshot and historical add, batch_add and move operations after deletion', async () => {
        const { readIndex, mergeOperationsToIndex } = await import('../functions/utils/indexManager.js');
        const service = await f.service();
        const metadata = await f.file('videos/old.mp4');
        await finish(service, (await runPreview(service)).id);
        await oldIndex(f, metadata);
        const ctx = context(f, service);
        assert.equal((await readIndex(ctx, { count: -1, includeSubdirFiles: true })).totalCount, 0);
        const insert = f.database.prepare('INSERT INTO index_operations(id,type,timestamp,data) VALUES(?,?,?,?)');
        insert.run('1_add', 'add', 1, JSON.stringify({ fileId: 'videos/old.mp4', metadata }));
        insert.run('2_batch', 'batch_add', 2, JSON.stringify({ files: [{ fileId: 'videos/old.mp4', metadata }] }));
        insert.run('3_move', 'move', 3, JSON.stringify({ originalFileId: 'videos/source.mp4', newFileId: 'videos/old.mp4', metadata }));
        await mergeOperationsToIndex(ctx);
        assert.equal((await readIndex(ctx, { count: -1, includeSubdirFiles: true })).files.length, 0);
    });

    it('shows a newly recreated file with current metadata despite an old tombstone and snapshot', async () => {
        const { readIndex } = await import('../functions/utils/indexManager.js');
        const service = await f.service();
        const metadata = await f.file('videos/old.mp4');
        await finish(service, (await runPreview(service)).id);
        await f.file('videos/old.mp4', { timestamp: f.clock, metadata: { FileName: 'replacement.mp4' } });
        await oldIndex(f, metadata);
        const result = await readIndex(context(f, service), { count: -1, includeSubdirFiles: true });
        assert.equal(result.files.length, 1);
        assert.equal(result.files[0].metadata.FileName, 'replacement.mp4');
        assert.equal(result.files[0].metadata.TimeStamp, f.clock);
    });

    it('keeps a new generation visible when a delayed old remove empties the saved snapshot', async () => {
        const { readIndex, getIndexMeta } = await import('../functions/utils/indexManager.js');
        const service = await f.service();
        const metadata = await f.file('videos/old.mp4');
        await finish(service, (await runPreview(service)).id);
        await f.file('videos/old.mp4', { timestamp: f.clock, metadata: { FileName: 'new.mp4', ChannelName: 'local' } });
        await oldIndex(f, metadata);
        f.database.prepare('INSERT INTO index_operations(id,type,timestamp,data) VALUES(?,?,?,?)').run('1_remove', 'remove', 1, JSON.stringify({ fileId: 'videos/old.mp4' }));
        const ctx = context(f, service);
        assert.equal((await readIndex(ctx, { count: -1, includeSubdirFiles: true })).files[0]?.metadata.FileName, 'new.mp4');
        const stats = await getIndexMeta(ctx);
        assert.equal(stats.totalCount, 1);
        assert.deepEqual(stats.channelStats.local, { fileCount: 1, usedMB: 0.01 });
    });

    it('does not replay a saved import response whose target has disappeared', async () => {
        const { loadImport } = require('./import-test-harness.cjs');
        const service = await f.service();
        const importer = await loadImport({ env: { RETENTION_SERVICE: service } });
        const request = { idempotencyKey: 'deleted-output', mediaType: 'video' };
        assert.equal((await importer.invoke(request)).status, 200);
        assert.equal((await importer.invoke(request)).status, 200);
        assert.equal(importer.calls.fetch.length, 2);
    });

    it('rejects a missing or mismatched replay target and accepts the matching live import', async () => {
        const service = await f.service();
        const previous = { result: { src: '/file/videos/old.mp4' } };
        assert.equal(await service.validateImportReplay('original', previous), false);
        await f.file('videos/old.mp4', { metadata: { ImportIdentity: 'different' } });
        assert.equal(await service.validateImportReplay('original', previous), false);
        await f.file('videos/old.mp4', { metadata: { ImportIdentity: 'original' } });
        assert.equal(await service.validateImportReplay('original', previous), true);
    });

    it('rejects ghosts renamed by delayed move and batch_move after an old add', async () => {
        const { readIndex } = await import('../functions/utils/indexManager.js');
        const service = await f.service();
        const metadata = await f.file('videos/old.mp4');
        await finish(service, (await runPreview(service)).id);
        await oldIndex(f, metadata);
        const insert = f.database.prepare('INSERT INTO index_operations(id,type,timestamp,data) VALUES(?,?,?,?)');
        insert.run('1_add', 'add', 1, JSON.stringify({ fileId: 'videos/old.mp4', metadata }));
        insert.run('2_move', 'move', 2, JSON.stringify({ originalFileId: 'videos/old.mp4', newFileId: 'videos/ghost.mp4', metadata }));
        insert.run('3_move', 'batch_move', 3, JSON.stringify({ operations: [{ originalFileId: 'videos/ghost.mp4', newFileId: 'videos/ghost2.mp4', metadata }] }));
        const result = await readIndex(context(f, service), { count: -1, includeSubdirFiles: true });
        assert.equal(result.files.length, 0);
    });
});
