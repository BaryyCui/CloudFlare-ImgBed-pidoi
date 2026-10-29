<template>
  <section class="retention-settings" :aria-busy="loading">
    <header class="retention-heading">
      <div>
        <p class="eyebrow">{{ $t('retention.eyebrow') }}</p>
        <h2><font-awesome-icon icon="clock" />{{ $t('retention.title') }}</h2>
        <p class="muted">{{ $t('retention.description') }}</p>
      </div>
      <span class="state-pill"><span class="state-dot" :class="{ enabled: savedConfig.enabled }"></span>{{ savedConfig.enabled ? $t('retention.enabled') : $t('retention.disabled') }}</span>
    </header>

    <TransitionGroup name="retention-fade" tag="div">
      <p v-if="error" key="error" role="alert" class="notice error-notice" data-testid="error">{{ error }}</p>
      <p v-if="success" key="success" role="status" class="notice" data-testid="success">{{ success }}</p>
      <p v-if="!loading && !supported && !error" key="unsupported" class="notice" role="status">{{ errorMessage(status.error, $t('retention.unsupported')) }}</p>
    </TransitionGroup>

    <div class="retention-grid">
      <section class="retention-card">
        <h3><font-awesome-icon icon="calendar" />{{ $t('retention.schedule') }}</h3>
        <el-form label-position="top" :model="form" :disabled="controlsDisabled" @submit.prevent="saveSettings">
          <div class="switch-row">
            <div><label id="retention-enable-label">{{ $t('retention.enableLabel') }}</label><p class="muted small">{{ $t('retention.enableHint') }}</p></div>
            <el-switch v-model="form.enabled" data-testid="enabled" aria-labelledby="retention-enable-label" />
          </div>
          <div class="form-grid">
            <el-form-item :label="$t('retention.days')" label-for="retention-days">
              <!-- This Element Plus version sets aria-disabled only at mount. -->
              <el-input-number :key="String(controlsDisabled)" id="retention-days" v-model="form.retentionDays" :min="1" :max="3650" :precision="0" controls-position="right" />
            </el-form-item>
            <el-form-item :label="$t('retention.time')" label-for="retention-time">
              <el-input id="retention-time" v-model="form.runAt" type="time" :aria-label="$t('retention.time')" />
            </el-form-item>
          </div>
          <p class="timezone"><font-awesome-icon icon="globe" />Asia/Shanghai · UTC+08:00</p>
          <div class="next-run"><span>{{ $t('retention.nextRun') }}</span><strong>{{ status.nextRunAt ? formatDate(status.nextRunAt) : $t('retention.notScheduled') }}</strong></div>
          <div class="action-row">
            <el-button type="primary" native-type="submit" data-testid="save" :loading="saving" :disabled="controlsDisabled || !dirty">{{ $t('retention.save') }}</el-button>
            <span class="muted small">{{ dirty ? $t('retention.unsaved') : $t('retention.saveHint') }}</span>
          </div>
        </el-form>
      </section>

      <section class="retention-card scope-card">
        <h3><font-awesome-icon icon="folder" />{{ $t('retention.scope') }}</h3>
        <code class="folder-label">videos/</code>
        <p>{{ $t('retention.scopeDescription') }}</p>
        <p class="muted small">{{ $t('retention.eligibility') }}</p>
        <div v-if="status.disk" class="disk-stats">
          <div><span>{{ $t('retention.availableSpace') }}</span><strong>{{ formatBytes(status.disk.availableBytes) }}</strong></div>
          <div><span>{{ $t('retention.totalSpace') }}</span><strong>{{ formatBytes(status.disk.totalBytes) }}</strong></div>
        </div>
      </section>
    </div>

    <section class="retention-card preview-card">
      <div class="section-heading">
        <div><h3><font-awesome-icon icon="eye" />{{ $t('retention.previewTitle') }}</h3><p class="muted small">{{ $t('retention.previewHint') }}</p></div>
        <el-button data-testid="preview" :loading="previewing" :disabled="controlsDisabled || dirty" @click="previewCleanup"><font-awesome-icon icon="search" />{{ $t('retention.preview') }}</el-button>
      </div>
      <p v-if="dirty" class="muted small">{{ $t('retention.saveBeforePreview') }}</p>
      <Transition name="retention-fade">
      <div v-if="previewResult" key="preview" data-testid="preview-result" class="preview-result">
        <div class="metric-grid">
          <div><span>{{ $t('retention.estimatedFiles') }}</span><strong>{{ previewResult.count }}</strong></div>
          <div><span>{{ $t('retention.estimatedSpace') }}</span><strong>{{ formatBytes(previewResult.bytes) }}</strong></div>
          <div class="cutoff-metric"><span>{{ $t('retention.cutoff') }}</span><strong>{{ formatDate(previewResult.cutoff) }}</strong><small>Asia/Shanghai</small></div>
        </div>
        <p class="muted small">{{ $t('retention.previewSkipped', { count: previewResult.skipped || 0 }) }} · {{ $t('retention.expires', { time: formatDate(previewResult.expiresAt) }) }}</p>
        <div v-if="previewResult.samples?.length" class="sample-list">
          <h4>{{ $t('retention.samples') }}</h4>
          <ul><li v-for="sample in previewResult.samples" :key="sample.key"><span class="file-key">{{ sample.key }}</span><span>{{ formatBytes(sample.bytes) }}</span></li></ul>
        </div>
        <div class="action-row">
          <el-button type="primary" data-testid="review-run" :disabled="!canRun" @click="confirmOpen = true"><font-awesome-icon icon="trash-alt" />{{ $t('retention.reviewRun') }}</el-button>
          <span v-if="previewResult.count === 0" class="muted small">{{ $t('retention.noCandidates') }}</span>
          <span v-else-if="previewExpired" class="muted small">{{ $t('retention.expired') }}</span>
        </div>
      </div>
      <p v-else key="empty" class="empty-state">{{ $t('retention.previewEmpty') }}</p>
      </Transition>
    </section>

    <Transition name="retention-fade">
    <section v-if="status.activeRun" class="retention-card" data-testid="active-run" aria-live="polite">
      <div class="section-heading"><h3><font-awesome-icon icon="sync" />{{ $t('retention.activeRun') }}</h3><span class="state-pill">{{ runStatus(status.activeRun.status) }}</span></div>
      <p class="muted small">{{ $t('retention.startedAt', { time: formatDate(status.activeRun.startedAt) }) }} · {{ triggerLabel(status.activeRun.trigger) }}</p>
      <div class="progress-track" role="progressbar" :aria-label="$t('retention.activeRun')" :aria-valuenow="runProgress" aria-valuemin="0" aria-valuemax="100"><div :style="{ width: `${runProgress}%` }"></div></div>
      <div class="metric-grid run-metrics">
        <div><span>{{ $t('retention.scanned') }}</span><strong>{{ status.activeRun.scanned || 0 }}</strong></div>
        <div><span>{{ $t('retention.deleted') }}</span><strong>{{ status.activeRun.deleted || 0 }} / {{ status.activeRun.eligible || 0 }}</strong></div>
        <div><span>{{ $t('retention.freed') }}</span><strong>{{ formatBytes(status.activeRun.freedBytes) }}</strong></div>
        <div><span>{{ $t('retention.skippedFailed') }}</span><strong>{{ status.activeRun.skipped || 0 }} / {{ status.activeRun.failed || 0 }}</strong></div>
      </div>
    </section>
    </Transition>

    <section class="retention-card" data-testid="history">
      <div class="section-heading"><h3><font-awesome-icon icon="history" />{{ $t('retention.history') }}</h3><el-button text :disabled="loading || refreshing" :loading="refreshing" @click="refreshStatus">{{ $t('retention.refresh') }}</el-button></div>
      <p v-if="!status.recentRuns?.length" class="empty-state">{{ $t('retention.noHistory') }}</p>
      <details v-for="run in status.recentRuns || []" :key="run.id" class="history-run">
        <summary><span class="history-title"><span class="state-pill">{{ runStatus(run.status) }}</span><span>{{ formatDate(run.startedAt) }}</span></span><span class="muted small">{{ $t('retention.runSummary', { count: run.deleted || 0, bytes: formatBytes(run.freedBytes) }) }}</span></summary>
        <dl class="run-details"><div><dt>{{ $t('retention.trigger') }}</dt><dd>{{ triggerLabel(run.trigger) }}</dd></div><div><dt>{{ $t('retention.finished') }}</dt><dd>{{ formatDate(run.finishedAt) }}</dd></div><div><dt>{{ $t('retention.cutoff') }}</dt><dd>{{ formatDate(run.cutoff) }}</dd></div><div><dt>{{ $t('retention.skippedFailed') }}</dt><dd>{{ run.skipped || 0 }} / {{ run.failed || 0 }}</dd></div><div><dt>{{ $t('retention.runId') }}</dt><dd class="file-key">{{ run.id }}</dd></div></dl>
        <p v-if="run.error" class="run-error">{{ run.error }}</p>
        <ul v-if="run.failures?.length" class="failure-list"><li v-for="(failure, index) in run.failures" :key="index"><span class="file-key">{{ failure.key }}</span><span>{{ failure.reason }}</span></li></ul>
      </details>
    </section>

    <el-dialog v-model="confirmOpen" :title="$t('retention.confirmTitle')" class="retention-confirm" width="min(520px, calc(100vw - 32px))" :close-on-click-modal="false" :close-on-press-escape="!starting" :show-close="!starting" append-to-body>
      <div v-if="previewResult" data-testid="confirmation-summary">
        <p>{{ $t('retention.confirmDescription', { count: previewResult.count, bytes: formatBytes(previewResult.bytes) }) }}</p>
        <dl class="confirm-details"><dt>{{ $t('retention.scope') }}</dt><dd><code>videos/</code></dd><dt>{{ $t('retention.cutoff') }}</dt><dd>{{ formatDate(previewResult.cutoff) }}<br>Asia/Shanghai</dd></dl>
        <p class="muted">{{ $t('retention.irreversible') }}</p>
      </div>
      <template #footer><el-button :disabled="starting" @click="confirmOpen = false">{{ $t('retention.cancel') }}</el-button><el-button type="primary" data-testid="confirm-run" :loading="starting" :disabled="!canRun" @click="startCleanup">{{ $t('retention.confirmDelete') }}</el-button></template>
    </el-dialog>
  </section>
