'use strict';
const assert = require('assert');
const { loadImport, media } = require('./import-test-harness.cjs');

describe('URL media import', () => {
    for (const [kind, contentType] of [['image', 'image/png'], ['video', 'video/mp4'], ['audio', 'audio/mpeg']]) {
        it(`imports ${kind} from a public HTTP custom port and completes NDJSON`, async () => {
            const fixture = await loadImport({ fetchImpl: async () => new Response(media[kind], { headers: { 'content-type': contentType } }) });
            const response = await fixture.invoke({ url: `http://media.example:39999/${kind}`, mediaType: kind, mode: 'stream' });
            assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
            const events = (await response.text()).trim().split('\n').map(JSON.parse);
            assert.equal(events.at(-1).state, 'completed');
            assert.equal(events.at(-1).bytes_done, media[kind].length);
            assert.equal(fixture.calls.fetch[0].url, `http://media.example:39999/${kind}`);
            assert.deepEqual([...fixture.stored.values()][0], media[kind]);
        });
    }

    it('does not forward source authorization across origins', async () => {
        const fixture = await loadImport({ fetchImpl: async (url) => String(url).includes('media.example')
            ? new Response(null, { status: 302, headers: { location: 'https://cdn.example:40000/video.mp4' } })
            : new Response(media.video, { headers: { 'content-type': 'video/mp4' } }) });
        const response = await fixture.invoke({ headers: { Authorization: 'Bearer provider-secret', Cookie: 'session=private' } });
        assert.equal(response.status, 200);
        assert.equal(fixture.calls.fetch[0].headers.get('Authorization'), 'Bearer provider-secret');
        assert.equal(fixture.calls.fetch[1].headers.get('Authorization'), null);
        assert.equal(fixture.calls.fetch[1].headers.get('Cookie'), null);
    });

    it('rejects private and credential-bearing redirects before fetching them', async () => {
        for (const target of ['http://127.0.0.1:40000/x', 'http://[::ffff:127.0.0.1]/x', 'https://user:secret@cdn.example/x']) {
            const fixture = await loadImport({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: target } }) });
            const response = await fixture.invoke({ mode: 'stream' });
            const events = (await response.text()).trim().split('\n').map(JSON.parse);
            assert.equal(events.at(-1).state, 'failed');
            assert.equal(fixture.calls.fetch.length, 1);
            assert.equal(fixture.calls.completes, 0);
            assert.ok(!JSON.stringify(events).includes('secret'));
        }
    });

    it('uses the named S3 bucket without writing the R2 fallback', async () => {
        const fixture = await loadImport({ settings: { cfr2: { channels: [{ name: 'R2_env' }] }, s3: { channels: [{ name: 'chosen', endpoint: 'https://s3.example', bucketName: 'chosen-bucket', accessKeyId: 'access', secretAccessKey: 'private', enabled: true }] } } });
        const response = await fixture.invoke({ uploadChannel: 's3', channelName: 'chosen' });
        assert.equal(response.status, 200);
        assert.ok(fixture.calls.s3.some(call => call.command === 'CompleteMultipartUploadCommand'));
        assert.ok(fixture.calls.s3.every(call => call.input.Bucket === 'chosen-bucket'));
        assert.equal(fixture.calls.parts.length, 0);
    });

    it('rejects missing destination or unauthenticated calls before fetching', async () => {
        for (const options of [{ authorized: false }, { settings: { cfr2: { channels: [] }, s3: { channels: [] } } }]) {
            const fixture = await loadImport(options);
            const response = await fixture.invoke();
            assert.ok(response.status >= 400);
            assert.equal(fixture.calls.fetch.length, 0);
        }
        const fixture = await loadImport();
        assert.equal((await fixture.invoke({ channelName: 'missing' })).status, 400);
        assert.equal(fixture.calls.fetch.length, 0);
    });

    it('limits actual bytes without Content-Length and rejects disguised HTML', async () => {
        const fixture = await loadImport({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(media.video); controller.enqueue(new Uint8Array(1024 * 1024)); controller.close();
        } })) });
        const response = await fixture.invoke({ mode: 'stream', maxSizeMB: 1 });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).code, 'size_limit');
        assert.equal(fixture.calls.completes, 0);
        const invalid = await loadImport({ fetchImpl: async () => new Response('<html>error</html>', { headers: { 'content-type': 'video/mp4' } }) });
        assert.equal((await invalid.invoke({ contentType: 'video/mp4' })).status, 415);
        assert.equal(invalid.calls.completes, 0);
    });

    it('uploads bounded parts and retries a transient part without rereading the source', async () => {
        const fixture = await loadImport({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(media.video); controller.enqueue(new Uint8Array(9 * 1024 * 1024)); controller.close();
        } })), uploadPart: async (_part, _value, calls) => { if (calls.parts.length === 1) { const error = new Error('temporary'); error.status = 503; throw error; } } });
        const response = await fixture.invoke();
        assert.equal(response.status, 200);
        assert.equal(fixture.calls.fetch.length, 1);
        assert.equal(fixture.calls.completes, 1);
        assert.ok(fixture.calls.parts.every(size => size <= 8 * 1024 * 1024));
        assert.deepEqual(fixture.calls.parts, [8 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024 + media.video.length]);
    });

    it('replays a completed idempotency key and separates different sources', async () => {
        const fixture = await loadImport();
        const first = await (await fixture.invoke({ idempotencyKey: 'request-asset-1' })).json();
        const second = await (await fixture.invoke({ idempotencyKey: 'request-asset-1' })).json();
        assert.deepEqual(second, first);
        assert.equal(fixture.calls.fetch.length, 1);
        const third = await (await fixture.invoke({ idempotencyKey: 'request-asset-1', url: 'https://media.example/other.mp4' })).json();
        assert.notEqual(third[0].src, first[0].src);
        assert.ok(!JSON.stringify([...fixture.records]).includes('https://media.example/'));
    });

    it('cancels a stalled source when the response reader disconnects', async () => {
        let canceledResolve, startedResolve;
        const started = new Promise(resolve => { startedResolve = resolve; });
        const canceled = new Promise(resolve => { canceledResolve = resolve; });
        const fixture = await loadImport({ fetchImpl: async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(media.video); startedResolve(); }, cancel() { canceledResolve(); },
        })) });
        const response = await fixture.invoke({ mode: 'stream' });
        const reader = response.body.getReader();
        await reader.read(); await started; await reader.cancel();
        await Promise.race([canceled, new Promise((_, reject) => setTimeout(() => reject(new Error('source was not canceled')), 500))]);
        assert.equal(fixture.calls.completes, 0);
    });
});

