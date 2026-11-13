import sharp from 'sharp';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MIN_SHORTEST_EDGE = 128;
const MAX_PROCESSING_MS = 15_000;
const MAX_OPERATION_SECONDS = 5;
const MAX_RESIZE_ATTEMPTS = 5;
const INPUT_OPTIONS = {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
};

let reserved = false;

// Reserve before the caller buffers the upload. There is intentionally no queue:
// a busy process stores the original instead of accumulating large buffers.
export const dockerUploadImageCompressor = {
    tryAcquire() {
        if (reserved) return null;
        reserved = true;
        let released = false;
        let running = false;
        let used = false;

        return {
            maxInputBytes: MAX_INPUT_BYTES,
            async compress(input, options = {}) {
                if (released || used) return null;
                used = true;
                running = true;
                try {
                    return await compressIsolated(input, options);
                } catch {
                    // Recompression is optional. Decode, encoder and timeout
                    // failures all preserve the caller's untouched source.
                    return null;
                } finally {
                    running = false;
                    if (released) reserved = false;
                }
            },
            release() {
                if (released) return;
                released = true;
                // A caller can cancel/release while an encoder is working.
                // Never admit another image until that native work settles.
                if (!running) reserved = false;
            },
        };
    },
};

// This same module is the worker entrypoint so Docker needs no additional
// worker asset or dependency. IPC serialization preserves the binary buffers.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--compress-upload-image') {
    sharp.cache({ memory: 32, files: 0, items: 16 });
    sharp.concurrency(1);
    process.once('message', async ({ input, targetBytes }) => {
        let result = null;
        try {
            result = await compressImage(input, { targetBytes });
        } catch {
            // Unsupported, corrupt or expensive sources fall back unchanged.
        }
        process.send(result, () => process.disconnect());
    });
}

function eligibleSource(input, { targetBytes, signal }) {
    // ArrayBuffer.isView also recognizes byte arrays from a VM/worker realm.
    if (!ArrayBuffer.isView(input) || input.BYTES_PER_ELEMENT !== 1 || input.byteLength === 0 ||
        input.byteLength > MAX_INPUT_BYTES || !Number.isFinite(targetBytes) || targetBytes <= 0 ||
        input.byteLength <= targetBytes || signal?.aborted) return null;
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
}

