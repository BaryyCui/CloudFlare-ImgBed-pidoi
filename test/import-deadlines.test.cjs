'use strict';

const assert = require('node:assert/strict');
const { loadImport, media } = require('./import-test-harness.cjs');

const events = async response => (await response.text()).trim().split('\n').map(JSON.parse);

describe('URL import cancellation before retry', function () {
    this.timeout(5000);

    it('cancels an expired source request before starting another request', async () => {
        let active = 0;
        let peak = 0;
        let cancellations = 0;
        const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 250, IMPORT_URL_TIMEOUT_MS: 3000 },
            fetchImpl: async (_url, { signal }, calls) => {
                active++;
                peak = Math.max(peak, active);
                if (calls.fetch.length > 1) { active--; return new Response(media.video); }
                return new Promise((_, reject) => signal.addEventListener('abort', () => {
                    active--; cancellations++; reject(signal.reason);
                }, { once: true }));
            },
        });
        const response = await fixture.invoke();
        assert.equal(response.status, 200);
        assert.equal(fixture.calls.fetch.length, 2);
        assert.equal(cancellations, 1);
        assert.equal(peak, 1);
        assert.equal(active, 0);
    });

    for (const kind of ['cfr2', 's3']) {
        it(`cancels an expired ${kind} part before retrying its buffer`, async () => {
            let active = 0;
            let peak = 0;
            let attempts = 0;
            let cancellations = 0;
            const part = async signal => {
                attempts++; active++; peak = Math.max(peak, active);
                if (attempts > 1) { active--; return; }
                return new Promise((_, reject) => signal.addEventListener('abort', () => {
                    active--; cancellations++; reject(signal.reason);
                }, { once: true }));
            };
            const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 250, IMPORT_URL_TIMEOUT_MS: 3000 },
                settings: { cfr2: { channels: [{ name: 'local' }] }, s3: { channels: [{ name: 'remote', endpoint: 'https://s3.example', bucketName: 'videos', accessKeyId: 'fixture', secretAccessKey: 'fixture' }] } },
                uploadPart: async (_number, _bytes, _calls, options) => part(options.signal),
                s3Send: async (command, _calls, options) => {
                    if (command.command === 'CreateMultipartUploadCommand') return { UploadId: 'upload' };
                    if (command.command === 'UploadPartCommand') { await part(options.abortSignal); return { ETag: 'part-etag' }; }
                    return {};
                },
            });
            const response = await fixture.invoke({ uploadChannel: kind });
            assert.equal(response.status, 200);
            assert.equal(attempts, 2);
            assert.equal(cancellations, 1);
            assert.equal(peak, 1);
            assert.equal(active, 0);
            assert.deepEqual(kind === 'cfr2' ? fixture.calls.parts : fixture.calls.s3.filter(call => call.command === 'UploadPartCommand').map(call => call.input.ContentLength), [24, 24]);
        });
    }

    it('fails without launching a concurrent retry if the source ignores cancellation', async () => {
        const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 250, IMPORT_URL_TIMEOUT_MS: 3000 },
            fetchImpl: async () => new Promise(() => {}),
        });
        const response = await fixture.invoke();
        assert.equal(response.status, 504);
        assert.equal((await response.json()).code, 'stalled');
        assert.equal(fixture.calls.fetch.length, 1);
    });

    it('forwards a caller cancellation to an in-flight source attempt without retry', async () => {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        let sourceSignal;
        const fixture = await loadImport({ fetchImpl: async (_url, { signal }) => {
            sourceSignal = signal;
            started();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        } });
        const controller = new AbortController();
        const pending = fixture.invoke({}, { signal: controller.signal });
        await ready;
        controller.abort();
        const response = await pending;
        assert.equal(response.status, 499);
        assert.equal((await response.json()).code, 'canceled');
        assert.equal(sourceSignal.aborted, true);
        assert.equal(fixture.calls.fetch.length, 1);
    });

    it('keeps caller cancellation connected after successful source headers', async () => {
        let reading;
        const ready = new Promise(resolve => { reading = resolve; });
        let sourceSignal;
        let canceled = false;
        const fixture = await loadImport({ fetchImpl: async (_url, { signal }) => {
            sourceSignal = signal;
            return new Response(new ReadableStream({
                start(controller) { controller.enqueue(media.video); },
                pull() { reading(); },
                cancel() { canceled = true; },
            }));
        } });
        const controller = new AbortController();
        const response = await fixture.invoke({ mode: 'stream' }, { signal: controller.signal });
        await ready;
        controller.abort();
        const result = await events(response);
        assert.equal(result.at(-1).state, 'failed');
        assert.equal(result.at(-1).code, 'canceled');
        assert.equal(sourceSignal.aborted, true);
        assert.equal(canceled, true);
        assert.equal(fixture.calls.completes, 0);
    });

    it('cancels a response arriving at the expired header deadline before retry', async () => {
        let canceled = false;
        const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 250, IMPORT_URL_TIMEOUT_MS: 3000 },
            fetchImpl: async (_url, { signal }, calls) => {
                if (calls.fetch.length > 1) {
                    assert.equal(canceled, true);
                    return new Response(media.video);
                }
                return new Promise(resolve => signal.addEventListener('abort', () => resolve(new Response(new ReadableStream({
                    cancel() { canceled = true; },
                }))), { once: true }));
            },
        });
        const response = await fixture.invoke();
        assert.equal(response.status, 200);
        assert.equal(canceled, true);
        assert.equal(fixture.calls.fetch.length, 2);
    });
});

