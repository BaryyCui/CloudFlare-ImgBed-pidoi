import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick } from 'vue';
import ElementPlus from 'element-plus';
import { createI18n } from 'vue-i18n';
import zh from '@/locales/zh-CN.json';
import en from '@/locales/en.json';
import UploadSettings from '../SysCogUpload.vue';
import fetchWithAuth from '@/utils/fetchWithAuth';

vi.mock('@/utils/fetchWithAuth', () => ({ default: vi.fn() }));

const configUrl = '/api/manage/sysConfig/upload';
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let app;
let container;
let config;
let requests;
let postResponse;
let getResponse;

async function settle() {
  for (let i = 0; i < 12; i++) await nextTick();
  await vi.advanceTimersByTimeAsync(250);
  await nextTick();
}
const element = id => document.querySelector(`[data-testid="compression-${id}"]`);
const posts = () => requests.filter(request => request.method === 'POST');
async function click(id) { element(id).click(); await settle(); }
async function input(id, value) {
  const field = document.querySelector(`#compression-${id}`);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  field.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  await settle();
}
async function toggleChannel() {
  container.querySelector('.load-balance-switch .el-switch').click();
  await settle();
}
async function mount(locale = 'zh-CN') {
  container = document.createElement('div');
  document.body.appendChild(container);
  app = createApp(UploadSettings);
  app.use(ElementPlus).use(createI18n({ legacy: true, locale, messages: { 'zh-CN': zh, en } }));
  app.component('font-awesome-icon', { template: '<svg aria-hidden="true" />' });
  app.mount(container);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  config = {
    telegram: { loadBalance: { enabled: false }, channels: [] },
    cfr2: { channels: [] },
    s3: { loadBalance: { enabled: false }, channels: [] },
    discord: { loadBalance: { enabled: false }, channels: [] },
    huggingface: { loadBalance: { enabled: false }, channels: [] },
    webdav: { loadBalance: { enabled: false }, channels: [] },
    imageCompression: { enabled: false, thresholdMB: 5, targetMB: 4 },
    imageCompressionSupported: true,
  };
  getResponse = () => reply(config);
  postResponse = () => reply({ success: true });
  fetchWithAuth.mockImplementation(async (url, options = {}) => {
    const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    if (url === configUrl) return request.method === 'POST' ? postResponse(request) : getResponse();
    if (url === '/api/manage/quota') return reply({ success: true, quotaStats: {} });
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

describe('server image compression upload settings', () => {
  it('hydrates saved values without posting and describes API and URL uploads', async () => {
    config.imageCompression = { enabled: true, thresholdMB: 8, targetMB: 3 };
    await mount();
    expect(posts()).toHaveLength(0);
    expect(element('enabled')?.querySelector('input').checked).toBe(true);
    expect(Number(document.querySelector('#compression-threshold')?.value)).toBe(8);
    expect(Number(document.querySelector('#compression-target')?.value)).toBe(3);
    expect(element('save')?.disabled).toBe(true);
    expect(element('card')?.textContent).toContain('/upload');
    expect(element('card')?.textContent).toContain('URL');
  });

  it('preserves fractional API settings without introducing unsaved changes on load', async () => {
    config.imageCompression = { enabled: true, thresholdMB: 5.125, targetMB: 0.625 };
    await mount();
    expect(Number(document.querySelector('#compression-threshold')?.value)).toBe(5.125);
    expect(Number(document.querySelector('#compression-target')?.value)).toBe(0.625);
    expect(element('save')?.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('saves only on explicit submit and preserves unsaved edits across channel saves', async () => {
    await mount();
    await click('enabled');
    await input('threshold', '8');
    await input('target', '3');
    expect(posts()).toHaveLength(0);
    await toggleChannel();
    expect(posts()[0].body.imageCompression).toEqual({ enabled: false, thresholdMB: 5, targetMB: 4 });
    expect(Number(document.querySelector('#compression-threshold').value)).toBe(8);
    expect(element('save').disabled).toBe(false);
    await click('save');
    expect(posts()[1].body.imageCompression).toEqual({ enabled: true, thresholdMB: 8, targetMB: 3 });
    expect(posts()[1].body.telegram.loadBalance.enabled).toBe(true);
    expect(element('success')?.textContent).toBeTruthy();
    expect(element('save').disabled).toBe(true);
    await toggleChannel();
    expect(posts()[2].body.imageCompression).toEqual({ enabled: true, thresholdMB: 8, targetMB: 3 });
  });

  it('keeps a rejected save visible and retryable without changing saved configuration', async () => {
    postResponse = () => reply({ error: { message: '存储暂时不可用' } }, 503);
    await mount();
    await click('enabled');
    await click('save');
    expect(element('error')?.textContent).toContain('存储暂时不可用');
    expect(element('save').disabled).toBe(false);
    expect(element('success')).toBeNull();
    postResponse = () => reply({ success: true });
    await toggleChannel();
    expect(posts()[1].body.imageCompression.enabled).toBe(false);
    await click('save');
    expect(posts()[2].body.imageCompression.enabled).toBe(true);
    expect(element('error')).toBeNull();
    expect(element('save').disabled).toBe(true);
  });

  it('disables successfully and holds the form while a save is in flight', async () => {
    config.imageCompression.enabled = true;
    let finish;
    postResponse = () => new Promise(resolve => { finish = resolve; });
    await mount();
    await click('enabled');
    await click('save');
    expect(posts()[0].body.imageCompression.enabled).toBe(false);
    expect(element('save').disabled).toBe(true);
    expect(element('enabled').querySelector('input').disabled).toBe(true);
    finish(reply({ success: true }));
    await settle();
    expect(element('enabled').querySelector('input').checked).toBe(false);
    expect(element('enabled').querySelector('input').disabled).toBe(false);
    expect(element('success')?.textContent).toBeTruthy();
  });

  it('serializes an overlapping channel save behind the new compression configuration', async () => {
    let finish;
    postResponse = () => new Promise(resolve => { finish = resolve; });
    await mount();
    await click('enabled');
    await click('save');
    await toggleChannel();
    expect(posts()).toHaveLength(1);
    postResponse = () => reply({ success: true });
    finish(reply({ success: true }));
    await settle();
    expect(posts()).toHaveLength(2);
    expect(posts()[1].body.imageCompression).toEqual({ enabled: true, thresholdMB: 5, targetMB: 4 });
    expect(posts()[1].body.telegram.loadBalance.enabled).toBe(true);
  });

  it('rejects empty or target-above-threshold input before sending a request', async () => {
    await mount();
    await click('enabled');
    await input('threshold', '');
    await click('save');
    expect(posts()).toHaveLength(0);
    expect(element('error')?.textContent).toBeTruthy();
    await input('threshold', '2');
    await click('save');
    expect(posts()).toHaveLength(0);
    expect(element('error')?.textContent).toBeTruthy();
    await input('target', '1');
    await click('save');
    expect(posts()[0].body.imageCompression).toEqual({ enabled: true, thresholdMB: 2, targetMB: 1 });
  });

  it('shows unsupported runtimes without allowing changes in either locale', async () => {
    config.imageCompressionSupported = false;
    await mount('en');
    expect(element('unsupported')?.textContent).toContain('Docker');
    expect(element('enabled')?.querySelector('input').disabled).toBe(true);
    expect(element('save')?.disabled).toBe(true);
    expect(element('card')?.textContent).not.toContain('imageCompression.');
    expect(posts()).toHaveLength(0);
  });

  it('shows configuration load failure without enabling writes', async () => {
    getResponse = () => reply({ error: '配置读取失败' }, 500);
    await mount();
    expect(element('error')?.textContent).toContain('配置读取失败');
    expect(element('save')?.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });

  it('keeps the draft retryable after a network failure', async () => {
    postResponse = () => { throw new Error('Network unavailable'); };
    await mount('en');
    await click('enabled');
    await click('save');
    expect(element('error')?.textContent).toContain('Network unavailable');
    expect(element('save').disabled).toBe(false);
    postResponse = () => reply({ success: true });
    await click('save');
    expect(posts()[1].body.imageCompression.enabled).toBe(true);
    expect(element('success')?.textContent).toBeTruthy();
  });
});