describe('URL import completion and safety boundaries', () => {
    const events = async response => (await response.text()).trim().split('\n').map(JSON.parse);
    for (const kind of ['image', 'video', 'audio']) {
        it(`auto identifies ${kind} without a suffix and reports its actual type`, async () => {
            const fixture = await loadImport({ fetchImpl: async () => new Response(media[kind]) });
            const result = await events(await fixture.invoke({ url: 'https://media.example/content', mediaType: 'auto' }, { headers: { Accept: 'application/x-ndjson' } }));
            assert.equal(result.at(-1).state, 'completed');
            assert.equal(result.at(-1).mediaType, kind);
        });
    }
    it('rejects a media category mismatch before opening a multipart upload', async () => {
        const fixture = await loadImport();
        const response = await fixture.invoke({ mediaType: 'image' });
        assert.equal(response.status, 415);
        assert.equal((await response.json()).code, 'media_mismatch');
        assert.equal(fixture.calls.parts.length, 0);
    });
    it('reports the real transient retry count and caps failed part retries', async () => {
        const fixture = await loadImport({ uploadPart: async () => { throw Object.assign(new Error('Bearer private-key'), { status: 503 }); } });
        const result = await events(await fixture.invoke({ mode: 'stream' }));
        assert.equal(fixture.calls.parts.length, 3);
        assert.equal(fixture.calls.aborts, 1);
        assert.equal(fixture.calls.completes, 0);
        assert.equal(result.at(-1).state, 'failed');
        assert.equal(result.at(-1).attempt, 3);
        assert.ok(!JSON.stringify(result).includes('private-key'));
    });
    it('retries a transient source response before transferring its body', async () => {
        const fixture = await loadImport({ fetchImpl: async (_url, _init, calls) => calls.fetch.length < 2
            ? new Response('private details', { status: 503 }) : new Response(media.video) });
        const result = await events(await fixture.invoke({ mode: 'stream' }));
        assert.equal(fixture.calls.fetch.length, 2);
        assert.equal(result.at(-1).attempt, 2);
        assert.equal(result.at(-1).state, 'completed');
    });
    for (const [setting, code] of [['IMPORT_URL_IDLE_TIMEOUT_MS', 'stalled'], ['IMPORT_URL_TIMEOUT_MS', 'timeout']]) {
        it(`cancels a stalled download on ${setting}`, async () => {
            let canceled = false;
            const fixture = await loadImport({ env: { [setting]: 25 }, fetchImpl: async () => new Response(new ReadableStream({
                start(controller) { controller.enqueue(media.video); }, cancel() { canceled = true; },
            })) });
            const result = await events(await fixture.invoke({ mode: 'stream' }));
            assert.equal(result.at(-1).code, code);
            assert.equal(fixture.calls.aborts, 1);
            assert.equal(fixture.calls.completes, 0);
            assert.equal(canceled, true);
        });
    }
    it('uploads a full part before the source reaches EOF', async () => {
        let releaseTail;
        const uploaded = new Promise(resolve => { releaseTail = resolve; });
        let partUploaded = false;
        const first = Buffer.alloc(8 * 1024 * 1024); media.video.copy(first);
        let pulls = 0;
        const fixture = await loadImport({
            fetchImpl: async () => new Response(new ReadableStream({ async pull(controller) {
                if (pulls++ === 0) controller.enqueue(first);
                else { await uploaded; controller.enqueue(Buffer.from('tail')); controller.close(); }
            } })),
            uploadPart: async () => { partUploaded = true; releaseTail(); },
        });
        const result = await fixture.invoke();
        assert.equal(result.status, 200);
        assert.equal(partUploaded, true);
        assert.deepEqual(fixture.calls.parts, [8 * 1024 * 1024, 4]);
    });
    it('checks Workers DNS answers and rejects mixed public/private addresses', async () => {
        const fixture = await loadImport({ env: { IMPORT_SOURCE_FETCH: undefined }, fetchImpl: async url => {
            assert.equal(new URL(url).hostname, 'cloudflare-dns.com');
            return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }, { type: 1, data: '127.0.0.1' }] });
        } });
        const result = await events(await fixture.invoke({ mode: 'stream' }));
        assert.equal(result.at(-1).code, 'blocked_source');
        assert.equal(fixture.calls.fetch.length, 2);
        assert.equal(fixture.calls.parts.length, 0);
    });
    it('rejects normalized private URL literals and unsafe schemes before network I/O', async () => {
        for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://[::ffff:7f00:1]/', 'http://[2002:7f00:1::]/', 'http://localhost./', 'file:///etc/passwd']) {
            const fixture = await loadImport();
            assert.equal((await fixture.invoke({ url })).status, 400);
            assert.equal(fixture.calls.fetch.length, 0);
        }
    });
    it('does not restore credentials after a redirect returns to the original origin', async () => {
        const fixture = await loadImport({ fetchImpl: async (_url, _init, calls) => calls.fetch.length < 3
            ? new Response(null, { status: 302, headers: { location: calls.fetch.length === 1 ? 'https://cdn.example/object' : 'https://media.example/final' } })
            : new Response(media.video) });
        assert.equal((await fixture.invoke({ headers: { Authorization: 'private', Cookie: 'private', 'Proxy-Authorization': 'proxy-secret' } })).status, 200);
        assert.equal(fixture.calls.fetch[0].headers.get('proxy-authorization'), null);
        assert.equal(fixture.calls.fetch[2].headers.get('authorization'), null);
        assert.equal(fixture.calls.fetch[2].headers.get('cookie'), null);
    });
});

