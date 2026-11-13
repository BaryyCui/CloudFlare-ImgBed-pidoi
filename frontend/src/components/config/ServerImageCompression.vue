<template>
    <section class="compression-card" data-testid="compression-card" :aria-busy="loading || saving" aria-labelledby="compression-title">
        <header class="compression-heading">
            <div>
                <h3 id="compression-title"><el-icon><Picture /></el-icon>{{ $t('imageCompression.title') }}</h3>
                <p class="muted">{{ $t('imageCompression.description') }}</p>
            </div>
            <el-tag :type="config.enabled ? 'primary' : 'info'" effect="plain" round>
                {{ config.enabled ? $t('imageCompression.enabled') : $t('imageCompression.disabled') }}
            </el-tag>
        </header>

        <p v-if="!loading && !supported && !loadError" class="compression-notice" data-testid="compression-unsupported" role="status">{{ $t('imageCompression.unsupported') }}</p>
        <el-form :model="draft" :disabled="controlsDisabled" label-position="top" @submit.prevent="save">
            <div class="compression-switch-row">
                <div>
                    <label id="compression-enabled-label">{{ $t('imageCompression.enableLabel') }}</label>
                    <p class="muted small">{{ $t('imageCompression.enableHint') }}</p>
                </div>
                <el-switch v-model="draft.enabled" data-testid="compression-enabled" aria-labelledby="compression-enabled-label" />
            </div>
            <div class="compression-fields">
                <el-form-item :label="$t('imageCompression.threshold')" label-for="compression-threshold">
                    <el-input-number :key="String(controlsDisabled)" id="compression-threshold" v-model="draft.thresholdMB" :min="1" :max="20" :step="0.5" controls-position="right" />
                    <span class="field-hint">{{ $t('imageCompression.thresholdHint') }}</span>
                </el-form-item>
                <el-form-item :label="$t('imageCompression.target')" label-for="compression-target">
                    <el-input-number :key="String(controlsDisabled)" id="compression-target" v-model="draft.targetMB" :min="0.5" :max="20" :step="0.5" controls-position="right" />
                    <span class="field-hint">{{ $t('imageCompression.targetHint') }}</span>
                </el-form-item>
            </div>
            <p class="compression-note"><el-icon><InfoFilled /></el-icon><span>{{ $t('imageCompression.bestEffort') }}</span></p>
            <details class="compression-help">
                <summary>{{ $t('imageCompression.helpTitle') }}</summary>
                <p>{{ $t('imageCompression.formats') }}</p>
                <p>{{ $t('imageCompression.skipped') }}</p>
                <p>{{ $t('imageCompression.units') }}</p>
            </details>
            <div class="compression-actions">
                <el-button type="primary" native-type="submit" data-testid="compression-save" :disabled="controlsDisabled || !dirty" :loading="saving">{{ $t('imageCompression.save') }}</el-button>
                <span class="muted small">{{ dirty ? $t('imageCompression.unsaved') : $t('imageCompression.saveHint') }}</span>
            </div>
        </el-form>
        <Transition name="compression-feedback" mode="out-in">
            <p v-if="loadError || error" key="error" class="compression-notice error-notice" role="alert" data-testid="compression-error">{{ loadError || error }}</p>
            <p v-else-if="success" key="success" class="compression-notice" role="status" data-testid="compression-success">{{ success }}</p>
        </Transition>
    </section>
</template>

<script>
import { InfoFilled, Picture } from '@element-plus/icons-vue';

