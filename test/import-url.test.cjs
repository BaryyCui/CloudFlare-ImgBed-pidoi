'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '../functions/api/import-url.js');

async function loadOnRequest({ prefixConfig, fetchImpl }) {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const context = vm.createContext({
        fetch: fetchImpl,
        URL,
        Headers,
        Response,
        console,
        JSON,
        Number,
        String,
        Date,
        Math,
        Object,
        Array,
        Error,
        TypeError,
        Boolean,
        Promise,
        Map,
        Set,
        Uint8Array,
        ArrayBuffer,
        undefined,
        parseInt,
        isNaN,
        Infinity,
    });

    function synthetic(identifier, exports) {
        const keys = Object.keys(exports);
        return new vm.SyntheticModule(keys, function init() {
            for (const key of keys) this.setExport(key, exports[key]);
        }, { context, identifier });
    }

    const linker = async (specifier) => {
        if (specifier.includes('userAuth')) {
            return synthetic(specifier, {
                userAuthCheck: async () => true,
                UnauthorizedResponse: (reason) => new Response(reason, { status: 401 }),
            });
        }
        if (specifier.includes('sysConfig')) {
            return synthetic(specifier, {
                fetchSecurityConfig: async () => ({}),
                fetchUploadConfig: async () => ({}),
                fetchPageConfig: async () => ({ config: prefixConfig }),
            });
        }
        if (specifier.includes('databaseAdapter')) {
            return synthetic(specifier, {
                getDatabase: () => ({ put: async () => {} }),
            });
        }
        if (specifier.includes('uploadTools')) {
            return synthetic(specifier, {
                buildUniqueFileId: async () => 'videos/example.mp4',
                createResponse: (body, options = {}) => new Response(body, options),
                endUpload: async () => {},
                sanitizeFileName: (name) => name,
                sanitizeUploadFolder: (folder) => folder,
            });
        }
        throw new Error(`unexpected import: ${specifier}`);
    };

    const module = new vm.SourceTextModule(source, {
        context,
        identifier: SOURCE_PATH,
    });
    await module.link(linker);
    await module.evaluate();
    return module.namespace.onRequest;
}

function videoFetch() {
    return new Response(Buffer.from('fake-mp4'), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '8' },
    });
}

async function invoke(onRequest, origin) {
    const request = new Request(`${origin}/api/import-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/video.mp4' }),
    });
    const response = await onRequest({
        request,
        env: {
            img_r2: { put: async () => {} },
        },
        waitUntil: () => {},
    });
    const text = await response.text();
    return {
        status: response.status,
        contentType: response.headers.get('Content-Type'),
        body: JSON.parse(text),
    };
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
