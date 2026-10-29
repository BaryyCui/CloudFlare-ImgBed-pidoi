'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');
register('../deploy/server/loader.mjs', pathToFileURL(__filename));

function fixture({ supported = true } = {}) {
    const records = new Map();
    records.set('manage@sysConfig@security', JSON.stringify({ apiTokens: { tokens: {
        manager: { token: 'test-manager', permissions: ['manage'], expiresAt: null },
        deleter: { token: 'test-deleter', permissions: ['delete', 'upload'], expiresAt: null },
    } } }));
    for (const role of ['admin', 'user']) records.set(`manage@session@test-${role}`, JSON.stringify({ authType: role, expiresAt: Date.now() + 60000 }));
    const calls = [];
    const status = { supported: true, config: { enabled: false, retentionDays: 7, runAt: '03:00', timezone: 'Asia/Shanghai', folder: 'videos', version: 1 }, activeRun: null, recentRuns: [] };
    const service = {
        async getStatus() { calls.push(['status']); return status; },
        async saveConfig(body) { calls.push(['save', body]); return status; },
        async preview() { calls.push(['preview']); return { previewToken: 'preview-test', count: 2, bytes: 123 }; },
        async startManual(body) { calls.push(['run', body]); return { id: 'run-test', status: 'running' }; },
        async getRun(id) { calls.push(['getRun', id]); return { id, status: 'completed' }; },
    };
    const env = {
        BASIC_USER: 'test-administrator', BASIC_PASS: 'test-admin-password',
        img_url: { async get(key) { return records.get(key) ?? null; }, async put(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } },
        ...(supported ? { RETENTION_SERVICE: service } : {}),
    };
    function context(endpoint, { method = 'GET', role = 'admin', body, headers = {} } = {}) {
        return { env, request: new Request(`https://imgbed.test${endpoint}`, {
            method, headers: { ...(role ? { Cookie: `${role}_session=test-${role}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json', Origin: 'https://imgbed.test' } : {}), ...headers },
            ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
        }) };
    }
    return { env, service, calls, context };
}

describe('Retention management API authorization and contract', function () {
    const paths = {
        config: '/api/manage/sysConfig/retention', preview: '/api/manage/retention/preview',
        run: '/api/manage/retention/run', status: '/api/manage/retention/status',
    };
    let routes;
    before(async () => {
        routes = {};
        for (const [key, route] of Object.entries(paths)) routes[key] = (await import(pathToFileURL(path.resolve(__dirname, '../functions', `${route.slice(1)}.js`)))).onRequest;
    });

    it('rejects anonymous, user sessions and upload/delete-only tokens even when admin credentials are unset', async () => {
        for (const opts of [{ role: null }, { role: 'user' }, { role: null, headers: { Authorization: 'Bearer test-deleter' } }]) {
            const f = fixture();
            delete f.env.BASIC_USER; delete f.env.BASIC_PASS;
            const response = await routes.preview(f.context(paths.preview, { method: 'POST', body: {}, ...opts }));
            assert.equal(response.status, 401);
            assert.deepEqual(f.calls, []);
        }
    });

    it('rejects bootstrap admin sessions issued without configured administrator credentials', async () => {
        const f = fixture();
        delete f.env.BASIC_USER; delete f.env.BASIC_PASS;
        const response = await routes.preview(f.context(paths.preview, { method: 'POST', body: {} }));
        assert.equal(response.status, 401);
        assert.deepEqual(f.calls, []);
    });

    it('allows an administrator to load status and preview without starting cleanup', async () => {
        const f = fixture();
        const response = await routes.config(f.context(paths.config));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).config.enabled, false);
        assert.match(response.headers.get('cache-control'), /no-store/);
        const preview = await routes.preview(f.context(paths.preview, { method: 'POST', body: {} }));
        assert.equal((await preview.json()).count, 2);
        assert.deepEqual(f.calls, [['status'], ['preview']]);
    });

    it('passes saved settings only after checking the request origin', async () => {
        const f = fixture();
        const body = { enabled: true, retentionDays: 14, runAt: '04:30' };
        const bad = await routes.config(f.context(paths.config, { method: 'POST', body, headers: { Origin: 'https://evil.test' } }));
        assert.equal(bad.status, 403);
        assert.deepEqual(f.calls, []);
        const good = await routes.config(f.context(paths.config, { method: 'POST', body }));
        assert.equal(good.status, 200);
        assert.deepEqual(f.calls, [['save', body]]);
    });

    it('accepts the same public host behind TLS termination and rejects a cross-site fetch', async () => {
        const f = fixture();
        const context = f.context(paths.preview, { method: 'POST', body: {} });
        context.request = new Request('http://imgbed.test/api/manage/retention/preview', context.request);
        assert.equal((await routes.preview(context)).status, 200);
        const crossSite = f.context(paths.preview, { method: 'POST', body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.equal((await routes.preview(crossSite)).status, 403);
    });

    it('requires explicit confirmation and a preview token before accepting a manual job', async () => {
        const f = fixture();
        for (const body of [{}, { previewToken: 'preview-test' }, { confirmation: 'DELETE_EXPIRED_FILES' }]) {
            const response = await routes.run(f.context(paths.run, { method: 'POST', body }));
            assert.equal(response.status, 400);
        }
        assert.deepEqual(f.calls, []);
        const body = { previewToken: 'preview-test', confirmation: 'DELETE_EXPIRED_FILES' };
        const response = await routes.run(f.context(paths.run, { method: 'POST', body, role: null, headers: { Authorization: 'Bearer test-manager' } }));
        assert.equal(response.status, 202);
        assert.equal((await response.json()).run.id, 'run-test');
        assert.deepEqual(f.calls, [['run', body]]);
    });

    it('returns explicit unsupported runtime status and never runs a fallback deletion', async () => {
        const f = fixture({ supported: false });
        const response = await routes.config(f.context(paths.config));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).supported, false);
        assert.equal((await routes.preview(f.context(paths.preview, { method: 'POST', body: {} }))).status, 503);
        assert.deepEqual(f.calls, []);
    });

    it('rejects malformed, non-object, non-JSON and oversized mutation bodies', async () => {
        const f = fixture();
        for (const [body, headers, status] of [['{', {}, 400], ['[]', {}, 400], ['{}', { 'Content-Type': 'text/plain' }, 415], [JSON.stringify({ x: 'a'.repeat(17000) }), {}, 413]]) {
            assert.equal((await routes.preview(f.context(paths.preview, { method: 'POST', body, headers }))).status, status);
        }
        assert.deepEqual(f.calls, []);
    });

    it('returns individual run details and rejects unsupported HTTP methods', async () => {
        const f = fixture();
        const response = await routes.status(f.context(paths.status + '?id=run-test'));
        assert.equal((await response.json()).run.id, 'run-test');
        assert.equal((await routes.run(f.context(paths.run))).status, 405);
    });

    it('preserves safe service errors but conceals unexpected internal details', async () => {
        const f = fixture();
        f.service.preview = async () => { throw Object.assign(new Error('Preview expired'), { status: 409, code: 'preview_expired' }); };
        let response = await routes.preview(f.context(paths.preview, { method: 'POST', body: {} }));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'preview_expired');
        f.service.preview = async () => { throw new Error('secret filesystem path and credentials'); };
        response = await routes.preview(f.context(paths.preview, { method: 'POST', body: {} }));
        assert.equal(response.status, 500);
        assert.doesNotMatch(await response.text(), /secret|credentials/);
    });
});
