const assert = require('node:assert/strict');

describe('Compression after multipart commit', function () {
    let compressStoredUpload;
    before(async () => ({ compressStoredUpload } = await import('../functions/utils/uploadImageCompression.js')));
    function fixture() {
        const controller = new AbortController();
        const original = new Uint8Array(1024 * 1024 + 1);
        const small = new Uint8Array(123);
        let released = false;
        const context = { request: { signal: controller.signal },
            uploadConfig: { imageCompression: { enabled: true, thresholdMB: 1, targetMB: 0.5 } },
            env: { UPLOAD_IMAGE_COMPRESSOR: { tryAcquire: () => ({ maxInputBytes: 2e6,
                compress: async () => ({ data: small, contentType: 'image/jpeg', width: 500, height: 400 }),
                release() { released = true; },
            }) } },
        };
        const metadata = { FileType: 'image/jpeg', FileSizeBytes: original.length };
        return { controller, context, original, metadata, released: () => released };
    }
    it('lets original metadata be published when the client disconnects after original multipart completion', async () => {
        const f = fixture();
        await compressStoredUpload(f.context, f.metadata, {
            read: async () => { f.controller.abort(); throw f.controller.signal.reason; },
            write: () => assert.fail('canceled compression must not replace the committed source'),
        });
        assert.equal(f.metadata.FileSizeBytes, f.original.length);
        assert.equal(f.released(), true);
    });
    it('finishes an in-progress replacement despite a response disconnect and records its actual size', async () => {
        const f = fixture();
        await compressStoredUpload(f.context, f.metadata, {
            read: async () => new Response(f.original).body,
            write: async (result, signal) => { f.controller.abort(); assert.equal(signal.aborted, false); assert.equal(result.data.length, 123); },
        });
        assert.equal(f.metadata.FileSizeBytes, 123);
        assert.equal(f.released(), true);
    });
    it('does not claim compression succeeded if the storage replacement fails', async () => {
        const f = fixture();
        await assert.rejects(compressStoredUpload(f.context, f.metadata, {
            read: async () => new Response(f.original).body,
            write: async () => { throw new Error('storage unavailable'); },
        }), /storage unavailable/);
        assert.equal(f.metadata.FileSizeBytes, f.original.length);
        assert.equal(f.released(), true);
    });
});
