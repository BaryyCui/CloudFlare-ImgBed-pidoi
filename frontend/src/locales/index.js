import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN.json'
import en from './en.json'

const LOCALE_KEY = 'app-locale'
const FALLBACK_LOCALE = 'zh-CN'
const SUPPORTED_LOCALES = new Set(['zh-CN', 'en'])

function normalizeLocale(locale) {
  return SUPPORTED_LOCALES.has(locale) ? locale : null
}

function getStoredLocale() {
  return normalizeLocale(localStorage.getItem(LOCALE_KEY))
}

export function resolveInitialLocale(defaultLocale) {
  return getStoredLocale() || normalizeLocale(defaultLocale) || FALLBACK_LOCALE
}

const i18n = createI18n({
  legacy: true,
  locale: getStoredLocale() || FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  messages: { 'zh-CN': zhCN, en }
})

function applyLocale(locale) {
  i18n.global.locale = locale
  document.documentElement.lang = locale === 'zh-CN' ? 'zh-CN' : 'en'
}

export function initializeLocale(defaultLocale) {
  const locale = resolveInitialLocale(defaultLocale)
  applyLocale(locale)
  return locale
}

export function setLocale(locale) {
  const normalizedLocale = normalizeLocale(locale) || FALLBACK_LOCALE
  applyLocale(normalizedLocale)
  localStorage.setItem(LOCALE_KEY, normalizedLocale)
}

export { LOCALE_KEY, getStoredLocale }
export default i18n
