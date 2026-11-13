const assert = require('node:assert/strict');
const { loadImport } = require('./import-test-harness.cjs');

const image = Buffer.alloc(1024 * 1024 + 20, 21);
image.set([255, 216, 255]);
const smaller = image.subarray(0, 900);
const settings = { cfr2: { channels: [{ name: 'R2_env', enabled: true }] }, s3: { channels: [] },
    imageCompression: { enabled: true, thresholdMB: 1, targetMB: 0.5 } };
function compressor(maxInputBytes = 64 * 1024 * 1024) {
    let held = false;
    return {
        tryAcquire() {
            assert.equal(held, false); held = true;
            return { maxInputBytes, async compress(input) {
                assert.deepEqual(Buffer.from(input), image);
                return { data: smaller, contentType: 'image/jpeg', width: 800, height: 600, targetMet: true };
            }, release() { held = false; } };
        },
        isHeld: () => held,
    };
}
describe('URL import server image compression', function () {
    this.timeout(10000);
    async function fixture(options = {}) {
        return loadImport({ settings, env: { UPLOAD_IMAGE_COMPRESSOR: compressor() },
            fetchImpl: () => new Response(image, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(image.length) } }), ...options });
    }
    it('stores compressed bytes and dimensions but retains source length for idempotent size checks', async () => {
        const f = await fixture();
        const response = await f.invoke({ mediaType: 'image', idempotencyKey: 'image-1' });
        assert.equal(response.status, 200);
        const result = (await response.json())[0];
        const key = result.src.slice(6);
        assert.equal(f.stored.get(key).equals(smaller), true, "stored bytes must be compressed");
        const metadata = f.records.get(key).metadata;
        assert.equal(metadata.FileSizeBytes, 900);
        assert.equal(metadata.Width, 800);
        assert.equal(metadata.ImageCompression.originalBytes, image.length);
        const replay = await f.invoke({ mediaType: 'image', idempotencyKey: 'image-1', maxSizeMB: 1 });
        assert.equal(replay.status, 413);
        assert.equal(f.env.UPLOAD_IMAGE_COMPRESSOR.isHeld(), false);
    });
    it('preserves bytes when compression is disabled, busy or fails', async () => {
        for (const options of [
            { settings: { ...settings, imageCompression: { ...settings.imageCompression, enabled: false } } },
            { env: { UPLOAD_IMAGE_COMPRESSOR: { tryAcquire: () => null } } },
            { env: { UPLOAD_IMAGE_COMPRESSOR: { tryAcquire: () => ({ maxInputBytes: 2e6, compress: async () => { throw new Error('decode failed'); }, release() {} }) } } },
        ]) {
            const f = await fixture(options);
            const response = await f.invoke({ mediaType: 'image' });
            assert.equal(response.status, 200);
            assert.equal([...f.stored.values()][0].equals(image), true);
        }
    });
    it('streams the full original when unknown-length image exceeds compression memory bound', async () => {
        const engine = compressor(4096);
        const stream = () => { let offset = 0; return new ReadableStream({ pull(c) {
            if (offset === image.length) return c.close();
            const end = Math.min(offset + 1024, image.length); c.enqueue(image.subarray(offset, end)); offset = end;
        } }); };
        const f = await fixture({ env: { UPLOAD_IMAGE_COMPRESSOR: engine }, fetchImpl: () => new Response(stream()) });
        assert.equal((await f.invoke({ mediaType: 'image' })).status, 200);
        assert.equal([...f.stored.values()][0].equals(image), true);
        assert.equal(engine.isHeld(), false);
    });
});
