'use strict';
const assert = require('node:assert/strict');
const { fixture, finish, runPreview } = require('./retention-fixture.cjs');

describe('Local retention schedule and lease', function () {
    let f;
    beforeEach(async () => { f = await fixture(); });
    afterEach(async () => { await f.cleanup(); });
    it('schedules the next Shanghai slot, runs one catch-up after restart and advances beyond now', async () => {
        let service = await f.service();
        await f.file('videos/old.mp4');
        const saved = await service.saveConfig({ enabled: true, retentionDays: 7, runAt: '03:00' });
        assert.equal(saved.nextRunAt, '2026-10-29T19:00:00.000Z');
        assert.equal(f.exists('videos/old.mp4'), true);
        await service.close();
        f.clock = Date.parse('2026-11-01T22:00:00Z');
        service = await f.service();
        await service.start();
        let status = await service.getStatus();
        const run = status.activeRun || status.recentRuns[0];
        assert.equal(run.trigger, 'scheduled');
        await finish(service, run.id);
        status = await service.getStatus();
        assert.equal(status.nextRunAt, '2026-11-02T19:00:00.000Z');
        assert.equal(status.recentRuns.length, 1);
    });
    it('allows only one manual or scheduled execution across independent service instances', async () => {
        const first = await f.service();
        const second = await f.service();
        for (let i = 0; i < 5; i++) await f.file(`videos/${i}.mp4`);
        const preview = await second.preview();
        const run = await runPreview(first);
        await assert.rejects(() => second.startManual({ previewToken: preview.previewToken, confirmation: 'DELETE_EXPIRED_FILES' }), { code: 'run_active' });
        assert.equal((await finish(first, run.id)).deleted, 5);
    });
    it('preserves interrupted work on shutdown and resumes its fixed candidate snapshot', async () => {
        let service = await f.service();
        for (let i = 0; i < 4; i++) await f.file(`videos/${i}.mp4`);
        const run = await runPreview(service);
        await service.close();
        assert.equal((await service.getRun(run.id)).status, 'interrupted');
        await f.file('videos/after-preview.mp4');
        service = await f.service();
        await service.start();
        assert.equal((await finish(service, run.id)).deleted, 4);
        assert.equal(f.exists('videos/after-preview.mp4'), true);
    });

    it('fences an expired owner when a separate SQLite connection recovers the same run', async () => {
        const path = require('node:path');
        const { SqliteD1 } = await import('../deploy/server/sqliteD1.js');
        const first = await f.service();
        await f.file('videos/old.mp4');
        const run = await runPreview(first);
        f.clock += 61000;
        const binding = new SqliteD1(path.join(f.root, 'database.sqlite'));
        const second = await f.service({ database: binding.db });
        try {
            await second.start();
            const completed = await finish(second, run.id);
            assert.equal(completed.status, 'completed');
            assert.equal(completed.deleted, 1);
            assert.equal((await second.getStatus()).recentRuns.length, 1);
        } finally { await second.close(); binding.db.close(); }
    });

    it('finishes a run interrupted after the final item committed but before run completion', async () => {
        let service = await f.service();
        await f.file('videos/old.mp4');
        const run = await finish(service, (await runPreview(service)).id);
        await service.close();
        run.status = 'running'; run.finishedAt = null;
        f.database.prepare('UPDATE retention_runs SET payload=? WHERE id=?').run(JSON.stringify(run), run.id);
        service = await f.service();
        await service.start();
        assert.equal((await finish(service, run.id)).status, 'completed');
        assert.equal((await service.getStatus()).activeRun, null);
    });

    it('backs off a failed deletion journal across restarts instead of retrying continuously', async () => {
        let service = await f.service();
        await f.file('videos/failing.mp4');
        f.database.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'temporary failure'); END");
        const run = await finish(service, (await runPreview(service)).id);
        assert.equal(run.status, 'partial');
        await service.close();
        f.database.exec('DROP TRIGGER fail_cleanup');
        service = await f.service();
        await service.start();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal((await service.getRun(run.id)).status, 'partial');
        assert.ok(f.record('videos/failing.mp4'));
        await service.close();
        f.clock += 60000;
        service = await f.service();
        await service.start();
        assert.equal((await finish(service, run.id)).status, 'completed');
    });

    it('runs the due daily snapshot even while an older deletion journal keeps failing', async () => {
        let service = await f.service();
        await service.saveConfig({ enabled: true, retentionDays: 7, runAt: '03:00' });
        await f.file('videos/failing.mp4');
        f.database.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON files WHEN OLD.id='videos/failing.mp4' BEGIN SELECT RAISE(ABORT, 'persistent failure'); END");
        const oldRun = await finish(service, (await runPreview(service)).id);
        assert.equal(oldRun.status, 'partial');
        await service.close();
        await f.file('videos/other.mp4');
        f.clock = Date.parse('2026-10-29T19:00:01Z');
        service = await f.service();
        await service.start();
        const status = await service.getStatus();
        const current = status.activeRun || status.recentRuns[0];
        assert.equal(current.trigger, 'scheduled');
        assert.equal((await finish(service, current.id)).deleted, 1);
        assert.equal(f.exists('videos/other.mp4'), false);
        assert.ok(f.record('videos/failing.mp4'));
        assert.equal((await service.getRun(oldRun.id)).status, 'partial');
    });
});
