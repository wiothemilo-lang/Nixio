import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import { CATALOGUES, DEFAULT_LOCALE, LOCALES, LOCALE_MODULES } from "../locales/index.js"
import {
  applyDocumentLocale,
  applyDocumentTitle,
  applyTranslations,
  catalogueDiff,
  catalogueKeys,
  createTranslator,
  dateLocale,
  formatDate,
  interpolate,
  loadLocale,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  placeholders,
  saveLocale,
  translate,
} from "../src/i18n.js"
import { setupLocale } from "../src/controllers/locale.js"

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
    snapshot() { return Object.fromEntries(map) },
  }
}

function element(attributes = {}, textContent = "") {
  const attrs = new Map(Object.entries(attributes))
  return {
    attrs,
    textContent,
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null },
    setAttribute(name, value) { attrs.set(name, String(value)) },
  }
}

function documentStub(nodes = []) {
  return {
    documentElement: { lang: "", dataset: {} },
    title: "",
    nodes,
    createElement() { return { tagName: "OPTION", value: "", textContent: "" } },
    querySelectorAll(selector) {
      const name = /^\[([\w-]+)\]$/.exec(selector)?.[1]
      return name ? nodes.filter((node) => node.attrs.has(name)) : []
    },
  }
}

function selectStub() {
  const listeners = new Map()
  return {
    value: "",
    options: [],
    replaceChildren(...created) { this.options = created },
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type, event) { return listeners.get(type)?.(event) },
  }
}

test("every catalogue covers exactly the Vietnamese key set and never ships an empty value", () => {
  const reference = CATALOGUES[DEFAULT_LOCALE]
  assert.ok(catalogueKeys(reference).length > 100, "the Vietnamese catalogue carries the whole interface")
  for (const code of Object.keys(LOCALES)) {
    const diff = catalogueDiff(CATALOGUES[code], reference)
    assert.deepEqual(diff, { missing: [], extra: [], empty: [] }, `${code} must match the Vietnamese key set`)
  }
  for (const { meta } of LOCALE_MODULES) {
    assert.equal(meta.code, meta.code.toLowerCase())
    assert.ok(meta.label && meta.htmlLang && meta.dateLocale, `${meta.code} describes itself for the picker`)
  }
})

test("translations keep the same placeholders as the Vietnamese template", () => {
  const reference = CATALOGUES[DEFAULT_LOCALE]
  for (const key of catalogueKeys(reference)) {
    const expected = placeholders(reference[key])
    for (const code of Object.keys(LOCALES)) {
      assert.deepEqual(placeholders(CATALOGUES[code][key]), expected, `${code} ${key}`)
    }
  }
})

test("missing keys and missing values fall back to Vietnamese, then to the key itself", () => {
  const partial = { vi: { "status.box.added": "Đã thêm khung chữ." }, en: { "status.box.added": "" } }
  assert.equal(translate("en", "status.box.added", {}, { catalogues: partial }), "Đã thêm khung chữ.")
  assert.equal(translate("en", "status.unknown", { name: "x" }, { catalogues: partial }), "status.unknown")
  assert.equal(translate("xx", "status.box.added", {}, { catalogues: partial }), "Đã thêm khung chữ.")
})

test("interpolation fills known placeholders and leaves unknown ones visible", () => {
  assert.equal(interpolate("Đã xóa {count} khung.", { count: 3 }), "Đã xóa 3 khung.")
  assert.equal(interpolate("{a}-{b}", { a: 0 }), "0-{b}")
  const t = createTranslator("en").t
  assert.match(t("status.box.removedMany", { count: 2 }), /2/)
  assert.match(t("status.preset.saved", { name: "Thoại thường" }), /Thoại thường/)
})

test("the chosen locale persists and an unknown stored value falls back to Vietnamese", () => {
  const storage = memoryStorage()
  assert.equal(loadLocale(storage), "vi")
  assert.equal(saveLocale("ja", storage), "ja")
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), "ja")
  assert.equal(loadLocale(storage), "ja")
  storage.setItem(LOCALE_STORAGE_KEY, "klingon")
  assert.equal(loadLocale(storage), "vi")
  storage.setItem(LOCALE_STORAGE_KEY, " EN ")
  assert.equal(loadLocale(storage), "en", "a stored value follows the same canonicalisation as every other input")
  assert.equal(normalizeLocale("EN"), "en")
  assert.equal(normalizeLocale(undefined), "vi")
})

