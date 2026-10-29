'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

describe('Docker request signal after real-IP header injection', function () {
    this.timeout(5000);

    it('propagates a real client socket disconnect to the Functions request', async () => {
        const { Hono } = await import('hono');
        const { serve } = await import('@hono/node-server');
        const { getConnInfo } = await import('@hono/node-server/conninfo');
        const entry = path.resolve(__dirname, '../deploy/server/index.js');
        const fixturePath = path.resolve(__dirname, '../functions/api/disconnect-fixture.js');
        const received = deferred();
        const aborted = deferred();
        const release = deferred();
        const listening = deferred();
        const retention = { started: false, closed: false, async start() { this.started = true; }, async close() { this.closed = true; } };
        let server;
        let client;
        // Run the real entry point and Hono router. Replace only unrelated
        // persistence/services and the selected Functions handler; no data
        // directory or real SQLite database is accessed by this fixture.
        const context = vm.createContext({
            URL, Headers, Request, Response, ReadableStream, AbortController,
            console, process: { env: { PORT: '0' }, once() {} }, fetch: globalThis.fetch,
        });
        const synthetic = (name, exports) => new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: name });
        const fixture = synthetic('disconnect-handler', {
            onRequest: async ({ request, env }) => {
                request.signal.addEventListener('abort', () => aborted.resolve(true), { once: true });
                received.resolve({ request, env });
                await release.promise;
                return new Response('finished');
            },
        });
        await fixture.link(() => {});
        await fixture.evaluate();
        const module = new vm.SourceTextModule(fs.readFileSync(entry, 'utf8'), {
            context,
            identifier: pathToFileURL(entry).href,
            initializeImportMeta(meta) { meta.url = pathToFileURL(entry).href; },
            importModuleDynamically(specifier) {
                assert.equal(specifier, pathToFileURL(fixturePath).href);
                return fixture;
            },
        });
        await module.link(async (specifier) => {
            if (specifier === 'hono') return synthetic(specifier, { Hono });
            if (specifier === '@hono/node-server') return synthetic(specifier, {
                serve: (options) => {
                    server = serve({ ...options, hostname: '127.0.0.1', overrideGlobalObjects: false }, () => listening.resolve());
                    return server;
                },
            });
            if (specifier === '@hono/node-server/conninfo') return synthetic(specifier, { getConnInfo });
            if (specifier === '@hono/node-server/serve-static') return synthetic(specifier, { serveStatic: () => async () => undefined });
            if (specifier === 'fs') return synthetic(specifier, {
                existsSync: (file) => file === fixturePath,
                readFileSync: () => { throw new Error('Unexpected file read'); },
                readdirSync: () => [], statSync: () => ({ isFile: () => true }), mkdirSync() {},
            });
            if (specifier === 'path' || specifier === 'url') return synthetic(specifier, await import(`node:${specifier}`));
            if (specifier === './sqliteD1.js') return synthetic(specifier, { SqliteD1: class {} });
            if (specifier === './r2Storage.js') return synthetic(specifier, { LocalR2Storage: class {} });
            if (specifier === './imageProcessor.js') return synthetic(specifier, { dockerImageProcessor: {} });
            if (specifier === './importSource.js') return synthetic(specifier, { createNodeImportFetcher: () => () => {} });
            if (specifier === './retention/index.js') return synthetic(specifier, { createRetentionService: () => retention });
            throw new Error(`Unexpected fixture import: ${specifier}`);
        });
        try {
            await module.evaluate();
            await listening.promise;
            client = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/disconnect-fixture', method: 'POST' });
            client.on('error', () => {});
            client.end('{}');
            const { request: forwarded, env } = await received.promise;
            assert.equal(env.RETENTION_SERVICE, retention);
            assert.equal(retention.started, true);
            assert.equal(forwarded.headers.get('x-real-ip'), '127.0.0.1');
            client.destroy();
            const outcome = await Promise.race([aborted.promise, new Promise(resolve => setTimeout(() => resolve(false), 200))]);
            assert.equal(outcome, true, 'The reconstructed Functions request lost its incoming disconnect signal');
            assert.equal(forwarded.signal.aborted, true);
        } finally {
            release.resolve();
            client?.destroy();
            server?.closeAllConnections();
            if (server) await new Promise(resolve => server.close(resolve));
            assert.equal(retention.closed, true);
        }
    });
});
