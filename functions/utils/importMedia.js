import { ImportError, assertPublicSourceURL, workerSourceFetch, publicImportError } from './importSecurity.js';
import { IMPORT_PART_BYTES, abortable, retryTransient, createImportWriter } from './importStorage.js';
import { getDatabase } from './databaseAdapter.js';
import { buildUniqueFileId, endUpload, sanitizeFileName, sanitizeUploadFolder } from '../upload/uploadTools.js';

const encoder = new TextEncoder();
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function configuredNumber(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export function importLimits(env, input) {
    const serverMax = Math.min(configuredNumber(env.IMPORT_URL_MAX_BYTES, DEFAULT_MAX_BYTES), 10000 * IMPORT_PART_BYTES);
    const requested = input.maxSizeMB === undefined || Number(input.maxSizeMB) === 0 ? serverMax : Number(input.maxSizeMB) * 1024 * 1024;
    if (!Number.isFinite(requested) || requested <= 0) throw new ImportError('invalid_size', 'maxSizeMB must be a positive number');
    const videoResult = input.purpose === 'video-result';
    return {
        maxBytes: Math.floor(Math.min(serverMax, requested)),
        totalMS: videoResult ? configuredNumber(env.IMPORT_VIDEO_TIMEOUT_MS, 30 * 60 * 1000) : configuredNumber(env.IMPORT_URL_TIMEOUT_MS, 5 * 60 * 1000),
        idleMS: videoResult ? configuredNumber(env.IMPORT_VIDEO_IDLE_TIMEOUT_MS, 120000) : configuredNumber(env.IMPORT_URL_IDLE_TIMEOUT_MS, 30000),
    };
}

export function detectImportMedia(bytes, requested = 'auto', declared = '') {
    const text = String.fromCharCode(...bytes.subarray(0, 512));
    const starts = (...values) => values.every((value, index) => bytes[index] === value);
    let type;
    if (starts(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)) type = 'image/png';
    else if (starts(0xff, 0xd8, 0xff)) type = 'image/jpeg';
    else if (/^GIF8[79]a/.test(text)) type = 'image/gif';
    else if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') type = 'image/webp';
    else if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') type = 'audio/wav';
    else if (text.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) type = 'audio/mpeg';
    else if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) type = 'audio/aac';
    else if (text.startsWith('fLaC')) type = 'audio/flac';
    else if (text.startsWith('OggS')) {
        if (text.includes('theora')) type = 'video/ogg';
        else if (/OpusHead|vorbis|Speex  |fLaC|FLAC/.test(text)) type = 'audio/ogg';
        else return null; // Wait for the identification packet, not a network chunk boundary.
    }
    else if (text.slice(4, 8) === 'ftyp' && bytes.length >= 12) {
        const brand = text.slice(8, 12);
        type = /^(avif|avis)$/.test(brand) ? 'image/avif' : /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand) ? 'image/heic' :
            /^(M4A |M4B |M4P |F4A |F4B )$/.test(brand) ? 'audio/mp4' : 'video/mp4';
    } else if (starts(0x1a, 0x45, 0xdf, 0xa3)) type = requested === 'audio' || declared.startsWith('audio/') ? 'audio/webm' : 'video/webm';
    if (!type) return null;
    const mediaType = type.split('/')[0];
    if (requested !== 'auto' && requested !== mediaType) throw new ImportError('media_mismatch', 'Source media type does not match the requested type', 415);
    return { contentType: type, mediaType };
}

async function digest(value) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sourceResponse(context, input, source, signal, limits, onAttempt) {
    const fetchSource = context.env.IMPORT_SOURCE_FETCH || workerSourceFetch;
    let current = source;
    let allowCredentials = true;
    const credentials = new Headers();
    // Backward compatibility for the video-result importer only. Never copy
    // the incoming ImgBed authentication or arbitrary caller headers.
    if (input.headers && typeof input.headers === 'object' && (!input.mediaType || input.mediaType === 'video')) {
        for (const [name, value] of Object.entries(input.headers)) {
            if (/^(authorization|cookie)$/i.test(name) && typeof value === 'string') credentials.set(name, value);
        }
    }
    for (let hop = 0; hop <= 5; hop++) {
        assertPublicSourceURL(current);
        const response = await retryTransient(async attemptSignal => {
            // The attempt deadline ends at response headers; cancellation from
            // the import must continue to reach the resulting response body.
            const sourceSignal = AbortSignal.any([signal, attemptSignal]);
            const result = await fetchSource(current, { method: 'GET', headers: allowCredentials ? credentials : new Headers(), redirect: 'manual', signal: sourceSignal });
            if (sourceSignal.aborted) { await result.body?.cancel(); throw sourceSignal.reason; }
            if ([408, 429, 500, 502, 503, 504].includes(result.status)) {
                await result.body?.cancel();
                throw Object.assign(new ImportError('source_unavailable', 'Source download failed', 502), { status: result.status });
            }
            return result;
        }, signal, limits.idleMS, onAttempt);
        if (signal.aborted) { await response.body?.cancel(); throw signal.reason; }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location || hop === 5) throw new ImportError('redirect_limit', 'Source redirect limit exceeded', 502);
            const next = assertPublicSourceURL(new URL(location, current));
            if (next.origin !== source.origin) allowCredentials = false;
            current = next;
            continue;
        }
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new ImportError('source_unavailable', 'Source download failed', 502);
        }
        return response;
    }
    throw new ImportError('redirect_limit', 'Source redirect limit exceeded', 502);
}

