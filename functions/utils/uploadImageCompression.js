const MB = 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
export const DEFAULT_IMAGE_COMPRESSION = Object.freeze({ enabled: false, thresholdMB: 5, targetMB: 4 });

export function validateImageCompression(value) {
    if (!value || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
        typeof value.thresholdMB !== 'number' || !Number.isFinite(value.thresholdMB) || value.thresholdMB < 1 || value.thresholdMB > 20 ||
        typeof value.targetMB !== 'number' || !Number.isFinite(value.targetMB) || value.targetMB < 0.5 || value.targetMB > value.thresholdMB) {
        throw new Error('Image compression requires enabled (boolean), thresholdMB (1–20), and targetMB (0.5–thresholdMB)');
    }
    return { enabled: value.enabled, thresholdMB: value.thresholdMB, targetMB: value.targetMB };
}

export function imageCompressionConfig(value) {
    try { return validateImageCompression(value); }
    catch { return { ...DEFAULT_IMAGE_COMPRESSION }; }
}

function acquire(context, contentType, size) {
    const config = imageCompressionConfig(context.uploadConfig?.imageCompression);
    if (!config.enabled || !IMAGE_TYPES.has(contentType) || (Number.isFinite(size) && size <= config.thresholdMB * MB)) return null;
    const session = context.env.UPLOAD_IMAGE_COMPRESSOR?.tryAcquire();
    if (!session) return null;
    if (Number.isFinite(size) && size > session.maxInputBytes) { session.release(); return null; }
    return { session, config };
}

async function compress(session, bytes, contentType, config, signal) {
    signal?.throwIfAborted();
    if (bytes.byteLength <= config.thresholdMB * MB || bytes.byteLength > session.maxInputBytes) return null;
    let result;
    try { result = await session.compress(bytes, { targetBytes: Math.floor(config.targetMB * MB), signal }); }
    catch { signal?.throwIfAborted(); return null; }
    signal?.throwIfAborted();
    if (!result || !ArrayBuffer.isView(result.data) || result.data.byteLength === 0 ||
        result.data.byteLength >= bytes.byteLength || result.contentType !== contentType) return null;
    return { ...result, compression: {
        originalBytes: bytes.byteLength, storedBytes: result.data.byteLength,
        targetBytes: Math.floor(config.targetMB * MB), targetMet: result.data.byteLength <= config.targetMB * MB,
    } };
}

function joinChunks(chunks, size) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

// Buffer only eligible static images, with admission before reading the body.
// If the size bound is reached, return every consumed byte to the original
// streaming writer. Download errors and cancellation must still fail the import.
export async function prepareImageStream(context, { contentType, size, chunks = [], read, signal, onCompress = () => {} }) {
    const original = { chunks, done: false, result: null };
    const slot = acquire(context, contentType, size);
    if (!slot) return original;
    const { session, config } = slot;
    try {
        let length = chunks.reduce((sum, part) => sum + part.byteLength, 0);
        while (length <= session.maxInputBytes) {
            signal?.throwIfAborted();
            const next = await read();
            if (next.done) { original.done = true; break; }
            chunks.push(next.value);
            length += next.value.byteLength;
        }
        if (!original.done || length <= config.thresholdMB * MB) return original;
        // Do not silently compress a truncated source and publish it as valid.
        if (Number.isFinite(size) && length !== size) return original;
        onCompress();
        const result = await compress(session, joinChunks(chunks, length), contentType, config, signal);
        return result ? { chunks: [result.data], done: true, result } : original;
    } finally { session.release(); }
}

export async function compressUploadForm(context, formdata) {
    const file = formdata.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') return null;
    const type = file.type?.toLowerCase();
    const slot = acquire(context, type, file.size);
    if (!slot) return null;
    try {
        const result = await compress(slot.session, new Uint8Array(await file.arrayBuffer()), type, slot.config, context.request.signal);
        if (result) formdata.set('file', new Blob([result.data], { type: result.contentType }), file.name);
        return result;
    } finally { slot.session.release(); }
}

export function applyCompressionMetadata(metadata, result) {
    if (!result) return;
    metadata.FileSizeBytes = result.data.byteLength;
    metadata.FileSize = (result.data.byteLength / MB).toFixed(2);
    metadata.FileType = result.contentType;
    metadata.Width = result.width;
    metadata.Height = result.height;
    metadata.ImageCompression = result.compression;
}

// Multipart storage APIs finalize the original object first. Re-read only a
// bounded eligible image, then atomically replace it before publishing metadata.
// Read/codec failure leaves the original intact; storage write failure propagates
// rather than reporting an original size for an uncertain replacement.
export async function compressStoredUpload(context, metadata, { read, write }) {
    const slot = acquire(context, metadata.FileType, metadata.FileSizeBytes);
    if (!slot) return;
    const signal = AbortSignal.any([context.request.signal, AbortSignal.timeout(30000)]);
    let reader;
    const cancel = () => { reader?.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        let result;
        try {
            const stream = await read(signal);
            if (!stream) return;
            reader = stream.getReader();
            signal.throwIfAborted();
            const chunks = [];
            let length = 0;
            while (true) {
                const next = await reader.read();
                signal.throwIfAborted();
                if (next.done) break;
                length += next.value.byteLength;
                if (length > slot.session.maxInputBytes) return;
                chunks.push(next.value);
            }
            if (length !== metadata.FileSizeBytes) return;
            result = await compress(slot.session, joinChunks(chunks, length), metadata.FileType, slot.config, signal);
        } catch {
            // The original multipart object is already committed. Cancel only
            // this optional compression, then let callers publish its metadata.
            return;
        }
        if (result) {
            // Once replacement starts, finish it and its metadata even if the
            // client disconnects. Keep a separate bounded finalization budget.
            await write(result, AbortSignal.timeout(30000));
            applyCompressionMetadata(metadata, result);
        }
    } finally {
        await reader?.cancel().catch(() => {});
        signal.removeEventListener('abort', cancel);
        slot.session.release();
    }
}
