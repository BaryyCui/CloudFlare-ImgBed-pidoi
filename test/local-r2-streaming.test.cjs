'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await delay(5);
    }
    assert.fail('stream did not write any bytes before its input finished');
}

function streamBytes(byte, chunks = 128) {
    let remaining = chunks;
    return new ReadableStream({
        pull(controller) {
            if (remaining-- > 0) controller.enqueue(new Uint8Array(65536).fill(byte));
            else controller.close();
        },
    });
}

async function digest(body) {
    const hash = createHash('sha256');
    for await (const chunk of body) hash.update(chunk);
    return hash.digest('hex');
}

describe('LocalR2Storage streaming and atomic publication', function () {
    this.timeout(10000);
    let root;
    let base;
    let storage;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-r2-test-'));
        base = path.join(root, 'objects');
        const { LocalR2Storage } = await import('../deploy/server/r2Storage.js');
        storage = new LocalR2Storage(base);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it('writes an unfinished source to disk without publishing a partial object', async () => {
        let controller;
        const source = new ReadableStream({ start(value) { controller = value; } });
        const writing = storage.put('video.bin', source);
        controller.enqueue(new Uint8Array(1024 * 1024).fill(23));
        try {
            await waitFor(() => fs.readdirSync(base).some((file) => fs.statSync(path.join(base, file)).size > 0));
            assert.equal(await storage.get('video.bin'), null);
        } finally {
            controller.close();
            await writing;
        }
        assert.equal((await storage.get('video.bin')).size, 1024 * 1024);
        assert.deepEqual(fs.readdirSync(base), ['video.bin']);
    });

    it('preserves the previous object and cleans temporary files when a source fails', async () => {
        await storage.put('asset', 'previous bytes');
        let controller;
        const source = new ReadableStream({ start(value) { controller = value; } });
        const writing = storage.put('asset', source);
        const rejected = assert.rejects(writing, /source failed/);
        controller.enqueue(new Uint8Array(65536));
        await delay(20);
        controller.error(new Error('source failed'));
        await rejected;
        assert.equal(await new Response((await storage.get('asset')).body).text(), 'previous bytes');
        assert.deepEqual(fs.readdirSync(base), ['asset']);
    });

    it('cancels an unfinished source and removes its temporary file on abort', async () => {
        const abort = new AbortController();
        let controller;
        let canceled = false;
        const source = new ReadableStream({
            start(value) { controller = value; },
            cancel() { canceled = true; },
        });
        const writing = storage.put('asset', source, { signal: abort.signal });
        const outcome = writing.then(() => 'completed', (error) => error.name);
        controller.enqueue(new Uint8Array(65536));
        abort.abort();
        try {
            assert.equal(await Promise.race([outcome, delay(500).then(() => 'hung')]), 'AbortError');
            assert.equal(canceled, true);
            assert.deepEqual(fs.readdirSync(base), []);
        } finally {
            if (!canceled) controller.close();
            await outcome;
        }
    });

    it('cleans temporary files when the destination cannot be replaced', async () => {
        fs.mkdirSync(path.join(base, 'directory'));
        await assert.rejects(storage.put('directory', streamBytes(3, 8)));
        assert.deepEqual(fs.readdirSync(base), ['directory']);
        assert.equal(fs.statSync(path.join(base, 'directory')).isDirectory(), true);
    });

    it('stores Blob, ArrayBuffer and sliced Uint8Array without including unrelated bytes', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        for (const [key, value, expected] of [
            ['blob', new Blob(['blob bytes']), Buffer.from('blob bytes')],
            ['array', bytes.buffer, Buffer.from([1, 2, 3, 4])],
            ['slice', bytes.subarray(1, 3), Buffer.from([2, 3])],
        ]) {
            await storage.put(key, value);
            assert.deepEqual(Buffer.from(await new Response((await storage.get(key)).body).arrayBuffer()), expected);
        }
        await storage.delete('slice');
        assert.equal(await storage.get('slice'), null);
    });

    it('rejects object paths that escape or address the multipart namespace', async () => {
        const sentinel = path.join(root, 'outside');
        fs.writeFileSync(sentinel, 'keep');
        for (const key of ['../outside', 'nested/../../outside', '/outside', '..\\outside', '_multipart/other', '']) {
            await assert.rejects(storage.put(key, 'overwrite'), /key|path/i);
            await assert.rejects(storage.get(key), /key|path/i);
            await assert.rejects(storage.delete(key), /key|path/i);
        }
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    });

    it('rejects symlink object paths before reading, writing or deleting outside the bucket', async () => {
        fs.writeFileSync(path.join(root, 'outside'), 'keep');
        fs.symlinkSync(root, path.join(base, 'link'));
        await assert.rejects(storage.put('link/outside', 'overwrite'), /path|link/i);
        await assert.rejects(storage.get('link/outside'), /path|link/i);
        await assert.rejects(storage.delete('link/outside'), /path|link/i);
        assert.equal(fs.readFileSync(path.join(root, 'outside'), 'utf8'), 'keep');
    });

    it('streams large multipart inputs and joins them in order without mutating the manifest', async () => {
        const upload = await storage.createMultipartUpload('nested/video.bin');
        let controller;
        const source = new ReadableStream({ start(value) { controller = value; } });
        const writing = upload.uploadPart(1, source);
        controller.enqueue(new Uint8Array(1024 * 1024).fill(11));
        const uploadDir = path.join(base, '_multipart', upload.uploadId);
        try {
            await waitFor(() => fs.readdirSync(uploadDir).some((file) => file !== '_key' && fs.statSync(path.join(uploadDir, file)).size > 0));
        } finally {
            controller.close();
        }
        const first = await writing;
        const second = await upload.uploadPart(2, streamBytes(29, 192));
        const third = await upload.uploadPart(3, new Blob(['tail']));
        const manifest = [third, first, second];
        await storage.resumeMultipartUpload('nested/video.bin', upload.uploadId).complete(manifest);
        assert.deepEqual(manifest.map((part) => part.partNumber), [3, 1, 2]);
        const result = await storage.get('nested/video.bin');
        assert.equal(result.size, 13 * 1024 * 1024 + 4);
        const expected = createHash('sha256');
        expected.update(new Uint8Array(1024 * 1024).fill(11));
        for (let i = 0; i < 192; i++) expected.update(new Uint8Array(65536).fill(29));
        expected.update('tail');
        assert.equal(await digest(result.body), expected.digest('hex'));
        assert.equal(fs.existsSync(uploadDir), false);
    });

    it('rejects missing, duplicate and mismatched multipart entries without replacing the object', async () => {
        await storage.put('asset', 'old');
        const upload = await storage.createMultipartUpload('asset');
        const first = await upload.uploadPart(1, new Blob(['first']));
        for (const manifest of [
            [first, { partNumber: 2, etag: 'missing' }],
            [first, first],
            [{ ...first, etag: 'wrong' }],
            [],
        ]) {
            await assert.rejects(upload.complete(manifest), /part|etag/i);
            assert.equal(await new Response((await storage.get('asset')).body).text(), 'old');
            assert.deepEqual(fs.readdirSync(base).sort(), ['_multipart', 'asset']);
        }
        await upload.abort();
        assert.deepEqual(fs.readdirSync(path.join(base, '_multipart')), []);
    });

    it('rejects stale part etags after an uploaded part is replaced', async () => {
        const upload = await storage.createMultipartUpload('asset');
        const stale = await upload.uploadPart(1, new Blob(['first']));
        const current = await upload.uploadPart(1, new Blob(['replacement']));
        await assert.rejects(upload.complete([stale]), /etag/i);
        assert.equal(await storage.get('asset'), null);
        await upload.complete([current]);
        assert.equal(await new Response((await storage.get('asset')).body).text(), 'replacement');
    });

    it('aborts an active multipart stream and removes all uploaded parts', async () => {
        const upload = await storage.createMultipartUpload('asset');
        await upload.uploadPart(1, new Blob(['finished part']));
        let controller;
        let canceled = false;
        const source = new ReadableStream({
            start(value) { controller = value; },
            cancel() { canceled = true; },
        });
        const writing = upload.uploadPart(2, source);
        const rejected = assert.rejects(writing, { name: 'AbortError' });
        controller.enqueue(new Uint8Array(65536));
        await upload.abort();
        await rejected;
        assert.equal(canceled, true);
        assert.deepEqual(fs.readdirSync(path.join(base, '_multipart')), []);
        assert.equal(await storage.get('asset'), null);
    });

    it('does not replace a completed part when its replacement stream fails', async () => {
        const upload = await storage.createMultipartUpload('asset');
        const first = await upload.uploadPart(1, new Blob(['original part']));
        let controller;
        const source = new ReadableStream({ start(value) { controller = value; } });
        const writing = upload.uploadPart(1, source);
        const rejected = assert.rejects(writing, /source failed/);
        controller.enqueue(new Uint8Array(65536));
        await delay(20);
        controller.error(new Error('source failed'));
        await rejected;
        await upload.complete([first]);
        assert.equal(await new Response((await storage.get('asset')).body).text(), 'original part');
    });

    it('binds resumed uploads to their original key and validates upload ids and part numbers', async () => {
        const upload = await storage.createMultipartUpload('asset');
        await assert.rejects(async () => storage.resumeMultipartUpload('different', upload.uploadId).uploadPart(1, new Blob(['bad'])), /key|upload/i);
        await assert.rejects(async () => storage.resumeMultipartUpload('asset', '../outside').abort(), /upload|path/i);
        for (const number of [0, -1, 1.5, 10001, '../outside']) {
            await assert.rejects(upload.uploadPart(number, new Blob(['bad'])), /part/i);
        }
        await upload.abort();
        await assert.rejects(upload.uploadPart(1, new Blob(['bad'])), /upload/i);
    });

    it('completes persisted legacy multipart manifests using only their exact etag_N values', async () => {
        const uploadId = randomUUID();
        const uploadDir = path.join(base, '_multipart', uploadId);
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(path.join(uploadDir, '_key'), 'legacy/asset');
        fs.writeFileSync(path.join(uploadDir, 'part_000001'), 'old first');
        fs.writeFileSync(path.join(uploadDir, 'part_000002'), ' then second');
        const upload = storage.resumeMultipartUpload('legacy/asset', uploadId);
        for (const etag of ['etag_01', 'etag_2', 'etag_1_suffix']) {
            await assert.rejects(upload.complete([{ partNumber: 1, etag }]), /etag/i);
        }
        await upload.complete([{ partNumber: 1, etag: 'etag_1' }, { partNumber: 2, etag: 'etag_2' }]);
        assert.equal(await new Response((await storage.get('legacy/asset')).body).text(), 'old first then second');
        assert.equal(fs.existsSync(uploadDir), false);
    });
});
