const assert = require('node:assert/strict');

describe('Server image compression settings', function () {
    let route;
    before(async () => { route = await import('../functions/api/manage/sysConfig/upload.js'); });
    function fixture(saved, supported = true) {
        let value = saved ? JSON.stringify(saved) : null;
        const db = { async get() { return value; }, async put(key, next) { value = next; } };
        const env = { img_url: db, ...(supported ? { UPLOAD_IMAGE_COMPRESSOR: {} } : {}) };
        return {
            db, env, saved: () => JSON.parse(value),
            post: body => route.onRequest({ env, request: new Request('https://imgbed.test/api/manage/sysConfig/upload', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            }) }),
        };
    }
    it('starts disabled and advertises whether this runtime can compress uploads', async () => {
        const f = fixture();
        const config = await route.getUploadConfig(f.db, f.env);
        assert.deepEqual(config.imageCompression, { enabled: false, thresholdMB: 5, targetMB: 4 });
        assert.equal(config.imageCompressionSupported, true);
        assert.equal((await route.getUploadConfig(f.db, {})).imageCompressionSupported, false);
    });
    it('persists settings while preserving them when an older client saves channels', async () => {
        const f = fixture();
        const policy = { enabled: true, thresholdMB: 3, targetMB: 0.5 };
        assert.equal((await f.post({ imageCompression: policy, s3: { channels: [] } })).status, 200);
        assert.deepEqual(f.saved().imageCompression, policy);
        assert.equal((await f.post({ s3: { channels: [{ name: 'example' }] } })).status, 200);
        assert.deepEqual(f.saved().imageCompression, policy);
        assert.equal(f.saved().s3.channels[0].name, 'example');
    });
    it('rejects malformed settings and larger-than-threshold targets without changing saved settings', async () => {
        const policy = { enabled: false, thresholdMB: 5, targetMB: 4 };
        const f = fixture({ imageCompression: policy });
        for (const invalid of [null, [], {}, { ...policy, enabled: 'true' }, { ...policy, thresholdMB: 0 },
            { ...policy, thresholdMB: 21 }, { ...policy, targetMB: 0.1 }, { ...policy, targetMB: 6 }, { ...policy, targetMB: '2' }]) {
            assert.equal((await f.post({ imageCompression: invalid })).status, 400);
            assert.deepEqual(f.saved().imageCompression, policy);
        }
    });
    it('rejects enabling on an unsupported runtime but still permits disabling', async () => {
        const f = fixture(undefined, false);
        assert.equal((await f.post({ imageCompression: { enabled: true, thresholdMB: 5, targetMB: 4 } })).status, 400);
        assert.equal((await f.post({ imageCompression: { enabled: false, thresholdMB: 5, targetMB: 4 } })).status, 200);
    });
});
