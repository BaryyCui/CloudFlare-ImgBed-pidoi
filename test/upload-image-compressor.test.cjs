'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

function noise(width, height, alpha = false) {
    const channels = alpha ? 4 : 3;
    const data = Buffer.alloc(width * height * channels);
    let state = 0x12345678;
    for (let pixel = 0; pixel < width * height; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            data[pixel * channels + channel] = state & 255;
        }
        if (alpha) data[pixel * channels + 3] = pixel % width < width / 3 ? 0 : 255;
    }
    return sharp(data, { raw: { width, height, channels } });
}

// Real APNG control chunks are needed because libvips can report an APNG as a
// single PNG page. The IDAT pixels still come from Sharp, not a decoder mock.
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length);
    chunk.write(type, 4, 4, 'ascii');
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return chunk;
}

describe('Docker upload image compressor', function () {
    this.timeout(20000);
    let compressor;
    let session;

    before(async () => {
        ({ dockerUploadImageCompressor: compressor } = await import('../deploy/server/uploadImageCompressor.js'));
    });

    afterEach(() => {
        session?.release();
        session = null;
    });

    function acquire() {
        session = compressor.tryAcquire();
        assert.ok(session, 'a completed/released operation must make capacity available');
        return session;
    }

    it('reserves capacity before buffering and immediately skips when busy', () => {
        acquire();
        assert.equal(session.maxInputBytes, 64 * 1024 * 1024);
        assert.equal(compressor.tryAcquire(), null);
        session.release();
        session.release();
        const previous = session;
        acquire();
        previous.release();
        assert.equal(compressor.tryAcquire(), null, 'an old idempotent release cannot free the new reservation');
    });

    for (const [format, contentType, targetBytes] of [
        ['jpeg', 'image/jpeg', 20000],
        ['png', 'image/png', 60000],
        ['webp', 'image/webp', 20000],
        ['avif', 'image/avif', 20000],
    ]) {
        it(`compresses real ${format} bytes toward the target while keeping their format`, async () => {
            const input = await noise(512, 384)[format](format === 'png' ? { compressionLevel: 0 } : { quality: 100, effort: 0 }).toBuffer();
            const original = Buffer.from(input);
            const result = await acquire().compress(new Uint8Array(input), { targetBytes });
            assert.ok(result, `${format} should produce a smaller candidate`);
            assert.ok(result.data instanceof Uint8Array);
            assert.ok(result.data.byteLength < input.byteLength);
            assert.ok(result.data.byteLength <= targetBytes, `${format}: ${result.data.byteLength} > ${targetBytes}`);
            assert.equal(result.targetMet, true);
            assert.equal(result.contentType, contentType);
            const metadata = await sharp(result.data).metadata();
            assert.equal(metadata.format, format === 'avif' ? 'heif' : format);
            if (format === 'avif') assert.equal(metadata.compression, 'av1');
            assert.equal(result.width, metadata.width);
            assert.equal(result.height, metadata.height);
            assert.ok(result.width <= 512 && result.height <= 384);
            assert.ok(Math.min(result.width, result.height) >= 128);
            assert.ok(Math.abs(result.width / result.height - 4 / 3) < 0.02);
            assert.deepEqual(input, original, 'source bytes remain available for a fallback');
        });
    }

    for (const format of ['png', 'webp', 'avif']) {
        it(`retains transparency when compressing ${format}`, async () => {
            const input = await noise(384, 256, true)[format](format === 'png' ? { compressionLevel: 0 } : { quality: 100, effort: 0 }).toBuffer();
            const result = await acquire().compress(input, { targetBytes: 30000 });
            assert.ok(result);
            assert.equal((await sharp(result.data).metadata()).hasAlpha, true);
            const { data, info } = await sharp(result.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
            assert.equal(data[3], 0);
            assert.equal(data[(info.width - 1) * 4 + 3], 255);
        });
    }

    it('returns a useful best-effort result instead of shrinking below a 128px shortest edge', async () => {
        const input = await noise(512, 384).png().toBuffer();
        const result = await acquire().compress(input, { targetBytes: 100 });
        assert.ok(result);
        assert.equal(result.targetMet, false);
        assert.ok(result.data.length > 100 && result.data.length < input.length);
        assert.equal(Math.min(result.width, result.height), 128);
    });

    it('returns null when input already meets the target or cannot get smaller', async () => {
        const input = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'black' } }).png().toBuffer();
        assert.equal(await acquire().compress(input, { targetBytes: input.length }), null);
        session.release();
        assert.equal(await acquire().compress(input, { targetBytes: 1 }), null);
    });

    it('rejects invalid, corrupt, oversized and excessive-pixel inputs without losing capacity', async () => {
        const oversizedPixels = await sharp({ create: { width: 10000, height: 4001, channels: 3, background: 'white' } }).png().toBuffer();
        const jpeg = await noise(256, 256).jpeg().toBuffer();
        for (const input of [Buffer.from('not an image'), jpeg.subarray(0, 90), new Uint8Array(64 * 1024 * 1024 + 1), oversizedPixels]) {
            assert.equal(await acquire().compress(input, { targetBytes: 1 }), null);
            session.release();
        }
    });

    it('skips SVG and GIF including animated GIF', async () => {
        const gif = await sharp({ create: { width: 256, height: 256, channels: 3, background: 'blue' } }).gif().toBuffer();
        for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"/>'), gif]) {
            assert.equal(await acquire().compress(input, { targetBytes: 1 }), null);
            session.release();
        }
    });

    it('detects APNG animation even when metadata reports a single PNG page', async () => {
        const png = await noise(256, 256).png().toBuffer();
        const animationControl = Buffer.alloc(8);
        animationControl.writeUInt32BE(2);
        const frameControl = Buffer.alloc(26);
        frameControl.writeUInt32BE(256, 4);
        frameControl.writeUInt32BE(256, 8);
        frameControl.writeUInt16BE(1, 20);
        frameControl.writeUInt16BE(10, 22);
        const apng = Buffer.concat([png.subarray(0, 33), pngChunk('acTL', animationControl), pngChunk('fcTL', frameControl), png.subarray(33)]);
        assert.equal((await sharp(apng).metadata()).format, 'png');
        assert.equal(await acquire().compress(apng, { targetBytes: 20000 }), null);
    });

    it('skips animated WebP rather than storing only the first frame', async () => {
        const data = await noise(256, 512).raw().toBuffer();
        const animated = await sharp(data, { raw: { width: 256, height: 512, channels: 3, pageHeight: 256 } }).webp({ quality: 90, loop: 0, delay: [100, 100] }).toBuffer();
        assert.equal((await sharp(animated).metadata()).pages, 2);
        assert.equal(await acquire().compress(animated, { targetBytes: 20000 }), null);
    });

    it('rejects AVIF sequence brands and HEIC containers', async () => {
        const avif = await noise(256, 256).avif({ quality: 100, effort: 0 }).toBuffer();
        const animated = Buffer.from(avif);
        animated.write('avis', 8, 'ascii');
        const heic = Buffer.from(avif);
        for (let offset = 8; offset < heic.readUInt32BE(0); offset += 4) {
            if (heic.toString('ascii', offset, offset + 4) === 'avif') heic.write('heic', offset, 'ascii');
        }
        for (const input of [animated, heic]) {
            assert.equal(await acquire().compress(input, { targetBytes: 1000 }), null);
            session.release();
        }
    });

    it('does not start work for an already aborted request', async () => {
        const abort = new AbortController();
        abort.abort();
        const input = await noise(256, 256).jpeg().toBuffer();
        assert.equal(await acquire().compress(input, { targetBytes: 1000, signal: abort.signal }), null);
    });

    it('keeps its slot until cancelled native work settles even if release is called early', async () => {
        const input = await noise(1600, 1200).png().toBuffer();
        const abort = new AbortController();
        acquire();
        const pending = session.compress(input, { targetBytes: 1000, signal: abort.signal });
        await new Promise((resolve) => setTimeout(resolve, 5));
        session.release();
        abort.abort();
        assert.equal(compressor.tryAcquire(), null);
        assert.equal(await pending, null);
        acquire();
    });

    it('rejects another operation on the same reserved session without queueing', async () => {
        const input = await noise(512, 384).png().toBuffer();
        acquire();
        const pending = session.compress(input, { targetBytes: 30000 });
        assert.equal(await session.compress(input, { targetBytes: 30000 }), null);
        assert.ok(await pending);
    });

    it('stops a cancelled native AVIF encode promptly instead of waiting for the encoder', async () => {
        const input = await noise(4096, 4096).avif({ quality: 100, effort: 0 }).toBuffer();
        const abort = new AbortController();
        acquire();
        const pending = session.compress(input, { targetBytes: 1000, signal: abort.signal });
        await new Promise((resolve) => setTimeout(resolve, 150));
        const cancelledAt = performance.now();
        abort.abort();
        session.release();
        assert.equal(compressor.tryAcquire(), null, 'termination must finish before another source is admitted');
        assert.equal(await pending, null);
        assert.ok(performance.now() - cancelledAt < 1200, 'cancellation must terminate actual native work');
        acquire();
    });

    it('does not start compression after its reservation has been released', async () => {
        const input = await noise(256, 256).jpeg().toBuffer();
        acquire().release();
        assert.equal(await session.compress(input, { targetBytes: 1000 }), null);
        acquire();
    });

    it('kills an unresponsive child at the wall-clock deadline before freeing capacity', async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-compressor-deadline-'));
        const preload = path.join(directory, 'stall.cjs');
        // Hold a real child inside synchronous work, as a stuck native encoder
        // would. No mock can satisfy the required process-exit/slot lifecycle.
        await fs.writeFile(preload, "if (process.argv.includes('--compress-upload-image')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);\n");
        const previousOptions = process.env.NODE_OPTIONS;
        try {
            process.env.NODE_OPTIONS = `${previousOptions || ''} --require ${JSON.stringify(preload)}`;
            const input = await noise(256, 256).jpeg({ quality: 100 }).toBuffer();
            const startedAt = performance.now();
            const result = await acquire().compress(input, { targetBytes: 1000 });
            const elapsed = performance.now() - startedAt;
            assert.equal(result, null);
            assert.ok(elapsed >= 14000 && elapsed < 19000, `deadline elapsed ${elapsed}ms`);
            session.release();
            acquire();
        } finally {
            if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
            else process.env.NODE_OPTIONS = previousOptions;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it('applies EXIF orientation before resizing and removing the orientation tag', async () => {
        const input = await noise(384, 256).jpeg({ quality: 100 }).withMetadata({ orientation: 6 }).toBuffer();
        const result = await acquire().compress(input, { targetBytes: 15000 });
        assert.ok(result);
        assert.ok(result.width < result.height);
        assert.ok(Math.abs(result.width / result.height - 2 / 3) < 0.02);
        assert.equal((await sharp(result.data).metadata()).orientation, undefined);
    });
});
