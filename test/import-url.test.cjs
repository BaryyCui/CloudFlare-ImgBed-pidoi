'use strict';
const assert = require('assert');
const { loadImport, media } = require('./import-test-harness.cjs');
async function loadOnRequest(options) { return options; }
function videoFetch() {
    return new Response(media.video, { headers: { 'content-type': 'video/mp4', 'content-length': String(media.video.length) } });
}
async function invoke(options, origin) {
    const fixture = await loadImport(options);
    const response = await fixture.invoke({ url: 'https://example.com/video.mp4' }, { origin: `${origin}/api/import-url` });
    return { status: response.status, contentType: response.headers.get('Content-Type'), body: await response.json() };
}

describe('POST /api/import-url success public URL', () => {
    it('omits publicUrl when urlPrefix is missing from config', async () => {
        const onRequest = await loadOnRequest({ prefixConfig: [], fetchImpl: videoFetch });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.contentType, 'application/json');
        assert.deepStrictEqual(result.body, [{ src: '/file/videos/example.mp4' }]);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(result.body[0], 'publicUrl'), false);
    });

    it('omits publicUrl when urlPrefix.value is empty', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: '' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://proxy.example.net');
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.contentType, 'application/json');
        assert.deepStrictEqual(result.body, [{ src: '/file/videos/example.mp4' }]);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(result.body[0], 'publicUrl'), false);
    });

    it('builds publicUrl from a trailing-slash file prefix', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: 'https://cdn.example.com/file/' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.contentType, 'application/json');
        assert.deepStrictEqual(result.body, [{
            src: '/file/videos/example.mp4',
            publicUrl: 'https://cdn.example.com/file/videos/example.mp4',
        }]);
    });

    it('builds the same publicUrl when prefix has no trailing slash', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: 'https://cdn.example.com/file' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.deepStrictEqual(result.body, [{
            src: '/file/videos/example.mp4',
            publicUrl: 'https://cdn.example.com/file/videos/example.mp4',
        }]);
    });

    it('collapses multiple trailing slashes before the file id', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: 'https://cdn.example.com/file///' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.deepStrictEqual(result.body, [{
            src: '/file/videos/example.mp4',
            publicUrl: 'https://cdn.example.com/file/videos/example.mp4',
        }]);
    });

    it('keeps a custom prefix path and does not insert /file/', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: 'https://cdn.example.com/assets/' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.deepStrictEqual(result.body, [{
            src: '/file/videos/example.mp4',
            publicUrl: 'https://cdn.example.com/assets/videos/example.mp4',
        }]);
    });

    it('never infers publicUrl from request origin when prefix is absent', async () => {
        const onRequest = await loadOnRequest({ prefixConfig: [], fetchImpl: videoFetch });
        for (const origin of ['https://img.pidoi.com', 'http://127.0.0.1:7659', 'https://other.example']) {
            const result = await invoke(onRequest, origin);
            assert.deepStrictEqual(result.body, [{ src: '/file/videos/example.mp4' }]);
            assert.strictEqual(Object.prototype.hasOwnProperty.call(result.body[0], 'publicUrl'), false);
        }
    });

    it('uses configured prefix even when request origin differs', async () => {
        const onRequest = await loadOnRequest({
            prefixConfig: [{ id: 'urlPrefix', value: 'https://cdn.example.com/file/' }],
            fetchImpl: videoFetch,
        });
        const result = await invoke(onRequest, 'https://img.pidoi.com');
        assert.strictEqual(result.body[0].publicUrl, 'https://cdn.example.com/file/videos/example.mp4');
        assert.ok(!String(result.body[0].publicUrl).includes('img.pidoi.com'));
    });
});