export default {
    name: 'ServerImageCompression',
    components: { InfoFilled, Picture },
    props: {
        config: { type: Object, required: true },
        supported: { type: Boolean, default: false },
        loading: { type: Boolean, default: false },
        loadError: { type: String, default: '' },
        saveConfig: { type: Function, required: true }
    },
    data() {
        return { draft: { ...this.config }, saving: false, error: '', success: '' };
    },
    computed: {
        dirty() {
            return this.draft.enabled !== this.config.enabled || this.draft.thresholdMB !== this.config.thresholdMB || this.draft.targetMB !== this.config.targetMB;
        },
        controlsDisabled() { return this.loading || !this.supported || !!this.loadError || this.saving; }
    },
    watch: {
        config: { deep: true, handler(config) { this.draft = { ...config }; } },
        draft: { deep: true, handler() { this.success = ''; } }
    },
    methods: {
        async save() {
            if (this.controlsDisabled || !this.dirty) return;
            const { enabled, thresholdMB, targetMB } = this.draft;
            if (typeof enabled !== 'boolean' || !Number.isFinite(thresholdMB) || thresholdMB < 1 || thresholdMB > 20 || !Number.isFinite(targetMB) || targetMB < 0.5 || targetMB > thresholdMB) {
                this.error = this.$t('imageCompression.invalidConfig');
                return;
            }
            this.saving = true;
            this.error = '';
            this.success = '';
            try {
                await this.saveConfig({ enabled, thresholdMB, targetMB });
                await this.$nextTick();
                this.success = this.$t('imageCompression.saved');
            } catch (error) {
                this.error = error.message || this.$t('imageCompression.saveFailed');
            } finally {
                this.saving = false;
            }
        }
    }
};
</script>

<style scoped>
.compression-card {
    padding: 24px;
    margin-bottom: 24px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 14px;
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
}
.compression-heading, .compression-switch-row, .compression-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
}
.compression-heading { align-items: flex-start; margin-bottom: 22px; }
.compression-heading h3 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 17px; font-weight: 600; }
.compression-heading h3 .el-icon { color: var(--el-color-primary); }
.compression-heading .el-tag { flex-shrink: 0; }
.muted { color: var(--el-text-color-secondary); line-height: 1.6; margin: 7px 0 0; font-size: 13px; }
.small { font-size: 12px; }
.compression-switch-row { padding-bottom: 20px; }
.compression-switch-row label { font-size: 14px; font-weight: 500; }
.compression-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; max-width: 640px; }
.compression-fields :deep(.el-input-number) { width: 100%; }
.field-hint { display: block; width: 100%; margin-top: 6px; font-size: 12px; line-height: 1.5; color: var(--el-text-color-secondary); }
.compression-note { display: flex; gap: 8px; margin: 0; font-size: 13px; line-height: 1.7; }
.compression-note .el-icon { flex-shrink: 0; color: var(--el-color-primary); margin-top: 4px; }
.compression-help { margin: 12px 0 20px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
.compression-help summary { width: fit-content; cursor: pointer; color: var(--el-color-primary); }
.compression-help summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 4px; border-radius: 2px; }
.compression-help p { margin: 8px 0 0; max-width: 760px; }
.compression-actions { justify-content: flex-start; flex-wrap: wrap; }
.compression-notice { margin: 16px 0 0; padding: 10px 12px; border-radius: 6px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-size: 13px; line-height: 1.6; }
.compression-notice[data-testid="compression-unsupported"] { margin: 0 0 20px; }
.error-notice { color: var(--el-text-color-primary); background: var(--el-fill-color-light); border-left: 3px solid var(--el-color-primary); }
.compression-feedback-enter-active, .compression-feedback-leave-active { transition: opacity 140ms ease, transform 140ms ease; }
.compression-feedback-enter-from, .compression-feedback-leave-to { opacity: 0; transform: translateY(3px); }
@media (max-width: 600px) {
    .compression-card { padding: 18px 16px; }
    .compression-heading { gap: 10px; }
    .compression-fields { grid-template-columns: 1fr; gap: 0; }
}
@media (prefers-reduced-motion: reduce) {
    .compression-feedback-enter-active, .compression-feedback-leave-active, :deep(.el-switch__core), :deep(.el-switch__action), :deep(.el-button) { transition: none !important; }
    :deep(.is-loading .el-icon) { animation: none !important; }
}
</style>
