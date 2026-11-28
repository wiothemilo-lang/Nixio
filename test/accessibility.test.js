import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

const css = await readFile(new URL("../src/style.css", import.meta.url), "utf8")
const markup = await readFile(new URL("../index.html", import.meta.url), "utf8")
const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"))
  assert.ok(match, `style.css must define ${selector}`)
  return match[1]
}

test("every dialog scrolls on short screens instead of clipping its actions", () => {
  const body = rule("dialog")
  assert.match(body, /max-height:\s*calc\(100dvh - 32px\)/)
  assert.match(body, /overflow:\s*auto/)
  assert.match(body, /overscroll-behavior:\s*contain/)
  assert.match(css, /#find-results, #preflight-issues \{[^}]*min\(40dvh, 220px\)/)
})

test("file picker labels show a focus ring while their sr-only input is focused", () => {
  const body = rule("label:has(> .sr-only:focus-visible), label:has(+ .sr-only:focus-visible)")
  assert.match(body, /outline:\s*2px solid var\(--accent\)/)
  for (const id of ["images", "script-file", "font-file", "catalog-file"]) {
    assert.match(markup, new RegExp(`id="${id}"[^>]*class="[^"]*sr-only|class="[^"]*sr-only[^"]*"[^>]*id="${id}"`), `${id} must stay an sr-only file input`)
  }
})

test("tool rail aria-orientation follows the narrow/mobile layout", () => {
  const rail = markup.match(/<div class="tool-rail"[^>]*>/)
  assert.ok(rail, "index.html must keep the tool rail toolbar")
  assert.match(rail[0], /role="toolbar"/)
  const sync = main.slice(main.indexOf("function syncToolControls("), main.indexOf("\nfunction renderPages("))
  assert.match(sync, /aria-orientation/)
  assert.match(sync, /max-width: 640px/)
  assert.match(sync, /horizontal/)
  assert.match(sync, /vertical/)
  assert.match(main, /matchMedia\("\(max-width: 640px\)"\)\.addEventListener\("change", syncToolControls\)/)
})

test("warning and error notifications tint their icon to match the border", () => {
  const warning = rule(".notif-item.notif-warning .notif-item-icon")
  assert.match(warning, /color:\s*var\(--warn\)/)
  assert.match(warning, /background:\s*var\(--warn-bg\)/)
  const error = rule(".notif-item.notif-error .notif-item-icon")
  assert.match(error, /color:\s*var\(--danger\)/)
  assert.match(error, /background:\s*var\(--danger-bg\)/)
})

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

test("light-mode accent text reaches WCAG 1.4.3 on surface and accent-soft", () => {
  const light = css.slice(css.indexOf(":root {"), css.indexOf(":root[data-theme=\"dark\"]"))
  const accentText = light.match(/--accent-text:\s*(#[0-9a-fA-F]{6})/)
  assert.ok(accentText, ":root must define a text-safe --accent-text")
  const text = accentText[1]
  const accent = light.match(/--accent:\s*(#[0-9a-fA-F]{6})/)[1]
  const accentSoft = light.match(/--accent-soft:\s*(#[0-9a-fA-F]{6})/)[1]
  const surface2 = light.match(/--surface-2:\s*(#[0-9a-fA-F]{6})/)[1]
  assert.ok(contrast(accent, "#ffffff") < 4.5, "test premise: --accent alone must fail 1.4.3")
  assert.ok(contrast(text, "#ffffff") >= 4.5, `--accent-text ${text} on white`)
  assert.ok(contrast(text, accentSoft) >= 4.5, `--accent-text ${text} on --accent-soft`)
  assert.ok(contrast(text, surface2) >= 4.5, `--accent-text ${text} on --surface-2`)
  const accentUses = css.match(/ color: var\(--accent\)/g) ?? []
  assert.equal(accentUses.length, 0, "text color must use --accent-text, not the brand --accent")
  const dark = css.slice(css.indexOf(":root[data-theme=\"dark\"]"))
  assert.match(dark, /--accent-text:\s*var\(--accent\)/)
})

test("fixed drawers and the shell track the measured header height", () => {
  const root = rule(":root")
  assert.match(root, /--header-h:\s*40px/)
  assert.match(rule(".chat-panel"), /top:\s*var\(--header-h, 40px\)/)
  assert.match(rule(".notifications-panel"), /top:\s*calc\(var\(--header-h, 40px\) \+ 6px\)/)
  assert.match(rule(".notifications-panel"), /max-height:\s*min\(500px, calc\(100dvh - var\(--header-h, 40px\) - 24px\)\)/)
  assert.match(rule(".editor-layout"), /height:\s*calc\(100dvh - var\(--header-h, 40px\)\)/)
  assert.match(css, /@media \(max-width: 1020px\)[\s\S]*?min-height:\s*calc\(100dvh - var\(--header-h, 40px\)\)/)
  assert.doesNotMatch(css, /top:\s*40px|top:\s*54px|100dvh - 40px/, "no drawer or shell may keep a hardcoded 40px header offset")
  assert.match(main, /ResizeObserver[\s\S]*--header-h|--header-h[\s\S]*ResizeObserver/)
  assert.match(main, /setProperty\("--header-h"/)
})

test("the compact header keeps every action reachable without wrapping tall", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 640px)"))
  assert.match(narrow, /\.header-actions \{[^}]*flex-wrap:\s*nowrap/)
  assert.match(narrow, /\.header-actions \.button \{[^}]*flex:\s*0 0 auto/)
  assert.match(narrow, /\.header-actions \{[^}]*overflow-x:\s*auto/)
})

test("toasts never swallow clicks meant for the chat composer", () => {
  const toast = rule(".toast")
  assert.match(toast, /pointer-events:\s*none/)
  assert.match(css, /\.toast :is\(\.toast-close, \.button, a\) \{[^}]*pointer-events:\s*auto/)
  assert.match(
    css,
    /body:has\(#chat-panel:not\(\[hidden\]\)\) \.toast-container \{[^}]*top:\s*calc\(var\(--header-h, 40px\) \+ 10px\)[^}]*bottom:\s*auto/,
    "an open chat drawer must move toasts above the composer, not over it",
  )
})
