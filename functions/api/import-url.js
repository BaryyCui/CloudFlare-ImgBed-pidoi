import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
import { fetchUploadConfig, fetchPageConfig } from '../utils/sysConfig.js';
import { createResponse, sanitizeUploadFolder, getUploadIp, isBlockedUploadIp } from '../upload/uploadTools.js';
import { ImportError, assertPublicSourceURL, publicImportError } from '../utils/importSecurity.js';
import { selectImportStorage } from '../utils/importStorage.js';
import { importLimits, runMediaImport } from '../utils/importMedia.js';

function jsonError(error) {
    return createResponse(JSON.stringify({ error: error.message, code: error.code }), { status: error.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    if (request.method !== 'POST') return jsonError(new ImportError('method_not_allowed', 'Method not allowed', 405));
    if (!await userAuthCheck(env, url, request, 'upload')) return UnauthorizedResponse('Unauthorized');
    if (await isBlockedUploadIp(env, getUploadIp(request))) return jsonError(new ImportError('blocked_upload', 'Upload is not allowed', 403));
    let input, source, selected, prefix, limits;
    try {
        const bodyReader = request.body?.getReader();
        let body = '';
        let length = 0;
        const decoder = new TextDecoder();
        if (bodyReader) {
            try {
                while (true) {
                    const next = await bodyReader.read();
                    if (next.done) break;
                    length += next.value.byteLength;
                    if (length > 16384) throw new ImportError('invalid_request', 'Import request is too large', 413);
                    body += decoder.decode(next.value, { stream: true });
                }
                body += decoder.decode();
            } finally { await bodyReader.cancel(); }
        }
        try { input = JSON.parse(body); } catch { throw new ImportError('invalid_request', 'Invalid JSON'); }
        if (!input || typeof input.url !== 'string') throw new ImportError('invalid_url', 'url is required');
        source = assertPublicSourceURL(input.url);
        if (input.mediaType !== undefined && !['auto', 'image', 'video', 'audio'].includes(input.mediaType)) throw new ImportError('invalid_media_type', 'mediaType must be auto, image, video or audio');
        if (input.purpose !== undefined && (input.purpose !== 'video-result' || input.mediaType !== 'video')) throw new ImportError('invalid_purpose', 'video-result purpose requires mediaType video');
        if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256)) throw new ImportError('invalid_idempotency_key', 'idempotencyKey must contain 1 to 256 characters');
        for (const key of ['filename', 'uploadFolder', 'uploadChannel', 'channelName', 'contentType']) {
            if (input[key] !== undefined && typeof input[key] !== 'string') throw new ImportError('invalid_request', 'Import options must be strings');
        }
        limits = importLimits(env, input);
        context.url = url;
        context.url.searchParams.set('uploadFolder', sanitizeUploadFolder(input.uploadFolder || 'videos'));
        context.uploadConfig = await fetchUploadConfig(env, context);
        selected = selectImportStorage(env, context.uploadConfig, input);
        const config = await fetchPageConfig(env);
        prefix = config.config?.find(item => item.id === 'urlPrefix')?.value || '';
    } catch (error) { return jsonError(publicImportError(error)); }
    const controller = new AbortController();
    const onDisconnect = () => controller.abort(new ImportError('canceled', 'Import canceled', 499));
    request.signal.addEventListener('abort', onDisconnect, { once: true });
    if (request.signal.aborted) onDisconnect();
    const isStream = input.mode === 'stream' || request.headers.get('accept')?.includes('application/x-ndjson');
    if (isStream) {
        let closed = false;
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(output) {
                const emit = progress => { if (!closed) output.enqueue(encoder.encode(`${JSON.stringify(progress)}\n`)); };
                runMediaImport(context, input, selected, source, prefix, limits, controller, emit)
                    .catch(() => {})
                    .finally(() => {
                        request.signal.removeEventListener('abort', onDisconnect);
                        if (!closed) { closed = true; output.close(); }
                    });
            },
            cancel() { closed = true; onDisconnect(); },
        });
        return createResponse(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    }
    try {
        const result = await runMediaImport(context, input, selected, source, prefix, limits, controller, () => {});
        return createResponse(JSON.stringify([result]), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (error) { return jsonError(publicImportError(error, controller.signal)); }
    finally { request.signal.removeEventListener('abort', onDisconnect); }
}