describe('Output-video import budgets and progress', () => {
    it('keeps output-video budgets separate from reference and legacy imports', async () => {
        const fixture = await loadImport();
        const output = { purpose: 'video-result', mediaType: 'video' };
        assert.deepEqual({ ...fixture.importLimits({}, output) }, { maxBytes: 2147483648, totalMS: 1800000, idleMS: 120000 });
        assert.deepEqual({ ...fixture.importLimits({}, { mediaType: 'video' }) }, { maxBytes: 2147483648, totalMS: 300000, idleMS: 30000 });
        const configured = { IMPORT_URL_TIMEOUT_MS: 1000, IMPORT_URL_IDLE_TIMEOUT_MS: 200, IMPORT_VIDEO_TIMEOUT_MS: 3000, IMPORT_VIDEO_IDLE_TIMEOUT_MS: 500 };
        assert.deepEqual({ ...fixture.importLimits(configured, output) }, { maxBytes: 2147483648, totalMS: 3000, idleMS: 500 });
        assert.deepEqual({ ...fixture.importLimits(configured, { mediaType: 'video' }) }, { maxBytes: 2147483648, totalMS: 1000, idleMS: 200 });
        assert.equal(fixture.importLimits({ IMPORT_URL_TIMEOUT_MS: 123 }, output).totalMS, 1800000);
    });

    it('rejects video-result purpose unless explicitly importing video', async () => {
        for (const body of [{ purpose: 'video-result' }, { purpose: 'video-result', mediaType: 'auto' }, { purpose: 'video-result', mediaType: 'image' }, { purpose: 'unknown', mediaType: 'video' }]) {
            const fixture = await loadImport();
            const response = await fixture.invoke(body);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, 'invalid_purpose');
            assert.equal(fixture.calls.fetch.length, 0);
        }
    });

    it('reports download and acknowledged upload bytes through every phase', async () => {
        const fixture = await loadImport();
        const result = await events(await fixture.invoke({ purpose: 'video-result', mediaType: 'video', mode: 'stream' }));
        for (const phase of ['connecting', 'downloading', 'creating_upload', 'uploading', 'finalizing']) assert.ok(result.some(event => event.phase === phase), phase);
        assert.equal(result[0].uploaded_bytes, 0);
        const beforeUpload = result.find(event => event.phase === 'uploading');
        assert.equal(beforeUpload.bytes_done, 24);
        assert.equal(beforeUpload.uploaded_bytes, 0);
        const completed = result.at(-1);
        assert.equal(completed.state, 'completed');
        assert.equal(completed.phase, 'finalizing');
        assert.equal(completed.bytes_done, 24);
        assert.equal(completed.uploaded_bytes, 24);
    });

    it('retains the failing download phase and byte progress', async () => {
        const fixture = await loadImport({ env: { IMPORT_URL_IDLE_TIMEOUT_MS: 25, IMPORT_VIDEO_IDLE_TIMEOUT_MS: 25, IMPORT_VIDEO_TIMEOUT_MS: 1000 },
            fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(media.video); } })),
        });
        const result = await events(await fixture.invoke({ purpose: 'video-result', mediaType: 'video', mode: 'stream' }));
        const failed = result.at(-1);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.code, 'stalled');
        assert.equal(failed.phase, 'downloading');
        assert.equal(failed.bytes_done, 24);
        assert.equal(failed.uploaded_bytes, 0);
    });

    it('applies the output-video total budget while waiting for source headers', async () => {
        let aborted = false;
        const fixture = await loadImport({ env: { IMPORT_VIDEO_IDLE_TIMEOUT_MS: 250, IMPORT_VIDEO_TIMEOUT_MS: 25 },
            fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
                aborted = true; reject(signal.reason);
            }, { once: true })),
        });
        const result = await events(await fixture.invoke({ purpose: 'video-result', mediaType: 'video', mode: 'stream' }));
        assert.equal(result.at(-1).state, 'failed');
        assert.equal(result.at(-1).code, 'timeout');
        assert.equal(result.at(-1).phase, 'connecting');
        assert.equal(aborted, true);
        assert.equal(fixture.calls.fetch.length, 1);
    });
});