</template>

<script>
import fetchWithAuth from '@/utils/fetchWithAuth';

const CONFIG_URL = '/api/manage/sysConfig/retention';
const DEFAULT_CONFIG = { enabled: false, retentionDays: 7, runAt: '03:00', timezone: 'Asia/Shanghai', folder: 'videos' };
const editableConfig = config => ({ enabled: config.enabled, retentionDays: config.retentionDays, runAt: config.runAt });

export default {
  name: 'SysCogRetention',
  data() {
    return {
      status: { supported: false, config: { ...DEFAULT_CONFIG }, nextRunAt: null, activeRun: null, recentRuns: [], disk: null },
      form: editableConfig(DEFAULT_CONFIG), loading: true, saving: false, previewing: false, starting: false, refreshing: false,
      error: '', success: '', previewResult: null, previewExpired: false, confirmOpen: false,
      pollTimer: null, expiryTimer: null, disposed: false,
    };
  },
  computed: {
    supported() { return this.status.supported === true; },
    savedConfig() { return this.status.config || DEFAULT_CONFIG; },
    dirty() { return JSON.stringify(this.form) !== JSON.stringify(editableConfig(this.savedConfig)); },
    controlsDisabled() { return this.loading || !this.supported || this.saving || this.previewing || this.starting || !!this.status.activeRun; },
    canRun() { return !this.controlsDisabled && !this.dirty && !!this.previewResult?.previewToken && this.previewResult.count > 0 && !this.previewExpired; },
    runProgress() {
      const run = this.status.activeRun;
      if (!run?.eligible) return 0;
      return Math.min(100, Math.round(((run.deleted || 0) + (run.skipped || 0) + (run.failed || 0)) / run.eligible * 100));
    },
  },
  watch: {
    form: { deep: true, handler() { this.invalidatePreview(); this.success = ''; } },
  },
  methods: {
    errorMessage(error, fallback) {
      if (typeof error === 'string') return error;
      return typeof error?.message === 'string' ? error.message : fallback;
    },
    async request(url, options = {}) {
      const response = await fetchWithAuth(url, options);
      let body;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) throw new Error(this.errorMessage(body?.error, this.$t('retention.requestFailed', { status: response.status })));
      if (!body || typeof body !== 'object') throw new Error(this.$t('retention.invalidResponse'));
      return body;
    },
    post(url, body = {}) { return this.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    applyStatus(status, adoptConfig = false) {
      if (this.disposed) return;
      const shouldAdopt = adoptConfig || !this.dirty;
      if (status.config?.version !== this.savedConfig.version || status.activeRun) this.invalidatePreview();
      this.status = status;
      if (status.config && shouldAdopt && JSON.stringify(this.form) !== JSON.stringify(editableConfig(status.config))) this.form = editableConfig(status.config);
      this.schedulePoll();
    },
    invalidatePreview() {
      this.previewResult = null;
      this.previewExpired = false;
      this.confirmOpen = false;
      clearTimeout(this.expiryTimer);
    },
    schedulePoll() {
      clearTimeout(this.pollTimer);
      if (!this.disposed && this.supported) this.pollTimer = setTimeout(() => this.refreshStatus(), this.status.activeRun ? 3000 : 30000);
    },
    async refreshStatus() {
      if (this.refreshing || this.disposed) return;
      if (this.saving || this.previewing || this.starting) { this.schedulePoll(); return; }
      this.refreshing = true;
      try {
        this.applyStatus(await this.request('/api/manage/retention/status'));
      } catch (error) {
        if (!this.disposed) this.error = error.message;
        this.schedulePoll();
      } finally { if (!this.disposed) this.refreshing = false; }
    },
    async saveSettings() {
      if (this.controlsDisabled || !this.dirty) return;
      if (!Number.isInteger(this.form.retentionDays) || this.form.retentionDays < 1 || this.form.retentionDays > 3650 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(this.form.runAt)) {
        this.error = this.$t('retention.invalidConfig'); return;
      }
      this.saving = true; this.error = ''; this.success = ''; this.invalidatePreview();
      try {
        const status = await this.post(CONFIG_URL, { ...this.form });
        this.applyStatus(status, true);
        await this.$nextTick();
        if (!this.disposed) this.success = this.$t('retention.saved');
      } catch (error) { if (!this.disposed) this.error = error.message; }
      finally { if (!this.disposed) this.saving = false; }
    },
    async previewCleanup() {
      if (this.controlsDisabled || this.dirty) return;
      this.previewing = true; this.error = ''; this.success = ''; this.invalidatePreview();
      try {
        const preview = await this.post('/api/manage/retention/preview');
        if (!preview.previewToken || !Number.isFinite(preview.count) || !Number.isFinite(preview.bytes) || !Number.isFinite(Date.parse(preview.cutoff)) || !Number.isFinite(Date.parse(preview.expiresAt))) throw new Error(this.$t('retention.invalidResponse'));
        if (this.disposed) return;
        this.previewResult = preview;
        const remaining = Date.parse(preview.expiresAt) - Date.now();
        this.previewExpired = remaining <= 0;
        this.expiryTimer = setTimeout(() => { this.previewExpired = true; }, Math.max(0, remaining));
      } catch (error) { if (!this.disposed) this.error = error.message; }
      finally { if (!this.disposed) this.previewing = false; }
    },
    async startCleanup() {
      if (!this.previewResult || Date.parse(this.previewResult.expiresAt) <= Date.now()) {
        this.error = this.$t('retention.expired'); this.invalidatePreview(); return;
      }
      if (!this.canRun || !this.confirmOpen) return;
      this.starting = true; this.error = ''; this.success = '';
      try {
        const { run } = await this.post('/api/manage/retention/run', { previewToken: this.previewResult.previewToken, confirmation: 'DELETE_EXPIRED_FILES' });
        if (!run?.id) throw new Error(this.$t('retention.invalidResponse'));
        if (this.disposed) return;
        this.invalidatePreview();
        this.status = { ...this.status, activeRun: run };
        this.schedulePoll();
      } catch (error) {
        if (!this.disposed) { this.error = error.message; this.invalidatePreview(); }
      } finally { if (!this.disposed) this.starting = false; }
    },
    formatDate(value) {
      if (!value || !Number.isFinite(Date.parse(value))) return '—';
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
      const part = type => parts.find(item => item.type === type)?.value;
      return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
    },
    formatBytes(value) {
      if (!Number.isFinite(value) || value < 0) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let amount = value; let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
      return `${unit ? amount.toFixed(2) : amount} ${units[unit]}`;
    },
    runStatus(value) { const key = `retention.status.${value}`; return this.$te(key) ? this.$t(key) : value; },
    triggerLabel(value) { return this.$t(value === 'scheduled' ? 'retention.scheduled' : 'retention.manual'); },
  },
  async mounted() {
    try { this.applyStatus(await this.request(CONFIG_URL), true); }
    catch (error) { if (!this.disposed) this.error = error.message; }
    finally { if (!this.disposed) this.loading = false; }
  },
  beforeUnmount() {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    clearTimeout(this.expiryTimer);
  },
};
</script>

