'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const networkError = (error) => error.code === 'source_network' && error.message === 'Source download failed' && error.status === 502;
const blockedError = (error) => error.code === 'blocked_source' && error.status === 400;

describe('Docker source fetch DNS pinning and stream cancellation', function () {
    this.timeout(4000);
    let createNodeImportFetcher;
    let server;
    let origin;
    let handler;
    let lookupCalls;
    let requestOptions;

    before(async () => ({ createNodeImportFetcher } = await import('../deploy/server/importSource.js')));
    beforeEach(async () => {
        lookupCalls = [];
        requestOptions = [];
        handler = (request, response) => response.end('fixture');
        server = http.createServer((request, response) => handler(request, response));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://assets.example.com:${server.address().port}`;
    });
    afterEach(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    // Keep the real HTTP socket and stream lifecycle. Only DNS and transport
    // destination are redirected to the local fixture; no public host is dialed.
    function fetcher(overrides = {}) {
        const localRequest = (options, callback) => {
            requestOptions.push(options);
            options.lookup(options.hostname, { all: true }, (error, addresses) => {
                assert.ifError(error);
                assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
            });
            return http.request({
                ...options,
                protocol: 'http:',
                hostname: '127.0.0.1',
                port: server.address().port,
            }, callback);
        };
        return createNodeImportFetcher({
            dnsLookup: async (hostname, options) => {
                lookupCalls.push({ hostname, options });
                return [{ address: '8.8.8.8', family: 4 }, { address: '1.1.1.1', family: 4 }];
            },
            httpRequest: localRequest,
            httpsRequest: localRequest,
            ...overrides,
        });
    }

    it('returns streaming HTTP bytes with original Host, path and custom port after one DNS lookup', async () => {
        let responseWriter;
        handler = (request, response) => {
            assert.equal(request.headers.host, new URL(origin).host);
            assert.equal(request.url, '/media?signature=fixture');
            assert.equal(request.headers['x-fixture'], 'present');
            response.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Source': 'fixture' });
            response.write('first');
            responseWriter = response;
        };
        const response = await fetcher()(`${origin}/media?signature=fixture`, { headers: new Headers({ 'X-Fixture': 'present', Host: 'bad.example.com' }) });
        assert.equal(response.headers.get('x-source'), 'fixture');
        const reader = response.body.getReader();
        assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
        responseWriter.end('last');
        assert.equal(Buffer.from((await reader.read()).value).toString(), 'last');
        assert.equal((await reader.read()).done, true);
        assert.deepEqual(lookupCalls, [{ hostname: 'assets.example.com', options: { all: true, verbatim: true } }]);
        assert.equal(Number(requestOptions[0].port), Number(new URL(origin).port));
        assert.equal(requestOptions[0].agent, false);
    });

    it('preserves HTTPS Host and SNI while pinning the connection address', async () => {
        const response = await fetcher()(origin.replace('http:', 'https:'));
        assert.equal(await response.text(), 'fixture');
        assert.equal(requestOptions[0].protocol, 'https:');
        assert.equal(requestOptions[0].servername, 'assets.example.com');
        assert.equal(requestOptions[0].rejectUnauthorized, true);
        assert.equal(requestOptions[0].headers.host, new URL(origin).host);
    });

    it('rejects every mixed public/private DNS result before opening a connection', async () => {
        for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.2', '::1', '::ffff:8.8.8.8']) {
            const read = fetcher({ dnsLookup: async () => [{ address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }] });
            await assert.rejects(read(origin), blockedError);
        }
        assert.equal(requestOptions.length, 0);
    });

    it('rejects private literals and non-GET calls before opening a connection', async () => {
        await assert.rejects(fetcher()('http://127.0.0.1/media'), blockedError);
        await assert.rejects(fetcher()(origin, { method: 'POST' }));
        assert.equal(requestOptions.length, 0);
    });

    it('returns redirects for the caller to revalidate without following them', async () => {
        let requests = 0;
        handler = (request, response) => {
            requests++;
            response.writeHead(302, { Location: 'http://127.0.0.1/private' });
            response.end();
        };
        const response = await fetcher()(origin);
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'http://127.0.0.1/private');
        await response.body.cancel();
        assert.equal(requests, 1);
    });

    it('hides resolver and socket errors including signed URLs', async () => {
        const read = fetcher({ dnsLookup: async () => { throw new Error('secret https://assets.example.com/?token=secret'); } });
        await assert.rejects(read(origin), networkError);
        handler = (request) => request.socket.destroy(new Error('fixture socket failure'));
        await assert.rejects(fetcher()(`${origin}/?token=secret`), networkError);
    });

    it('cancels during DNS without opening a later connection', async () => {
        const dns = deferred();
        const abort = new AbortController();
        const reading = fetcher({ dnsLookup: () => dns.promise })(origin, { signal: abort.signal });
        const rejected = assert.rejects(reading, networkError);
        abort.abort(new Error('private reason'));
        await rejected;
        dns.resolve([{ address: '8.8.8.8', family: 4 }]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requestOptions.length, 0);
    });

    it('aborts a socket waiting for response headers', async () => {
        const arrived = deferred();
        const closed = deferred();
        handler = (request) => {
            request.socket.once('close', closed.resolve);
            arrived.resolve();
        };
        const abort = new AbortController();
        const reading = fetcher()(origin, { signal: abort.signal });
        const rejected = assert.rejects(reading, networkError);
        await arrived.promise;
        abort.abort();
        await rejected;
        await closed.promise;
    });

    it('aborts an outstanding body read and closes the source socket', async () => {
        const closed = deferred();
        handler = (request, response) => {
            request.socket.once('close', closed.resolve);
            response.writeHead(200);
            response.write('first');
        };
        const abort = new AbortController();
        const response = await fetcher()(origin, { signal: abort.signal });
        const reader = response.body.getReader();
        await reader.read();
        const rejected = assert.rejects(reader.read(), networkError);
        abort.abort(new Error('private reason'));
        await rejected;
        await closed.promise;
    });

    it('closes the source socket when the consumer cancels a response body', async () => {
        const closed = deferred();
        handler = (request, response) => {
            request.socket.once('close', closed.resolve);
            response.writeHead(200);
            response.write('first');
        };
        const response = await fetcher()(origin);
        await response.body.cancel();
        await closed.promise;
    });

    it('sanitizes a source failure after response bytes have begun', async () => {
        let socket;
        handler = (request, response) => {
            socket = request.socket;
            response.writeHead(200);
            response.write('first');
        };
        const response = await fetcher()(origin);
        const reader = response.body.getReader();
        await reader.read();
        const rejected = assert.rejects(reader.read(), networkError);
        socket.destroy();
        await rejected;
    });
});