async function compressIsolated(input, options) {
    const source = eligibleSource(input, options);
    if (!source || !detectStillFormat(source)) return null;

    // libvips' timeout uses progress callbacks, which some encoders do not
    // emit during expensive work. A child process gives both metadata parsing
    // and native encoding a real wall-clock deadline and immediate cancellation.
    // Only one admitted source/process exists at a time, with no waiting queue.
    return await new Promise((resolve) => {
        const worker = fork(fileURLToPath(import.meta.url), ['--compress-upload-image'], {
            execArgv: [],
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        let result = null;
        let stopping = false;
        let finished = false;
        const stop = () => {
            stopping = true;
            result = null;
            worker.kill('SIGKILL');
        };
        const timer = setTimeout(stop, MAX_PROCESSING_MS);
        const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', stop);
            resolve(value);
        };
        worker.on('message', (value) => {
            if (!stopping) result = value;
        });
        worker.once('error', () => {
            // A failed spawn has no native work to await. For a running child,
            // wait for close so release() cannot overlap its remaining work.
            if (!worker.pid) finish(null);
            else stop();
        });
        worker.once('close', (code) => finish(code === 0 && !stopping ? result : null));
        options.signal?.addEventListener('abort', stop, { once: true });
        if (options.signal?.aborted) stop();
        else worker.send({ input: source, targetBytes: options.targetBytes }, (error) => {
            if (error) stop();
        });
    });
}

async function compressImage(input, { targetBytes, signal }) {
    const source = eligibleSource(input, { targetBytes, signal });
    if (!source) return null;
    const format = detectStillFormat(source);
    if (!format) return null;

    const deadline = Date.now() + MAX_PROCESSING_MS;
    const metadata = await sharp(source, INPUT_OPTIONS).metadata();
    if (signal?.aborted || Date.now() >= deadline || (metadata.pages || 1) > 1 ||
        !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_INPUT_PIXELS ||
        (format === 'avif' ? metadata.format !== 'heif' || metadata.compression !== 'av1' : metadata.format !== format)) {
        return null;
    }

    // autoOrient applies EXIF rotation before stripping metadata so display
    // orientation survives re-encoding, including when dimensions are reduced.
    const rotate = metadata.orientation >= 5 && metadata.orientation <= 8;
    const originalWidth = rotate ? metadata.height : metadata.width;
    const originalHeight = rotate ? metadata.width : metadata.height;
    const minimumScale = Math.min(1, MIN_SHORTEST_EDGE / Math.min(originalWidth, originalHeight));
    let width = originalWidth;
    let height = originalHeight;
    let best = null;
    let currentBytes = source.byteLength;

    for (let resizeAttempt = 0; resizeAttempt <= MAX_RESIZE_ATTEMPTS; resizeAttempt++) {
        // PNG retains its alpha/color samples; reducing dimensions is its
        // size control. Lossy formats first try lower quality at full size.
        const qualities = format === 'png' ? [null] : resizeAttempt === 0 ? [82, 65, 48] : [72, 48];
        for (const quality of qualities) {
            if (signal?.aborted || Date.now() >= deadline) return null;
            const seconds = Math.max(1, Math.min(MAX_OPERATION_SECONDS, Math.ceil((deadline - Date.now()) / 1000)));
            let pipeline = sharp(source, INPUT_OPTIONS).autoOrient().resize({
                width,
                height,
                fit: 'inside',
                withoutEnlargement: true,
            }).timeout({ seconds });
            switch (format) {
                case 'jpeg': pipeline = pipeline.jpeg({ quality }); break;
                case 'png': pipeline = pipeline.png({ compressionLevel: 9 }); break;
                case 'webp': pipeline = pipeline.webp({ quality, alphaQuality: 100, effort: 3 }); break;
                case 'avif': pipeline = pipeline.avif({ quality, effort: 2 }); break;
            }
            // Sharp's timeout is an extra cooperative safeguard. The parent
            // enforces the hard deadline and waits for this process to exit.
            const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
            if (signal?.aborted || Date.now() >= deadline) return null;
            currentBytes = data.byteLength;
            if (data.byteLength < (best?.data.byteLength ?? source.byteLength)) {
                best = {
                    data,
                    contentType: `image/${format}`,
                    width: info.width,
                    height: info.height,
                    targetMet: data.byteLength <= targetBytes,
                };
                if (best.targetMet) return best;
            }
        }

        // The requested byte size is best effort. Preserve a sensible minimum
        // resolution rather than crushing a large image to a tiny thumbnail.
        const scale = Math.max(minimumScale, width / originalWidth * Math.min(0.85, Math.max(0.35, Math.sqrt(targetBytes / currentBytes) * 0.9)));
        const nextWidth = Math.max(1, Math.round(originalWidth * scale));
        const nextHeight = Math.max(1, Math.round(originalHeight * scale));
        if (nextWidth >= width || nextHeight >= height) break;
        width = nextWidth;
        height = nextHeight;
    }
    return best;
}

function detectStillFormat(source) {
    if (source.length >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) return 'jpeg';
    if (source.length >= 8 && source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        for (let offset = 8; offset + 12 <= source.length;) {
            const length = source.readUInt32BE(offset);
            const end = offset + 12 + length;
            if (end > source.length) return null;
            if (source.toString('ascii', offset + 4, offset + 8) === 'acTL') return null;
            offset = end;
        }
        return 'png';
    }
    if (source.length >= 12 && source.toString('ascii', 0, 4) === 'RIFF' && source.toString('ascii', 8, 12) === 'WEBP') {
        for (let offset = 12; offset + 8 <= source.length;) {
            const length = source.readUInt32LE(offset + 4);
            const end = offset + 8 + length;
            if (end > source.length) return null;
            const type = source.toString('ascii', offset, offset + 4);
            if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length > 0 && (source[offset + 8] & 0x02))) return null;
            offset = end + (length % 2);
        }
        return 'webp';
    }
    // Only AV1 still-image containers are eligible. The avis brand identifies
    // AVIF image sequences, including ones a decoder exposes as one page.
    if (source.length >= 16 && source.toString('ascii', 4, 8) === 'ftyp') {
        const end = source.readUInt32BE(0);
        if (end < 16 || end > source.length || end % 4 !== 0) return null;
        let avif = false;
        for (let offset = 8; offset + 4 <= end; offset += 4) {
            if (offset === 12) continue; // minor version, not a brand
            const brand = source.toString('ascii', offset, offset + 4);
            if (brand === 'avis' || brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return null;
            if (brand === 'avif') avif = true;
        }
        if (avif) return 'avif';
    }
    return null;
}