describe('URL import retry and replay regressions', () => {
    it('identifies Ogg video independently of transport chunk boundaries', async () => {
        const bytes = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('\x80theora')]);
        for (const split of [false, true]) {
            const fixture = await loadImport({ fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
                if (split) { controller.enqueue(bytes.subarray(0, 4)); controller.enqueue(bytes.subarray(4)); }
                else controller.enqueue(bytes);
                controller.close();
            } })) });
            const response = await fixture.invoke({ mediaType: 'video' });
            assert.equal(response.status, 200);
        }
    });
    it('enforces the current size limit when replaying a completed idempotency key', async () => {
        const fixture = await loadImport();
        assert.equal((await fixture.invoke({ idempotencyKey: 'asset-replay' })).status, 200);
        const response = await fixture.invoke({ idempotencyKey: 'asset-replay', maxSizeMB: 1 / 1024 / 1024 });
        assert.equal(response.status, 413);
        assert.equal((await response.json()).code, 'size_limit');
        assert.equal(fixture.calls.fetch.length, 1);
    });
    it('cleans a late-created S3 upload after the creation deadline expires', async () => {
        const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 15 },
            settings: { s3: { channels: [{ name: 'chosen', endpoint: 'https://s3.example', bucketName: 'chosen-bucket', accessKeyId: 'access', secretAccessKey: 'private' }] } },
            s3Send: async command => {
                if (command.command === 'CreateMultipartUploadCommand') { await new Promise(resolve => setTimeout(resolve, 40)); return { UploadId: 'late-upload' }; }
                return {};
            },
        });
        const response = await fixture.invoke({ uploadChannel: 's3' });
        assert.equal(response.status, 504);
        await new Promise(resolve => setTimeout(resolve, 70));
        assert.ok(fixture.calls.s3.some(call => call.command === 'AbortMultipartUploadCommand' && call.input.UploadId === 'late-upload'));
        assert.ok(!fixture.calls.s3.some(call => call.command === 'CompleteMultipartUploadCommand'));
    });
});

