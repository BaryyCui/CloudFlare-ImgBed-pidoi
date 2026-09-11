import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
import { fetchSecurityConfig, fetchUploadConfig, fetchPageConfig } from '../utils/sysConfig.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { buildUniqueFileId, createResponse, endUpload, sanitizeFileName, sanitizeUploadFolder } from '../upload/uploadTools.js';

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function isPrivateHostname(hostname) {
    const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!value || value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal')) return true;
    if (/^(10\.|127\.|169\.254\.|192\.168\.)/.test(value)) return true;
    const match = value.match(/^172\.(\d+)\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
    if (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
    return false;
}

function jsonError(message, status = 400) {
    return createResponse(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequest(context) {
    const { request, env, waitUntil } = context;
    const url = new URL(request.url);
    if (request.method !== 'POST') return jsonError('Method not allowed', 405);
    if (!await userAuthCheck(env, url, request, 'upload')) return UnauthorizedResponse('Unauthorized');

    let input;
    try { input = await request.json(); } catch { return jsonError('Invalid JSON'); }
    if (!input || typeof input.url !== 'string') return jsonError('url is required');

    let source;
    try { source = new URL(input.url); } catch { return jsonError('Invalid URL'); }
    if (source.protocol !== 'https:' || source.username || source.password || isPrivateHostname(source.hostname)) return jsonError('Only public HTTPS URLs are allowed');

    const headers = new Headers();
    if (input.headers && typeof input.headers === 'object') {
        for (const [key, value] of Object.entries(input.headers)) {
            if (/^(authorization|cookie|proxy-authorization)$/i.test(key) && typeof value === 'string') headers.set(key, value);
        }
    }
    let response;
    let current = source;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        response = await fetch(current, { method: 'GET', headers, redirect: 'manual' });
        if (response.status < 300 || response.status >= 400 || !response.headers.get('location')) break;
        current = new URL(response.headers.get('location'), current);
        if (current.protocol !== 'https:' || isPrivateHostname(current.hostname)) return jsonError('Redirect target is not allowed');
    }
    if (!response?.ok) return jsonError(`Source download failed: HTTP ${response?.status || 0}`, 502);

    const contentType = (input.contentType || response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    if (!contentType.startsWith('video/')) return jsonError('Only video content is allowed');
    const requestedMaxMB = Number(input.maxSizeMB || 0);
    const maxBytes = requestedMaxMB > 0
        ? Math.min(requestedMaxMB * 1024 * 1024, Number(env.IMPORT_URL_MAX_BYTES || DEFAULT_MAX_BYTES))
        : Number(env.IMPORT_URL_MAX_BYTES || DEFAULT_MAX_BYTES);
    if (Number(response.headers.get('content-length')) > maxBytes) return jsonError('Source file is too large', 413);
    const data = await response.arrayBuffer();
    if (data.byteLength > maxBytes) return jsonError('Source file is too large', 413);

    const fileName = sanitizeFileName(input.filename || source.pathname.split('/').pop() || 'video.mp4');
    const folder = sanitizeUploadFolder(input.uploadFolder || 'videos');
    const uploadURL = new URL(url);
    uploadURL.searchParams.set('uploadFolder', folder);
    context.url = uploadURL;
    context.uploadConfig = await fetchUploadConfig(env, context);
    const pageConfig = await fetchPageConfig(env);
    const prefix = pageConfig.config?.find(item => item.id === 'urlPrefix')?.value || '';
    const fullId = await buildUniqueFileId(context, fileName, contentType);
    const storage = env.img_r2;
    if (!storage || typeof storage.put !== 'function') return jsonError('R2 storage is not configured', 500);
    await storage.put(fullId, data);
    const metadata = { FileName: fileName, FileType: contentType, FileSizeBytes: data.byteLength, FileSize: (data.byteLength / 1024 / 1024).toFixed(2), Directory: folder ? `${folder}/` : '', Channel: 'CloudflareR2', ChannelName: 'R2_env', TimeStamp: Date.now() };
    await getDatabase(env).put(fullId, '', { metadata });
    waitUntil(endUpload(context, fullId, metadata));
    const publicUrl = prefix ? `${prefix.replace(/\/+$/, '')}/${fullId}` : `${url.origin}/file/${fullId}`;
    return createResponse(JSON.stringify([{ src: `/file/${fullId}`, publicUrl }]), { headers: { 'Content-Type': 'application/json' } });
}
