const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./retention-fixture.cjs');

describe('Image compression through real upload handlers and local storage', function () {
    this.timeout(30000);
    let upload, importer, sharp, engine, input;
    before(async () => {
        ({ onRequest: upload } = await import('../functions/upload/index.js'));
        ({ onRequest: importer } = await import('../functions/api/import-url.js'));
        ({ default: sharp } = await import('sharp'));
        ({ dockerUploadImageCompressor: engine } = await import('../deploy/server/uploadImageCompressor.js'));
        const pixels = Buffer.alloc(1600 * 1200 * 3);
        let seed = 243;
        for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
        input = await sharp(pixels, { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
        assert.ok(input.length > 1024 * 1024);
    });
    let f, env, background;
    beforeEach(async () => {
        f = await fixture(); background = [];
        env = { img_d1: f.binding, img_r2: f.storage, UPLOAD_IMAGE_COMPRESSOR: engine, dev_mode: 'true',
            IMPORT_SOURCE_FETCH: async () => new Response(input, { headers: { 'content-type': 'image/jpeg', 'content-length': String(input.length) } }) };
        f.database.prepare('INSERT INTO settings(key,value,category) VALUES(?,?,?)').run('manage@sysConfig@upload', JSON.stringify({
            imageCompression: { enabled: true, thresholdMB: 1, targetMB: 0.5 },
        }), 'sysConfig');
    });
    afterEach(async () => { await Promise.allSettled(background); await f.cleanup(); });
    function context(request) { return { env, request, waitUntil(p) { background.push(p); } }; }
    async function check(response, compressed = true) {
        assert.equal(response.status, 200, response.status === 200 ? '' : await response.text());
        const output = (await response.json())[0];
        const key = output.src.slice(6);
        const bytes = fs.readFileSync(path.join(f.root, 'r2', key));
        const metadata = JSON.parse(f.record(key).metadata);
        if (compressed) {
            assert.ok(bytes.length <= 0.5 * 1024 * 1024, `stored ${bytes.length}`);
            assert.equal(metadata.ImageCompression.originalBytes, input.length);
            const decoded = await sharp(bytes).metadata();
            assert.equal(decoded.format, 'jpeg');
            assert.equal(metadata.Width, decoded.width);
            assert.equal(metadata.Height, decoded.height);
        } else assert.equal(bytes.equals(input), true);
        assert.equal(metadata.FileSizeBytes, bytes.length);
        return { bytes, metadata };
    }
    it('compresses ordinary multipart/form-data uploads before persistence', async () => {
        const body = new FormData(); body.set('file', new Blob([input], { type: 'image/jpeg' }), 'photo.jpg');
        await check(await upload(context(new Request('https://imgbed.test/upload?uploadChannel=cfr2', { method: 'POST', body }))));
    });
    it('leaves ordinary uploads byte-identical after the admin disables compression', async () => {
        f.database.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify({ imageCompression: { enabled: false, thresholdMB: 1, targetMB: 0.5 } }), 'manage@sysConfig@upload');
        const body = new FormData(); body.set('file', new Blob([input], { type: 'image/jpeg' }), 'photo.jpg');
        await check(await upload(context(new Request('https://imgbed.test/upload?uploadChannel=cfr2', { method: 'POST', body }))), false);
    });
    it('compresses URL imports with the same policy and returns the original public API response shape', async () => {
        const request = new Request('https://imgbed.test/api/import-url', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://media.example/photo.jpg', mediaType: 'image', idempotencyKey: 'native-photo' }) });
        await check(await importer(context(request)));
    });
    it('compresses a completed R2 multipart image before publishing its file record', async () => {
        const init = new FormData();
        init.set('originalFileName', 'chunked.jpg'); init.set('originalFileType', 'image/jpeg'); init.set('totalChunks', '1');
        const opened = await upload(context(new Request('https://imgbed.test/upload?uploadChannel=cfr2&initChunked=true', { method: 'POST', body: init })));
        assert.equal(opened.status, 200);
        const { uploadId } = await opened.json();
        const part = new FormData();
        part.set('file', new Blob([input], { type: 'image/jpeg' }), 'chunk');
        for (const [k,v] of Object.entries({ uploadId, chunkIndex: '0', totalChunks: '1', originalFileName: 'chunked.jpg', originalFileType: 'image/jpeg' })) part.set(k,v);
        const sent = await upload(context(new Request('https://imgbed.test/upload?uploadChannel=cfr2&chunked=true', { method: 'POST', body: part })));
        assert.equal(sent.status, 200);
        const merge = new FormData();
        for (const [k,v] of Object.entries({ uploadId, totalChunks: '1', originalFileName: 'chunked.jpg', originalFileType: 'image/jpeg' })) merge.set(k,v);
        await check(await upload(context(new Request('https://imgbed.test/upload?uploadChannel=cfr2&chunked=true&merge=true', { method: 'POST', body: merge }))));
    });
});