describe('URL import index durability', () => {
    it('does not announce or cache completion when the index operation was not persisted', async () => {
        const fixture = await loadImport({ indexResult: { success: false, error: 'private internal storage error' } });
        const response = await fixture.invoke({ mode: 'stream', idempotencyKey: 'index-fails' });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).state, 'failed');
        assert.equal(events.at(-1).code, 'index_failed');
        assert.ok(!events.some(event => event.state === 'completed'));
        assert.ok(![...fixture.records.keys()].some(key => key.startsWith('manage@import@')));
        assert.ok(!JSON.stringify(events).includes('private internal'));
    });
});

describe('URL import legacy request compatibility', () => {
    it('treats maxSizeMB zero as the configured default for existing JSON callers', async () => {
        const fixture = await loadImport();
        assert.equal((await fixture.invoke({ maxSizeMB: 0 })).status, 200);
    });
});

describe('URL import committed-object finalization', () => {
    it('preserves metadata and index after cancellation races a successful object commit', async () => {
        const fixture = await loadImport();
        const controller = new AbortController();
        const create = fixture.env.img_r2.createMultipartUpload;
        fixture.env.img_r2.createMultipartUpload = async (...args) => {
            const upload = await create(...args);
            const complete = upload.complete;
            upload.complete = async (...parts) => { const result = await complete(...parts); controller.abort(); return result; };
            return upload;
        };
        const response = await fixture.invoke({ idempotencyKey: 'cancel-finalize' }, { signal: controller.signal });
        assert.equal(response.status, 499);
        assert.equal((await response.json()).code, 'canceled');
        await Promise.allSettled(fixture.background);
        assert.equal(fixture.calls.completes, 1);
        assert.equal(fixture.stored.size, 1);
        const key = [...fixture.stored.keys()][0];
        assert.equal(fixture.records.get(key)?.metadata.FileType, 'video/mp4');
        assert.ok([...fixture.records.keys()].some(key => key.startsWith('manage@import@')));
        const replay = await fixture.invoke({ idempotencyKey: 'cancel-finalize' });
        assert.equal(replay.status, 200);
        assert.equal(fixture.calls.fetch.length, 1);
    });
    it('accepts an explicitly requested audio WebM container without a MIME header', async () => {
        const fixture = await loadImport({ fetchImpl: async () => new Response(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])) });
        const response = await fixture.invoke({ mediaType: 'audio', mode: 'stream' });
        const events = (await response.text()).trim().split('\n').map(JSON.parse);
        assert.equal(events.at(-1).state, 'completed');
        assert.equal(events.at(-1).mediaType, 'audio');
    });
});
