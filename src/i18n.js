import { CATALOGUES, DEFAULT_LOCALE, LOCALES } from "../locales/index.js"

export { DEFAULT_LOCALE, LOCALES }

export const LOCALE_STORAGE_KEY = "khung-thoai-locale"

// Translated attributes are declared next to the source attribute, so the markup keeps a readable
// Vietnamese default and the runtime only needs these four hooks.
export const TRANSLATED_ATTRIBUTES = {
  "data-i18n-title": "title",
  "data-i18n-aria-label": "aria-label",
  "data-i18n-placeholder": "placeholder",
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

export function isLocale(code) {
  return Object.hasOwn(LOCALES, String(code ?? ""))
}

// Anything unknown collapses to Vietnamese, so a stale localStorage value or a removed community
// pack never leaves the interface with no message at all.
export function normalizeLocale(value) {
  const code = String(value ?? "").trim().toLowerCase()
  return isLocale(code) ? code : DEFAULT_LOCALE
}

export function localeMeta(value) {
  return LOCALES[normalizeLocale(value)]
}

export function dateLocale(value) {
  return localeMeta(value).dateLocale
}

export function loadLocale(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY)
    if (saved) return normalizeLocale(saved)
  } catch {
    // Ignore storage errors.
  }
  return DEFAULT_LOCALE
}

export function saveLocale(value, storage = globalThis.localStorage) {
  const normalized = normalizeLocale(value)
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, normalized)
  } catch {
    // Ignore storage errors.
  }
  return normalized
}

export function catalogueKeys(messages) {
  return Object.keys(messages ?? {}).sort()
}

// The parity test and the contributor docs both read this: keys the reference has and a catalogue
// does not, keys a catalogue invented, and keys present but still empty.
export function catalogueDiff(messages, reference = CATALOGUES[DEFAULT_LOCALE]) {
  const expected = new Set(catalogueKeys(reference))
  const actual = new Set(catalogueKeys(messages))
  return {
    missing: [...expected].filter((key) => !actual.has(key)),
    extra: [...actual].filter((key) => !expected.has(key)),
    empty: [...actual].filter((key) => expected.has(key) && !hasText(messages[key])),
  }
}

export function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (placeholder, name) =>
    params[name] === undefined || params[name] === null ? placeholder : String(params[name]))
}

export function placeholders(template) {
  return [...new Set([...String(template ?? "").matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
}

// A key missing from the active catalogue falls back to Vietnamese, and a key missing there too
// renders as the key itself so a half-landed feature is visible instead of blank.
export function translate(locale, key, params = {}, { catalogues = CATALOGUES, fallback = DEFAULT_LOCALE } = {}) {
  const active = catalogues[normalizeLocale(locale)]
  const base = catalogues[normalizeLocale(fallback)]
  const template = hasText(active?.[key]) ? active[key] : hasText(base?.[key]) ? base[key] : key
  return interpolate(template, params)
}

export function createTranslator(locale, options = {}) {
  const code = normalizeLocale(locale)
  return {
    locale: code,
    t: (key, params) => translate(code, key, params, options),
  }
}

const MESSAGE = Symbol.for("khung-thoai-i18n-message")

// A deferred message: the status line keeps the key and the values so a locale switch can redraw
// the text the user is already looking at.
export function msg(key, params = {}) {
  return { [MESSAGE]: true, key, params }
}

export function isMessage(value) {
  return Boolean(value && typeof value === "object" && value[MESSAGE] === true && typeof value.key === "string")
}

function formatWith(locale, value, options, method) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  try {
    return date[method](localeMeta(locale).dateLocale, options)
  } catch {
    return ""
  }
}

// The options stay the caller's choice, so a locale switch changes the calendar conventions and
// never the shape of a date a screen already decided on.
export function formatDate(locale, value, options = {}) {
  return formatWith(locale, value, options, "toLocaleDateString")
}

export function formatTime(locale, value, options = {}) {
  return formatWith(locale, value, options, "toLocaleTimeString")
}

export function formatDateTime(locale, value, options = {}) {
  return formatWith(locale, value, options, "toLocaleString")
}

// Walks the static markup: text nodes through data-i18n, then the three translated attributes.
export function applyTranslations(root, t) {
  if (!root?.querySelectorAll || typeof t !== "function") return 0
  let applied = 0
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n"))
    applied++
  }
  for (const [source, target] of Object.entries(TRANSLATED_ATTRIBUTES)) {
    for (const node of root.querySelectorAll(`[${source}]`)) {
      node.setAttribute(target, t(node.getAttribute(source)))
      applied++
    }
  }
  return applied
}

export function applyDocumentLocale(doc, value) {
  const code = normalizeLocale(value)
  const meta = LOCALES[code]
  if (doc?.documentElement) {
    doc.documentElement.lang = meta.htmlLang
    if (doc.documentElement.dataset) doc.documentElement.dataset.locale = code
  }
  return code
}

export function applyDocumentTitle(doc, t) {
  if (doc && typeof t === "function") doc.title = t("app.title")
  return doc?.title ?? ""
}
