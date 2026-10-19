'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');

// Execute the production writer inside workerd. The external R2 proxy cannot
// serialize AbortSignal arguments, which would hide the native API behavior.
const workerSource = `
import { createImportWriter, IMPORT_PART_BYTES } from './functions/utils/importStorage.js';
export default {
    async fetch(request, env) {
        const mode = new URL(request.url).pathname.slice(1);
        const selected = { kind: 'cfr2', channel: { name: 'runtime-r2' } };
        const key = 'runtime/' + mode;
        const type = mode === 'small' ? 'audio/mpeg' : 'video/mp4';
        const writer = await createImportWriter({ img_r2: env.IMPORT_TEST_BUCKET }, selected, key, type, 'runtime-identity', new AbortController().signal, 5000);
        try {
            if (mode === 'abort') {
                const part = await writer.part(1, new Uint8Array(IMPORT_PART_BYTES).fill(47));
                await writer.abort();
                let rejected = false;
                try { await writer.complete([part]); } catch { rejected = true; }
                return Response.json({ rejected, absent: await env.IMPORT_TEST_BUCKET.get(key) === null });
            }
            const parts = mode === 'small'
                ? [await writer.part(1, new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]))]
                : [await writer.part(1, new Uint8Array(IMPORT_PART_BYTES).fill(19)), await writer.part(2, new Uint8Array([0, 1, 2, 3, 253, 254, 255]))];
            await writer.complete(parts);
            const object = await env.IMPORT_TEST_BUCKET.get(key);
            const bytes = await object.arrayBuffer();
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
            return Response.json({ size: object.size, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata, digest });
        } finally { writer.close(); }
    }
};
`;

describe('Media import writer against the local workerd R2 binding', function () {
    this.timeout(20000);
    let runtime;

    before(async () => {
        const bundle = await build({
            stdin: { contents: workerSource, sourcefile: 'import-r2-runtime-worker.mjs', resolveDir: path.resolve(__dirname, '..') },
            bundle: true,
            write: false,
            format: 'esm',
            platform: 'browser',
            target: 'es2022',
            conditions: ['workerd', 'worker', 'browser'],
            logLevel: 'silent',
        });
        runtime = new Miniflare({
            modules: true,
            script: bundle.outputFiles[0].text,
            compatibilityDate: '2024-08-21',
            compatibilityFlags: ['global_fetch_strictly_public', 'allow_custom_ports'],
            r2Buckets: ['IMPORT_TEST_BUCKET'],
        });
        await runtime.ready;
    });

    after(async () => { await runtime?.dispose(); });

    it('completes an 8 MiB part and a short tail with exact content and media metadata', async () => {
        const response = await runtime.dispatchFetch('http://localhost/large');
        assert.equal(response.status, 200, await response.clone().text());
        const object = await response.json();
        const first = new Uint8Array(8 * 1024 * 1024).fill(19);
        const tail = new Uint8Array([0, 1, 2, 3, 253, 254, 255]);
        assert.equal(object.size, 8 * 1024 * 1024 + 7);
        assert.equal(object.httpMetadata.contentType, 'video/mp4');
        assert.equal(object.customMetadata.importIdentity, 'runtime-identity');
        assert.equal(object.digest, createHash('sha256').update(first).update(tail).digest('hex'));
    });

    it('allows a single small final part for images and audio', async () => {
        const response = await runtime.dispatchFetch('http://localhost/small');
        assert.equal(response.status, 200, await response.clone().text());
        const object = await response.json();
        const bytes = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
        assert.equal(object.size, 10);
        assert.equal(object.httpMetadata.contentType, 'audio/mpeg');
        assert.equal(object.digest, createHash('sha256').update(bytes).digest('hex'));
    });

    it('aborts uploaded parts without publishing an object or leaving a completable upload', async () => {
        const response = await runtime.dispatchFetch('http://localhost/abort');
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), { rejected: true, absent: true });
    });
});