test("switching the locale re-renders the same markup nodes without a reload", () => {
  const title = element({ "data-i18n": "shortcuts.title" }, "Phím tắt biên tập")
  const findButton = element({ "data-i18n": "header.find" }, "Tìm & thay")
  const titleAttribute = element({ "data-i18n-title": "header.theme.title", title: "Chuyển chế độ Sáng / Tối" })
  const ariaAttribute = element({ "data-i18n-aria-label": "notifications.title", "aria-label": "Trung tâm thông báo" })
  const placeholder = element({ "data-i18n-placeholder": "find.queryPlaceholder", placeholder: "…" })
  const doc = documentStub([title, findButton, titleAttribute, ariaAttribute, placeholder])

  assert.equal(applyDocumentLocale(doc, "vi"), "vi")
  applyTranslations(doc, createTranslator("vi").t)
  assert.equal(title.textContent, "Phím tắt biên tập")
  assert.equal(findButton.textContent, "Tìm & thay")

  applyDocumentLocale(doc, "en")
  const translated = applyTranslations(doc, createTranslator("en").t)
  assert.equal(translated, 5)
  assert.equal(doc.documentElement.lang, "en")
  assert.equal(doc.documentElement.dataset.locale, "en")
  assert.equal(title.textContent, "Editing shortcuts")
  assert.equal(findButton.textContent, "Find & replace")
  assert.equal(titleAttribute.attrs.get("title"), "Switch between light and dark")
  assert.equal(ariaAttribute.attrs.get("aria-label"), "Notifications")
  assert.equal(placeholder.attrs.get("placeholder"), "Type a word or line to find")

  applyDocumentLocale(doc, "ja")
  applyTranslations(doc, createTranslator("ja").t)
  assert.equal(doc.documentElement.lang, "ja")
  assert.equal(title.textContent, CATALOGUES.ja["shortcuts.title"])

  applyDocumentTitle(doc, createTranslator("ja").t)
  assert.equal(doc.title, CATALOGUES.ja["app.title"])
})

test("dates follow the locale instead of a hard-coded vi-VN", () => {
  const at = new Date(2026, 2, 16, 9, 5)
  assert.equal(dateLocale("vi"), "vi-VN")
  assert.equal(dateLocale("en"), "en-GB")
  assert.equal(dateLocale("ja"), "ja-JP")
  assert.equal(formatDate("en", at), at.toLocaleDateString("en-GB"))
  assert.notEqual(formatDate("vi", at), formatDate("en", at))
  assert.equal(formatDate("en", "not a date"), "")
})

test("the locale controller applies the stored locale, persists a switch, and notifies listeners", () => {
  const storage = memoryStorage()
  const select = selectStub()
  const title = element({ "data-i18n": "shortcuts.title" }, "Phím tắt biên tập")
  const doc = documentStub([title])
  const seen = []
  const controller = setupLocale({
    byId: (id) => (id === "locale-select" ? select : null),
    doc,
    storage,
    onChange: (code) => seen.push(code),
  })

  assert.equal(controller.locale, "vi")
  assert.equal(select.value, "vi")
  assert.deepEqual(select.options.map((option) => option.value), ["vi", "en", "ja"])
  assert.equal(title.textContent, "Phím tắt biên tập")

  select.dispatch("change", { target: { value: "en" } })
  assert.deepEqual(seen, ["en"])
  assert.equal(controller.locale, "en")
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), "en")
  assert.equal(title.textContent, CATALOGUES.en["shortcuts.title"])
  assert.equal(controller.t("header.find"), CATALOGUES.en["header.find"])

  select.dispatch("change", { target: { value: "klingon" } })
  assert.equal(controller.locale, "vi", "an unknown choice collapses back to Vietnamese")
  assert.deepEqual(seen, ["en", "vi"])
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), "vi")
})

test("the shipped markup only uses keys the catalogue defines and matches their Vietnamese text", async () => {
  const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
  const decode = (text) => text
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  const sourceAttributes = { "data-i18n-title": "title", "data-i18n-aria-label": "aria-label", "data-i18n-placeholder": "placeholder" }
  const keys = new Set()
  let checked = 0

  for (const match of markup.matchAll(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    const [tag, name, attributes] = match
    const after = markup.slice(match.index + tag.length)
    const content = after.slice(0, Math.max(after.indexOf("<"), 0))
    const closing = after.slice(Math.max(after.indexOf("<"), 0))
    for (const attribute of attributes.matchAll(/data-i18n(-[a-z-]+)?="([^"]+)"/g)) {
      const key = attribute[2]
      const suffix = attribute[1] ?? ""
      const expected = CATALOGUES[DEFAULT_LOCALE][key]
      keys.add(key)
      assert.equal(typeof expected, "string", `index.html uses the unknown key ${key}`)
      if (!suffix) {
        assert.ok(closing.startsWith(`</${name}`), `${key} must stay the whole content of its element`)
        assert.equal(decode(content), expected, `${key} drifted from the Vietnamese catalogue`)
      } else {
        const source = sourceAttributes[`data-i18n${suffix}`]
        const value = attributes.match(new RegExp(`(?:^|\\s)${source}="([^"]*)"`))[1]
        assert.equal(decode(value), expected, `${key} drifted from its ${source} attribute`)
      }
      checked++
    }
  }

  assert.ok(checked >= 80, `index.html carries the chrome and dialogs through data-i18n (${checked} hooks)`)
  assert.ok(keys.has("header.find") && keys.has("shortcuts.title") && keys.has("find.title"))
})
