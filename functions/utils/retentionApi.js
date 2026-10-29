import { getDatabase } from './databaseAdapter.js';
import { validateApiToken } from './auth/tokenValidator.js';
import { validateSession } from './auth/sessionManager.js';
import { fetchSecurityConfig } from './sysConfig.js';

const MAX_BODY_BYTES = 16384;

export function retentionJSON(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0' },
    });
}

function requestError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

async function requireAdministrator(env, request) {
    // Cleanup must never inherit the general management API's unauthenticated
    // bootstrap mode when administrator credentials have not been configured.
    const token = await validateApiToken(request, getDatabase(env), 'manage');
    if (token.valid) return;
    const session = await validateSession(env, request, 'admin');
    if (session.valid) {
        const config = await fetchSecurityConfig(env, { throwOnError: true });
        const admin = config.auth?.admin;
        if (admin?.adminUsername?.trim() || admin?.adminPassword?.trim()) return;
    }
    throw requestError(401, 'admin_required', 'Administrator authentication is required');
}

function requireSameOrigin(request) {
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
        throw requestError(403, 'invalid_origin', 'Cross-origin changes are not allowed');
    }
    const supplied = request.headers.get('origin');
    if (!supplied) return; // Non-browser API clients authenticate with a token.
    let origin;
    try { origin = new URL(supplied); } catch { throw requestError(403, 'invalid_origin', 'Invalid request origin'); }
    const target = new URL(request.url);
    // The Docker service also runs behind HTTPS reverse proxies. The native
    // request may be HTTP, but the browser origin must still have the same host.
    const protocolMatches = origin.protocol === target.protocol || (origin.protocol === 'https:' && target.protocol === 'http:');
    if (origin.host !== target.host || !protocolMatches || !['http:', 'https:'].includes(origin.protocol)) {
        throw requestError(403, 'invalid_origin', 'Cross-origin changes are not allowed');
    }
}

async function readJSON(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw requestError(415, 'json_required', 'Content-Type must be application/json');
    }
    const reader = request.body?.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let size = 0;
    if (reader) {
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BODY_BYTES) throw requestError(413, 'request_too_large', 'Request body is too large');
                content += decoder.decode(value, { stream: true });
            }
            content += decoder.decode();
        } finally { await reader.cancel(); }
    }
    let body;
    try { body = JSON.parse(content); } catch { throw requestError(400, 'invalid_json', 'A JSON object is required'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError(400, 'invalid_json', 'A JSON object is required');
    return body;
}

export function retentionEndpoint(methods, action) {
    return async function onRequest(context) {
        try {
            const { request, env } = context;
            if (!methods.includes(request.method)) throw requestError(405, 'method_not_allowed', 'Method not allowed');
            await requireAdministrator(env, request);
            if (!env.RETENTION_SERVICE) {
                const error = { code: 'unsupported_runtime', message: 'Scheduled cleanup is available only for Docker local storage' };
                return retentionJSON({ supported: false, error }, request.method === 'GET' ? 200 : 503);
            }
            let body;
            if (request.method !== 'GET') {
                requireSameOrigin(request);
                body = await readJSON(request);
            }
            const result = await action(context, env.RETENTION_SERVICE, body);
            return result instanceof Response ? result : retentionJSON(result);
        } catch (error) {
            const safe = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 && typeof error.code === 'string';
            return retentionJSON({ error: {
                code: safe ? error.code : 'retention_error',
                message: safe ? error.message : 'Unable to process the cleanup request',
            } }, safe ? error.status : 500);
        }
    };
}
