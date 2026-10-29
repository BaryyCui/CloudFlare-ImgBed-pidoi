import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createI18n } from 'vue-i18n';
import zh from '@/locales/zh-CN.json';
import Retention from '../SysCogRetention.vue';
import fetchWithAuth from '@/utils/fetchWithAuth';

vi.mock('@/utils/fetchWithAuth', () => ({ default: vi.fn() }));

const configUrl = '/api/manage/sysConfig/retention';
const previewUrl = '/api/manage/retention/preview';
const runUrl = '/api/manage/retention/run';
const statusUrl = '/api/manage/retention/status';
const config = { enabled: false, retentionDays: 7, runAt: '03:00', timezone: 'Asia/Shanghai', folder: 'videos', version: 1 };
const preview = { previewToken: 'opaque-preview', cutoff: '2026-10-22T19:00:00.000Z', expiresAt: '2026-10-29T20:10:00.000Z', count: 3, bytes: 3145728, samples: [{ key: 'videos/old/image.jpg', bytes: 1048576, uploadedAt: '2026-10-10T10:00:00.000Z' }], skipped: 2 };
const run = { id: 'run-1', status: 'running', trigger: 'manual', startedAt: '2026-10-29T20:00:00.000Z', finishedAt: null, cutoff: preview.cutoff, scanned: 8, eligible: 3, deleted: 1, freedBytes: 1048576, skipped: 2, failed: 0, error: null, failures: [] };
let app;
let container;
let requests;
let status;
let responders;
const reply = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
async function settle() {
  for (let i = 0; i < 12; i++) await nextTick();
  await vi.advanceTimersByTimeAsync(250);
  await nextTick();
}
const element = id => document.querySelector(`[data-testid="${id}"]`);
async function click(id) { element(id).click(); await settle(); }
async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  app = createApp(Retention);
  app.use(ElementPlus).use(createI18n({ legacy: true, locale: 'zh-CN', messages: { 'zh-CN': zh } }));
  app.component('font-awesome-icon', { template: '<svg aria-hidden="true" />' });
  app.mount(container);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T20:00:00.000Z'));
  requests = [];
  status = { supported: true, config: { ...config }, nextRunAt: null, activeRun: null, recentRuns: [], disk: { totalBytes: 1000000000, availableBytes: 500000000 } };
  responders = {};
  fetchWithAuth.mockImplementation(async (url, options = {}) => {
    const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    if (responders[`${request.method} ${url}`]) return responders[`${request.method} ${url}`](request);
    if (url === configUrl || url === statusUrl) return reply(status);
    if (url === previewUrl) return reply(preview);
    if (url === runUrl) return reply({ run }, 202);
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('local retention administrator flow', () => {
  it('loads without a mutation and describes the whole videos subtree', async () => {
    await mount();
    expect(requests).toEqual([{ url: configUrl, method: 'GET', body: undefined }]);
    expect(container.textContent).toContain('videos/');
    expect(container.textContent).toContain('图片、视频和音频');
    expect(element('enabled').querySelector('input').checked).toBe(false);
    expect(document.querySelector('#retention-days').getAttribute('aria-disabled')).toBe('false');
  });

  it('reports an unsuccessful save and keeps the unsaved configuration away from execution', async () => {
    responders[`POST ${configUrl}`] = () => reply({ error: { code: 'retention_error', message: '保存失败：存储不可用' } }, 503);
    await mount();
    await click('enabled');
    await click('save');
    expect(element('error').textContent).toContain('存储不可用');
    expect(element('preview').disabled).toBe(true);
    expect(requests.find(r => r.method === 'POST').body).toEqual({ enabled: true, retentionDays: 7, runAt: '03:00' });
    expect(requests.some(r => r.url === runUrl)).toBe(false);
  });

  it('requires a saved preview and explicit confirmation showing capacity and Shanghai cutoff', async () => {
    await mount();
    await click('preview');
    expect(container.textContent).toContain('3.00 MB');
    expect(container.textContent).toContain('2026-10-23 03:00:00');
    expect(container.textContent).toContain('videos/old/image.jpg');
    expect(requests.some(r => r.url === runUrl)).toBe(false);
    await click('review-run');
    expect(element('confirmation-summary').textContent).toContain('3.00 MB');
    expect(element('confirmation-summary').textContent).toContain('2026-10-23 03:00:00');
    await click('confirm-run');
    expect(requests.filter(r => r.url === runUrl)).toEqual([{ url: runUrl, method: 'POST', body: { previewToken: 'opaque-preview', confirmation: 'DELETE_EXPIRED_FILES' } }]);
    expect(element('active-run').textContent).toContain('1');
    expect(element('preview').disabled).toBe(true);
  });

  it('invalidates preview on edits, then saving configuration never starts deletion', async () => {
    await mount();
    await click('preview');
    await click('enabled');
    expect(element('preview-result')).toBeNull();
    expect(element('preview').disabled).toBe(true);
    responders[`POST ${configUrl}`] = () => reply({ ...status, config: { ...config, enabled: true, version: 2 }, nextRunAt: '2026-10-30T19:00:00.000Z' });
    await click('save');
    expect(element('preview').disabled).toBe(false);
    expect(element('preview-result')).toBeNull();
    expect(requests.some(r => r.url === runUrl)).toBe(false);
  });

  it('refuses a preview that expires while its confirmation is open', async () => {
    await mount();
    await click('preview');
    await click('review-run');
    vi.setSystemTime(new Date('2026-10-29T20:10:01.000Z'));
    await click('confirm-run');
    expect(requests.some(r => r.url === runUrl)).toBe(false);
    expect(element('error').textContent).toContain('预览已过期');
  });

  it('keeps an unchanged saved preview when the idle status refreshes', async () => {
    await mount();
    await click('preview');
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(element('preview-result')).not.toBeNull();
    expect(element('review-run').disabled).toBe(false);
  });

  it('invalidates a preview when another administrator changes the saved configuration', async () => {
    await mount();
    await click('preview');
    status = { ...status, config: { ...config, retentionDays: 14, version: 2 } };
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(element('preview-result')).toBeNull();
    expect(document.querySelector('#retention-days').value).toBe('14');
  });

  it('does not replace unsaved form edits with a background status response', async () => {
    await mount();
    await click('enabled');
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(element('enabled').querySelector('input').checked).toBe(true);
    expect(element('preview').disabled).toBe(true);
  });

  it('shows active progress, polls completion and preserves failure detail in history', async () => {
    status.activeRun = { ...run };
    await mount();
    expect(element('active-run')).not.toBeNull();
    expect(element('active-run').querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('100');
    const completed = { ...run, status: 'partial', deleted: 2, failed: 1, finishedAt: '2026-10-29T20:01:00.000Z', failures: [{ key: 'videos/locked.mp4', reason: 'storage unavailable' }] };
    status = { ...status, activeRun: null, recentRuns: [completed] };
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expect(element('active-run')).toBeNull();
    expect(element('history').textContent).toContain('部分完成');
    expect(element('history').textContent).toContain('videos/locked.mp4');
    expect(element('history').textContent).toContain('storage unavailable');
    const count = requests.length;
    app.unmount(); app = null;
    await vi.advanceTimersByTimeAsync(9000);
    expect(requests).toHaveLength(count);
  });

  it('keeps unsupported environments non-destructive', async () => {
    status = { supported: false, error: { code: 'unsupported_runtime', message: '仅支持 Docker 本地存储' } };
    await mount();
    expect(container.querySelector('[role="status"]').textContent).toBe('仅支持 Docker 本地存储');
    expect(element('save').disabled).toBe(true);
    expect(element('preview').disabled).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('clears an unusable preview after a rejected manual start and shows the server reason', async () => {
    responders[`POST ${runUrl}`] = () => reply({ error: { code: 'preview_changed', message: '文件状态已变化，请重新预览' } }, 409);
    await mount();
    await click('preview');
    await click('review-run');
    await click('confirm-run');
    expect(element('error').textContent).toContain('文件状态已变化');
    expect(element('preview-result')).toBeNull();
    expect(element('active-run')).toBeNull();
  });
});