export async function runMediaImport(context, input, selected, source, prefix, limits, controller, emit) {
    const signal = controller.signal;
    let reader;
    let writer;
    let finished = false;
    let bytesDone = 0;
    let uploadedBytes = 0;
    let bytesTotal;
    let actualMediaType;
    let attempt = 1;
    let state = 'downloading';
    let phase = 'connecting';
    const progress = extra => emit({ state, phase, attempt, bytes_done: bytesDone, uploaded_bytes: uploadedBytes, ...(bytesTotal === undefined ? {} : { bytes_total: bytesTotal }), ...(actualMediaType ? { mediaType: actualMediaType } : {}), ...extra });
    const onAttempt = current => { if (current > attempt) { attempt = current; progress(); } };
    const timer = setTimeout(() => controller.abort(new ImportError('timeout', 'Import exceeded the total timeout', 504)), limits.totalMS);
    const heartbeat = setInterval(() => progress(), 5000);
    const cancelReader = () => { reader?.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', cancelReader, { once: true });
    try {
        progress();
        const db = getDatabase(context.env);
        const folder = sanitizeUploadFolder(input.uploadFolder || 'videos');
        const requestIdentity = await digest(JSON.stringify([input.idempotencyKey || crypto.randomUUID(), source.href, selected.identity, folder, input.mediaType || 'auto', input.contentType || '']));
        const recordKey = `manage@import@${requestIdentity}`;
        if (input.idempotencyKey) {
            const saved = await abortable(() => db.get(recordKey), signal, limits.idleMS);
            if (saved && (!context.env.RETENTION_SERVICE || await context.env.RETENTION_SERVICE.validateImportReplay(requestIdentity, JSON.parse(saved)))) {
                const previous = JSON.parse(saved);
                if (previous.bytes > limits.maxBytes) throw new ImportError('size_limit', 'Source file is too large', 413);
                bytesDone = previous.bytes;
                uploadedBytes = previous.bytes;
                bytesTotal = previous.bytes;
                actualMediaType = previous.mediaType;
                state = 'completed';
                phase = 'finalizing';
                progress(previous.result);
                return previous.result;
            }
        }
        const response = await sourceResponse(context, input, source, signal, limits, onAttempt);
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null && /^\d+$/.test(declaredLength)) bytesTotal = Number(declaredLength);
        if (bytesTotal > limits.maxBytes) { bytesTotal = undefined; await response.body.cancel(); throw new ImportError('size_limit', 'Source file is too large', 413); }
        phase = 'downloading'; progress();
        reader = response.body.getReader();
        if (signal.aborted) { await reader.cancel(); throw signal.reason; }
        const declaredType = String(input.contentType || response.headers.get('content-type') || '').split(';')[0].toLowerCase();
        let detected;
        let prefixBytes = new Uint8Array(0);
        let pending;
        const take = async () => {
            const chunk = await abortable(() => reader.read(), signal, limits.idleMS);
            if (signal.aborted) throw signal.reason;
            if (!chunk.done) {
                if (chunk.value.byteLength > limits.maxBytes - bytesDone) {
                    bytesDone = limits.maxBytes;
                    throw new ImportError('size_limit', 'Source file is too large', 413);
                }
                bytesDone += chunk.value.byteLength;
            }
            return chunk;
        };
        // Sniff only a bounded prefix, preserving the remainder for the first
        // part. The response body is never materialized as a File/arrayBuffer.
        while (!detected && prefixBytes.length < 512) {
            pending = await take();
            if (pending.done) break;
            const count = Math.min(512 - prefixBytes.length, pending.value.length);
            const combined = new Uint8Array(prefixBytes.length + count);
            combined.set(prefixBytes); combined.set(pending.value.subarray(0, count), prefixBytes.length);
            prefixBytes = combined;
            detected = detectImportMedia(prefixBytes, input.mediaType || 'auto', declaredType);
            if (detected) { pending = { done: false, value: pending.value.subarray(count) }; break; }
            if (pending.value.length > count) break;
        }
        if (!detected) throw new ImportError('unsupported_media', 'Source is not a supported image, video or audio file', 415);
        actualMediaType = detected.mediaType;
        const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/webm': 'webm' })[detected.contentType];
        const fileName = sanitizeFileName(input.filename || source.pathname.split('/').pop() || `media.${extension}`);
        const fullId = input.idempotencyKey ? `${folder ? `${folder}/` : ''}import-${requestIdentity}.${extension}` : await buildUniqueFileId(context, fileName, detected.contentType);
        // Deterministic names are owned by this identity. Never accept an
        // arbitrary object key or overwrite unrelated existing metadata.
        phase = 'creating_upload'; progress();
        const existing = await abortable(() => db.getWithMetadata(fullId), signal, limits.idleMS);
        if (existing?.metadata && Object.keys(existing.metadata).length && existing.metadata.ImportIdentity !== requestIdentity) throw new ImportError('destination_conflict', 'Import destination already exists', 409);
        writer = await createImportWriter(context.env, selected, fullId, detected.contentType, requestIdentity, signal, limits.idleMS, onAttempt);
        phase = 'downloading'; progress();
        const parts = [];
        let part = new Uint8Array(IMPORT_PART_BYTES);
        let used = 0;
        const flush = async () => {
            if (!used) return;
            state = 'uploading'; phase = 'uploading'; progress();
            parts.push(await writer.part(parts.length + 1, used === part.length ? part : part.subarray(0, used)));
            uploadedBytes += used;
            used = 0;
            state = 'downloading'; phase = 'downloading'; progress();
        };
        const append = async bytes => {
            for (let offset = 0; offset < bytes.length;) {
                const count = Math.min(part.length - used, bytes.length - offset);
                part.set(bytes.subarray(offset, offset + count), used);
                used += count; offset += count;
                if (used === part.length) await flush();
            }
        };
        await append(prefixBytes);
        if (pending && !pending.done) await append(pending.value);
        while (true) {
            const chunk = await take();
            if (chunk.done) break;
            await append(chunk.value);
        }
        if (bytesTotal !== undefined && bytesDone !== bytesTotal) throw new ImportError('source_truncated', 'Source download length did not match Content-Length', 502);
        await flush();
        part = null;
        state = 'uploading'; phase = 'finalizing'; progress();
        const metadata = {
            FileName: fileName, FileType: detected.contentType, FileSizeBytes: bytesDone,
            FileSize: (bytesDone / 1024 / 1024).toFixed(2), Directory: folder ? `${folder}/` : '',
            Channel: selected.kind === 's3' ? 'S3' : 'CloudflareR2', ChannelName: selected.channel.name,
            ...(selected.kind === 's3' ? { S3FileKey: fullId } : {}), ImportIdentity: requestIdentity, TimeStamp: Date.now(),
        };
        const result = { src: `/file/${fullId}`, ...(prefix ? { publicUrl: `${prefix.replace(/\/+$/, '')}/${fullId}` } : {}) };
        await writer.complete(parts, async () => {
            // A completed object cannot be undone safely by aborting its old
            // multipart session. Finish its records with a separate five-second
            // budget even if the caller disconnects at the commit boundary.
            finished = true;
            const finalization = new AbortController();
            const deadline = setTimeout(() => finalization.abort(new ImportError('finalize_timeout', 'Import finalization timed out', 504)), 5000);
            try {
                await abortable(() => db.put(fullId, '', { metadata }), finalization.signal, 5000);
                const indexed = await abortable(() => endUpload(context, fullId, metadata), finalization.signal, 5000);
                if (indexed?.success !== true) throw new ImportError('index_failed', 'Import index could not be saved', 502);
                if (input.idempotencyKey) await abortable(() => db.put(recordKey, JSON.stringify({ result, bytes: bytesDone, mediaType: actualMediaType })), finalization.signal, 5000);
            } finally { clearTimeout(deadline); }
        }, context.waitUntil ? promise => context.waitUntil(promise) : undefined);
        if (signal.aborted) throw signal.reason;
        state = 'completed'; progress(result);
        return result;
    } catch (error) {
        const safe = publicImportError(error, signal);
        controller.abort(safe);
        state = 'failed'; progress({ error: safe.message, code: safe.code });
        throw safe;
    } finally {
        clearTimeout(timer); clearInterval(heartbeat);
        signal.removeEventListener('abort', cancelReader);
        try { await reader?.cancel(); } catch { /* already canceled */ }
        if (writer && !finished) {
            const cleanup = new AbortController();
            try { await abortable(() => writer.abort(), cleanup.signal, 5000); } catch { /* lifecycle rules are the final orphan safeguard */ }
        }
        writer?.close();
    }
}