<style scoped>
.retention-settings { --retention-blue: #2563eb; --el-color-primary: #2563eb; --el-color-primary-light-3: #6793f2; --el-color-primary-dark-2: #1d4ed8; padding: 24px 0 48px; color: var(--el-text-color-primary, #171717); font-family: inherit; text-align: left; }
.retention-heading, .section-heading, .switch-row, .action-row, .history-title { display: flex; align-items: center; gap: 14px; }
.retention-heading, .section-heading, .switch-row { justify-content: space-between; }
.retention-heading { margin-bottom: 24px; align-items: flex-start; }
h2, h3, h4, p { margin: 0; }
h2, h3 { display: flex; align-items: center; gap: 10px; }
h2 { font-size: 26px; letter-spacing: -.4px; margin: 5px 0 10px; }
h3 { font-size: 16px; font-weight: 600; margin-bottom: 18px; }
h3 svg { color: var(--retention-blue); width: 18px; }
h4 { font-size: 13px; margin-bottom: 8px; }
p { line-height: 1.65; }
.eyebrow { color: var(--retention-blue); font-size: 12px; font-weight: 600; letter-spacing: 1.5px; }
.muted { color: var(--el-text-color-secondary, #666); }
.small { font-size: 12px; }
.state-pill { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; background: color-mix(in srgb, var(--retention-blue) 8%, transparent); border: 1px solid color-mix(in srgb, var(--retention-blue) 18%, transparent); border-radius: 999px; color: var(--el-text-color-primary); font-size: 12px; padding: 5px 10px; }
.state-dot { height: 6px; width: 6px; border-radius: 50%; background: #8b8b8b; }
.state-dot.enabled { background: var(--retention-blue); }
.retention-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; }
.retention-card { background: var(--el-bg-color, #fff); border: 1px solid var(--el-border-color-lighter, #e8e8e8); border-radius: 16px; padding: 24px; margin-bottom: 18px; min-width: 0; }
.switch-row { margin-bottom: 22px; }
.switch-row label { font-weight: 500; font-size: 14px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.form-grid :deep(.el-input-number) { width: 100%; }
.form-grid :deep(.el-form-item) { margin-bottom: 12px; min-width: 0; }
.timezone { display: flex; align-items: center; gap: 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.next-run { display: flex; flex-direction: column; gap: 5px; margin: 20px 0; padding: 14px; background: color-mix(in srgb, var(--retention-blue) 5%, transparent); border-radius: 10px; font-size: 12px; }
.next-run strong { font-size: 14px; font-weight: 500; font-variant-numeric: tabular-nums; }
.action-row { flex-wrap: wrap; }
.folder-label { display: inline-block; font-size: 28px; letter-spacing: -.5px; margin-bottom: 12px; font-weight: 600; }
.scope-card > p + p { margin-top: 10px; }
.disk-stats { display: flex; gap: 28px; margin-top: 24px; border-top: 1px solid var(--el-border-color-lighter); padding-top: 18px; }
.disk-stats > div, .metric-grid > div { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.disk-stats span, .metric-grid span { font-size: 12px; color: var(--el-text-color-secondary); }
.disk-stats strong { font-size: 17px; font-weight: 500; }
.section-heading { margin-bottom: 16px; flex-wrap: wrap; }
.section-heading h3 { margin-bottom: 0; }
.section-heading p { margin-top: 7px; }
.retention-settings :deep(.el-button) { border-radius: 8px; }
.retention-settings :deep(.el-button > span) { gap: 7px; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 20px; margin: 22px 0 16px; }
.metric-grid strong { font-size: 28px; font-weight: 600; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
.metric-grid .cutoff-metric strong { font-size: 18px; letter-spacing: 0; padding-top: 6px; }
.metric-grid small { color: var(--el-text-color-secondary); font-size: 11px; }
.sample-list { margin: 18px 0; }
.sample-list ul, .failure-list { list-style: none; padding: 0; margin: 0; font-size: 12px; }
.sample-list li, .failure-list li { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid var(--el-border-color-lighter); padding: 10px 0; }
.sample-list li > span:last-child { white-space: nowrap; }
.file-key { overflow-wrap: anywhere; word-break: break-word; }
.empty-state { padding: 18px 0 6px; color: var(--el-text-color-secondary); font-size: 13px; }
.notice { padding: 12px 16px; margin-bottom: 18px; background: color-mix(in srgb, var(--retention-blue) 6%, transparent); border: 1px solid color-mix(in srgb, var(--retention-blue) 22%, transparent); border-radius: 10px; font-size: 13px; overflow-wrap: anywhere; }
.error-notice { border-left: 3px solid var(--retention-blue); }
.progress-track { height: 6px; overflow: hidden; border-radius: 3px; margin-top: 18px; background: var(--el-fill-color, #eee); }
.progress-track > div { height: 100%; background: var(--retention-blue); transition: width .3s ease; }
.run-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.run-metrics strong { font-size: 20px; }
.history-run { border-top: 1px solid var(--el-border-color-lighter); padding: 14px 0; }
.history-run summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; cursor: pointer; font-size: 13px; list-style: none; }
.history-run summary::after { content: '+'; color: var(--retention-blue); }
.history-run[open] summary::after { content: '−'; }
.history-title { flex-wrap: wrap; gap: 9px; }
.run-details { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 20px 0 0; font-size: 12px; }
.run-details dt { color: var(--el-text-color-secondary); margin-bottom: 5px; }
.run-details dd { margin: 0; }
.run-error, .failure-list { margin-top: 14px; font-size: 12px; }
.confirm-details { display: grid; grid-template-columns: auto 1fr; gap: 12px 20px; margin: 20px 0; line-height: 1.6; }
.confirm-details dd { margin: 0; overflow-wrap: anywhere; }
.retention-fade-enter-active, .retention-fade-leave-active { transition: opacity .18s ease, transform .18s ease; }
.retention-fade-enter-from, .retention-fade-leave-to { opacity: 0; transform: translateY(5px); }
@media (max-width: 1050px) { .retention-grid { grid-template-columns: 1fr; gap: 0; } }
@media (max-width: 768px) { .retention-settings { padding-top: 18px; } .retention-heading { flex-direction: column; gap: 10px; } h2 { font-size: 23px; } .retention-card { padding: 18px 15px; } .form-grid { grid-template-columns: 1fr; gap: 0; } .metric-grid, .run-metrics { grid-template-columns: 1fr 1fr; gap: 18px 12px; } .cutoff-metric { grid-column: 1 / -1; } .metric-grid strong { font-size: 23px; } .run-details { grid-template-columns: 1fr; } .disk-stats { gap: 20px; } .section-heading { align-items: flex-start; } }
@media (prefers-reduced-motion: reduce) { .progress-track > div { transition: none; } .retention-settings :deep(*) { animation: none !important; transition: none !important; } }
</style>

<style>
@media (prefers-reduced-motion: reduce) {
  .retention-confirm, .retention-confirm * { animation: none !important; transition: none !important; }
}
</style>
