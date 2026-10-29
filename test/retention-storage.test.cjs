'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('LocalR2Storage retention object guards', function () {
    this.timeout(10000);
    let root;
    let base;
    let storage;
    let LocalR2Storage;
    const key = 'videos/expired.bin';

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-storage-'));
        base = path.join(root, 'objects');
        ({ LocalR2Storage } = await import('../deploy/server/r2Storage.js'));
        storage = new LocalR2Storage(base);
        await storage.put(key, 'expired bytes');
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('inspects the real object version and deletes it synchronously after the final guard', () => {
        const inspected = storage.inspectForRetention(key);
        const stat = fs.statSync(path.join(base, key));
        assert.equal(inspected.exists, true);
        assert.equal(inspected.safe, true);
        assert.equal(inspected.active, false);
        assert.equal(inspected.size, 13);
        assert.equal(inspected.mtimeMs, stat.mtimeMs);
        assert.deepEqual(inspected.identity, {
            dev: stat.dev, ino: stat.ino, size: 13,
            mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
        });
        let checked = false;
        const outcome = storage.deleteForRetention(key, inspected.identity, () => {
            assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'expired bytes');
            checked = true;
        });
        assert.deepEqual(outcome, { deleted: true, reason: 'deleted' });
        assert.equal(checked, true);
        assert.equal(fs.existsSync(path.join(base, key)), false);
        assert.deepEqual(storage.deleteForRetention(key, inspected.identity), { deleted: false, reason: 'missing' });
        const missing = storage.inspectForRetention(key);
        assert.equal(missing.exists, false);
        assert.equal(missing.safe, true);
        assert.equal(missing.identity, null);
    });

    it('preserves an object replaced after inspection even when its size and mtime match', async () => {
        const before = storage.inspectForRetention(key);
        await storage.put(key, 'current bytes');
        fs.utimesSync(path.join(base, key), before.mtimeMs / 1000, before.mtimeMs / 1000);
        assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: false, reason: 'changed' });
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'current bytes');
    });

    it('preserves an object modified in place after inspection', () => {
        const before = storage.inspectForRetention(key);
        fs.appendFileSync(path.join(base, key), ' updated');
        assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: false, reason: 'changed' });
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'expired bytes updated');
    });

    it('skips active puts until the complete replacement is published', async () => {
        const before = storage.inspectForRetention(key);
        let controller;
        const source = new ReadableStream({ start(value) { controller = value; } });
        const writing = storage.put(key, source);
        try {
            controller.enqueue(new TextEncoder().encode('new bytes'));
            assert.equal(storage.inspectForRetention(key).active, true);
            assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: false, reason: 'active' });
            assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'expired bytes');
        } finally {
            controller.close();
            await writing;
        }
        assert.equal(storage.inspectForRetention(key).active, false);
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'new bytes');
        assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: false, reason: 'changed' });
    });

    it('shares active write protection with another adapter for the same bucket', async () => {
        const other = new LocalR2Storage(base);
        const before = storage.inspectForRetention(key);
        let controller;
        const writing = other.put(key, new ReadableStream({ start(value) { controller = value; } }));
        try {
            assert.equal(storage.inspectForRetention(key).active, true);
            assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: false, reason: 'active' });
        } finally {
            controller.close();
            await writing;
        }
    });

    it('releases active write protection after a failed stream', async () => {
        const before = storage.inspectForRetention(key);
        const writing = storage.put(key, new ReadableStream({
            start(controller) { controller.error(new Error('source failed')); },
        }));
        await assert.rejects(writing, /source failed/);
        assert.equal(storage.inspectForRetention(key).active, false);
        assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: true, reason: 'deleted' });
    });

    it('recognizes persisted multipart sessions after creating a new adapter', async () => {
        const before = storage.inspectForRetention(key);
        const upload = await storage.createMultipartUpload(key);
        const other = new LocalR2Storage(base);
        assert.equal(other.inspectForRetention(key).active, true);
        assert.deepEqual(other.deleteForRetention(key, before.identity), { deleted: false, reason: 'active' });
        const part = await upload.uploadPart(1, 'completed bytes');
        const completing = upload.complete([part]);
        assert.equal(other.inspectForRetention(key).active, true);
        await completing;
        assert.equal(other.inspectForRetention(key).active, false);
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'completed bytes');
        assert.deepEqual(other.deleteForRetention(key, before.identity), { deleted: false, reason: 'changed' });
    });

    it('releases the persisted multipart guard on abort without blocking unrelated objects', async () => {
        const before = storage.inspectForRetention(key);
        const unrelated = await storage.createMultipartUpload('videos/unrelated.bin');
        assert.equal(storage.inspectForRetention(key).active, false);
        const upload = await storage.createMultipartUpload(key);
        assert.equal(storage.inspectForRetention(key).active, true);
        await upload.abort();
        assert.deepEqual(storage.deleteForRetention(key, before.identity), { deleted: true, reason: 'deleted' });
        await unrelated.abort();
    });

    it('skips symlinks, directory objects, temporary objects and unsafe keys', () => {
        const outside = path.join(root, 'outside');
        fs.writeFileSync(outside, 'keep outside');
        fs.symlinkSync(outside, path.join(base, 'videos/link'));
        fs.symlinkSync(root, path.join(base, 'linked-directory'));
        fs.mkdirSync(path.join(base, 'videos/directory'));
        fs.writeFileSync(path.join(base, 'videos/.r2-active.tmp'), 'keep temporary');
        for (const unsafe of ['videos/link', 'linked-directory/outside', 'videos/directory', 'videos/.r2-active.tmp', '../outside', '_multipart/unknown', '']) {
            assert.equal(storage.inspectForRetention(unsafe).safe, false, unsafe);
            assert.deepEqual(storage.deleteForRetention(unsafe, {}), { deleted: false, reason: 'unsafe' }, unsafe);
        }
        assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
        assert.equal(fs.lstatSync(path.join(base, 'videos/link')).isSymbolicLink(), true);
    });

    it('does not unlink if the synchronous database guard fails or returns a promise', () => {
        const before = storage.inspectForRetention(key);
        assert.throws(() => storage.deleteForRetention(key, before.identity, () => {
            throw new Error('lease lost');
        }), /lease lost/);
        assert.throws(() => storage.deleteForRetention(key, before.identity, () => Promise.resolve()), /synchronous/i);
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'expired bytes');
    });

    it('rechecks the object if the final callback itself changes its identity', () => {
        const before = storage.inspectForRetention(key);
        const result = storage.deleteForRetention(key, before.identity, () => {
            fs.appendFileSync(path.join(base, key), ' changed by callback');
        });
        assert.deepEqual(result, { deleted: false, reason: 'changed' });
        assert.equal(fs.readFileSync(path.join(base, key), 'utf8'), 'expired bytes changed by callback');
    });
});
