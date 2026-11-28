import { autoFitBox, clamp, drawPage, makeBox, scanSourceImage, textOverflows } from "./canvas.js"
import { groupDialogue, isImageFile, readDialogueFile, saveFile } from "./io.js"
import { setupLibrary } from "./library.js"
import { matchDialogue, overlapScore, toCoordinates, toRectangle } from "./placement.js"
import { projectPageLimit as pageLimit, projectSettingIds, projectStyle } from "./project.js"
import {
  exportProfilePresets,
  loadGlobalExportProfileId,
  rememberExportProfileId,
  resolveExportProfile,
} from "./export-presets.js"
import { detectAllBubblesOnImage } from "./bubble.js"
import {
  loadGlobalPresets,
  MAX_GLOBAL_PRESETS,
  mergePresets,
  parsePresetsJson,
  PRESET_RESET_DEFAULTS,
  saveGlobalPresets,
  serializePresetsJson,
} from "./presets.js"
import { applyTheme, loadTheme, saveTheme } from "./theme.js"
import { formatDate, formatTime, isMessage, msg } from "./i18n.js"
import { holdFocus } from "./focus.js"
import { compareMode, toggleCompare } from "./compare.js"
import {
  duplicatePage,
  moveSelectedPages,
  pageRangeIds,
  rangeAnchorId,
  selectAllPageIds,
  selectedPages,
  togglePageId,
} from "./page-selection.js"
import { outlineMarks, showsTransformHandles } from "./selection.js"
import {
  clampRect, geometryFromPixels, geometryPixels, resizeHandleLabel, resizeHandles, rotationHandleLabel,
} from "./keyboard-geometry.js"
import { applyBoxText, boxLabel, boxTextError } from "./box-text.js"
import { createTranslationMemoryStore } from "./translation-memory.js"
import { createQaReviewStore } from "./qa-review.js"

import { checkUndoToken, copyEditor, EditHistory, HISTORY_HEAD, HISTORY_START } from "./history.js"
import { cleanupRectangle, paintCleanupMask } from "./cleanup.js"
import { translationLabel } from "./translation.js"
import { resumePending } from "./incremental-translation.js"
import { allFonts, loadCustomFont, registerFontName, restoreCustomFonts } from "./fonts.js"
import { alignBoxes, distributeBoxes, duplicateBox, reorderBox } from "./tools.js"
import { cleanRawPageImage, cleanRawPixels } from "./raw-cleanup.js"
import { smartSlicePageImage, stitchPagesVertically } from "./webtoon.js"
import { createNotificationCenter } from "./notifications.js"
import {
  APP_VERSION,
  RELEASES_PAGE_URL,
  checkAppUpdate,
  dismissUpdateVersion,
  formatBytes,
  openExternalUrl,
} from "./updater.js"

import { defaultLayers } from "./layers.js"
import { setupTasks } from "./controllers/tasks.js"
import { setupProjects } from "./controllers/project.js"
import { setupTranslation } from "./controllers/translation.js"
import { setupOcr } from "./controllers/ocr.js"
import { setupExports } from "./controllers/export.js"
import { setupDialogs } from "./controllers/dialogs.js"
import { setupLayers } from "./controllers/layers.js"
import { setupGestures } from "./controllers/gestures.js"
import { setupShortcuts } from "./controllers/shortcuts.js"
import { setupChat } from "./controllers/chat.js"
import { setupUsage } from "./controllers/usage.js"
import { setupReplay } from "./controllers/replay.js"
import { setupLocale } from "./controllers/locale.js"
import { announce } from "./live-region.js"
import { CREDENTIAL_SETTINGS_CODES, migrateLegacyCredentials } from "./credential-settings.js"
import { createUsageLedger } from "./token-accounting.js"

const history = new EditHistory()
const ownedUrls = new Set()
// One translation memory per editing session: opening or creating a project replaces it, and the
// project manifest is where its pairs are saved.
const translationMemory = createTranslationMemoryStore()
// The QA triage decisions are per project for the same reason: a reopened file restores the board
// exactly as it was left, and a new project starts with an empty one.
const qaReview = createQaReviewStore()
const byId = (id) => document.getElementById(id)
const stage = byId("stage")
const overlays = byId("overlays")
const pageCanvas = byId("page-canvas")
const viewport = byId("viewport")
const form = byId("box-form")
const editorStatus = byId("status")
const exportButtons = [...document.querySelectorAll("[data-export]")]
const state = {
  pages: [], presets: loadGlobalPresets(), pageId: null, boxId: null, selectedBoxIds: new Set(),
  selectedPageIds: new Set(), pageAnchorId: null,
  queue: [], placing: false, fit: true, zoom: null, compareOriginal: false, splitCompare: false,
  compareRestore: "edit", splitPos: 50, cloneSource: null, layerId: null, stroke: null,
  exporting: false, importing: false, translating: false, importingScript: false,
  openingProject: false, processingNative: false, savingProject: false,
  styleGuide: null, defaultFont: "Arial", templateId: null,
}
const projectSettings = projectSettingIds.map(byId)
// The export profile select lists the shipped platform profiles, and a new project starts from the
// profile the user picked last (saved globally, then overridden by whatever a project stores).
const exportProfileField = byId("export-profile")
exportProfileField?.replaceChildren(...exportProfilePresets.map(({ id, name }) => new Option(name, id)))
if (exportProfileField) exportProfileField.value = loadGlobalExportProfileId()
const defaultProjectSettings = projectSettings.map(({ value }) => value)
const exportProfileIndex = exportProfileField ? projectSettings.indexOf(exportProfileField) : -1
// A settings edit is named by the visible label the user actually changed, so the timeline reads
// "Đổi cài đặt Hướng đọc" instead of a generic name.
const settingLabels = new Map(projectSettings.map((field) => [
  field.id,
  document.querySelector(`label[for="${field.id}"]`)?.firstChild?.textContent.trim() || field.id,
]))
let previewRedraw
let cleanRawController = null
let syncLayers = () => {}
// The export summary describes the selected profile; a project switch can change that selection
// without a change event, so onProjectSwitch runs the summary refresh once the export UI exists.
let syncExportProfileSummary = () => {}

// #79: the interface locale is applied before any text is rendered. `t` is the only way a message
// reaches the screen, and a switch re-renders the status line and the theme label in place.
let refreshLocaleViews = () => {}
const i18n = setupLocale({
  byId,
  onChange: () => {
    syncThemeButton()
    refreshStatus()
    refreshLocaleViews()
  },
})
const t = (key, params) => i18n.t(key, params)

let currentTheme = applyTheme(loadTheme())
function syncThemeButton() {
  const btn = byId("toggle-theme")
  if (!btn) return
  const isDark = currentTheme === "dark"
  btn.textContent = isDark ? t("header.theme.light") : t("header.theme.dark")
  btn.setAttribute("aria-pressed", String(isDark))
}
syncThemeButton()
byId("toggle-theme")?.addEventListener("click", () => {
  currentTheme = applyTheme(saveTheme(currentTheme === "dark" ? "light" : "dark"))
  syncThemeButton()
})
let nativeReady = false
let nativeLanguages = []
let formEditSnapshot = null
let shortcuts = null
// Set once the translation controller exists: `render()` also runs before it is created, and the
// panel reads the store through this hook so the page on screen and its suggestions stay in step.
let syncTranslationMemory = () => {}

// One live form session is one action, so its deferred checkpoint keeps a name the timeline and
// the one-click undo can show instead of the generic fallback.
const FORM_EDIT_META = { label: "Sửa khung thoại", kind: "form" }
// A held arrow key is one action too: the debounced checkpoint carries the name of the whole nudge.
const NUDGE_META = { label: "Đẩy khung bằng phím", kind: "nudge" }
// The same rule for the other keyboard geometry gestures, so the timeline names the keys that made
// the change instead of calling every one of them a nudge.
const RESIZE_META = { label: "Co giãn khung bằng phím", kind: "gesture" }
const ROTATE_META = { label: "Xoay khung bằng phím", kind: "gesture" }
// Timeline chips: every kind a checkpoint records today gets a short label, so a row never shows a
// bare kind next to its own specific name.
const historyKindLabels = {
  form: "Khung", box: "Khung", gesture: "Bàn vẽ", nudge: "Phím", page: "Trang", "raw-cleanup": "Raw",
  preset: "Mẫu", template: "Mẫu", settings: "Cài đặt", translate: "Dịch", ocr: "OCR", ai: "AI",
  find: "Tìm", retouch: "Cọ", cleanup: "Nền", layout: "Canh", script: "Kịch bản", text: "Chữ", layer: "Lớp",
  qa: "QA",
}
const alignLabels = { left: "trái", centerX: "giữa ngang", right: "phải", top: "trên", centerY: "giữa dọc", bottom: "dưới" }
const distributeLabels = { horizontal: "ngang", vertical: "dọc" }

const selectedPage = () => state.pages.find((page) => page.id === state.pageId)
const selectedBox = () => selectedPage()?.boxes.find((box) => box.id === state.boxId)
// Every export and the slice dialog read the profile from the project setting, falling back to the
// global default when the field is missing.
function activeExportProfile() {
  try {
    return resolveExportProfile(byId("export-profile")?.value || loadGlobalExportProfileId())
  } catch {
    return resolveExportProfile()
  }
}
const selectedIndex = () => state.pages.findIndex((page) => page.id === state.pageId)

function editorSnapshot() {
  return copyEditor({
    pages: state.pages, queue: state.queue, presets: state.presets,
    pageId: state.pageId, boxId: state.boxId,
    styleGuide: state.styleGuide, fit: state.fit,
    defaultFont: state.defaultFont, templateId: state.templateId,
    // A triage decision is project data an action can change, so undoing "Áp gợi ý QA" has to put
    // the decision back with the text instead of leaving the finding marked fixed.
    qaReview: qaReview.snapshot(),
    settings: Object.fromEntries(projectSettings.map(({ id, value }) => [id, value])),
  })
}

function commitNudgeCheckpoint() {
  return shortcuts ? shortcuts.commitNudge() : false
}

// The open form edit and the pending nudge are both actions of their own, so every path that
// moves the playhead or starts a new action finalizes them first: a delayed nudge timer must never
// record a snapshot taken before a jump on top of the action that jump produced.
function commitLiveFormCheckpoint() {
  commitNudgeCheckpoint()
  if (!formEditSnapshot) return false
  const before = formEditSnapshot
  formEditSnapshot = null
  checkpoint(before, FORM_EDIT_META)
  return true
}

function releaseUnusedImages() {
  const snapshots = [state, ...history.snapshots()]
  const used = new Set(snapshots.flatMap(({ pages }) => pages.flatMap(({ url, originalUrl }) => [url, originalUrl].filter(Boolean))))
  for (const url of ownedUrls) {
    if (used.has(url)) continue
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
  }
}

function checkpoint(snapshot, meta) {
  // A pending nudge owns the state before the newest action, so it is finalized before anything
  // else is recorded: its delayed timer then has nothing left to record.
  commitNudgeCheckpoint()
  if (!snapshot) {
    if (formEditSnapshot) {
      const pending = formEditSnapshot
      formEditSnapshot = null
      projects.changed()
      const token = history.record(pending, { ...FORM_EDIT_META, ...meta })
      syncProjectActions()
      return token
    }
    snapshot = editorSnapshot()
  }
  projects.changed()
  const token = history.record(snapshot, meta)
  syncProjectActions()
  return token
}

function syncSelectionAfterRestore() {
  const page = selectedPage()
  state.selectedBoxIds.clear()
  if (page && state.boxId && page.boxes.some((box) => box.id === state.boxId)) {
    state.selectedBoxIds.add(state.boxId)
  } else {
    state.boxId = null
  }
}

function restoreHistory(direction) {
  if (projectBusy() || gestures.hasGesture()) return
  commitLiveFormCheckpoint()
  const snapshot = history[direction](editorSnapshot())
  if (!snapshot) return
  applyHistorySnapshot(snapshot)
  status(direction === "undo" ? msg("status.undo") : msg("status.redo"))
}

// Undo, redo and a timeline jump all apply a snapshot through one path so selection, project
// settings and asset release stay identical no matter how the playhead moved.
function applyHistorySnapshot(snapshot) {
  const { settings, qaReview: review, ...editor } = snapshot
  projects.changed()
  if (review) qaReview.replace(review)
  Object.assign(state, editor, { placing: false })
  updateFitLabel()
  syncSelectionAfterRestore()
  projectSettings.forEach((field) => { field.value = settings[field.id] })
  render()
  releaseUnusedImages()
}

function pendingHistoryEdit() {
  return Boolean(formEditSnapshot || shortcuts?.hasPendingNudge())
}

// A notification's one-click undo must hit the exact action it describes. Once unrelated
// edits, timeline moves or an in-flight edit take over, it refuses instead of rewinding them.
function undoCleanupAction(token) {
  const check = checkUndoToken(history, token, {
    busy: projectBusy(),
    gesturing: gestures.hasGesture(),
    pending: pendingHistoryEdit(),
  })
  if (!check.ok) {
    status(check.message, true)
    notify({
      kind: "warning",
      title: t("notify.undoFailed.title"),
      message: check.message,
      key: "clean-raw-undo",
    })
    return false
  }
  restoreHistory("undo")
  return true
}

// A row names the state right after its action, while jump() addresses the boundary before an
// action, so the target always comes from the next chronological entry of the unfiltered list.
function historyJumpTarget(rows, row) {
  return rows[row.index + 1]?.id ?? HISTORY_HEAD
}

// A click names its row by the action id captured when the row was drawn, and the target is
// resolved again against the timeline as it stands now. Resolving it from an older list would let
// HISTORY_HEAD point past a checkpoint recorded since the render, restoring a state the user did
// not ask for. A row whose entry was cut by a branch or evicted by the cap resolves to null.
function historyTargetFor(actionId) {
  const rows = history.entries()
  const row = rows.find((item) => item.id === actionId)
  return row ? { id: historyJumpTarget(rows, row), label: row.label } : null
}

// Pending form and nudge edits are committed before the target is resolved, so the jump lands on
// the boundary of the action the user clicked, not on the state the pending edit created.
function jumpToHistoryRow(actionId) {
  if (!prepareHistoryJump()) return false
  const target = historyTargetFor(actionId)
  if (!target) {
    status(msg("status.history.missing"), true)
    syncHistoryPanel()
    return false
  }
  return jumpHistory(target.id, target.label)
}

// The state before the oldest action has no row of its own, so the panel offers it directly.
function jumpToHistoryStart() {
  if (!prepareHistoryJump()) return false
  return jumpHistory(HISTORY_START, "")
}

function historyTime(at) {
  const date = new Date(at)
  const time = formatTime(i18n.locale, date, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  if (date.toDateString() === new Date().toDateString()) return time
  return `${formatDate(i18n.locale, date, { day: "2-digit", month: "2-digit" })} ${time}`
}

function prepareHistoryJump() {
  if (projectBusy()) {
    status(msg("status.history.busy"), true)
    return false
  }
  if (gestures.hasGesture()) {
    status(msg("status.history.gesture"), true)
    return false
  }
  // A form edit or nudge that is still open becomes its own named action before the playhead
  // moves, so a jump never drops what the user just typed and never leaves a delayed timer
  // pointing at a state from before the jump.
  commitLiveFormCheckpoint()
  return true
}

function jumpHistory(id, label = "") {
  const result = history.jump(id, editorSnapshot())
  if (!result.ok) {
    status(
      result.reason === "current" ? msg("status.history.same") : msg("status.history.gone"),
      result.reason !== "current",
    )
    syncHistoryPanel()
    return false
  }
  applyHistorySnapshot(result.snapshot)
  status(
    id === HISTORY_HEAD
      ? msg("status.history.head")
      : label
        ? msg("status.history.after", { label })
        : msg("status.history.start"),
  )
  return true
}

// The panel lists every named action oldest first, marks where the playhead sits and keeps each
// row's jump target independent of the search text: filtering only hides rows, it never
// retargets one, because every target comes from the unfiltered timeline.
function syncHistoryPanel() {
  const list = byId("history-list")
  if (!list || byId("history-panel").hidden) return
  const focused = document.activeElement?.dataset?.historyId ?? ""
  const rows = history.entries()
  const shown = history.entries({ query: byId("history-search").value })
  const applied = rows.filter((row) => row.applied).length
  const current = rows[applied - 1]

  byId("history-current").textContent = !rows.length
    ? "Chưa có thao tác nào."
    : current
      ? `Hiện tại: sau "${current.label}"`
      : "Đang ở mốc lịch sử cũ nhất."
  byId("history-count").textContent = !rows.length
    ? ""
    : shown.length === rows.length
      ? `${rows.length} thao tác`
      : `${shown.length}/${rows.length} thao tác khớp`
  // The oldest boundary has no row of its own, so the direct control reports whether it is already
  // where the playhead sits.
  byId("history-start").disabled = !rows.length || applied === 0
  const empty = byId("history-empty")
  empty.hidden = shown.length > 0
  empty.textContent = rows.length
    ? `Không tìm thấy thao tác khớp "${byId("history-search").value.trim()}".`
    : "Chưa có thao tác nào để hoàn tác."

  list.replaceChildren(...shown.map((row) => {
    const delta = applied - (row.index + 1)
    const button = document.createElement("button")
    button.type = "button"
    button.className = "history-entry"
    button.dataset.historyId = row.id
    if (!row.applied) button.dataset.undone = "true"
    if (!delta) {
      button.setAttribute("aria-current", "true")
      button.disabled = true
    }
    button.setAttribute("aria-label", delta
      ? `${row.label} lúc ${historyTime(row.at)}: ${delta > 0 ? `hoàn tác ${delta} thao tác` : `làm lại ${-delta} thao tác`}`
      : `${row.label} lúc ${historyTime(row.at)}: trạng thái hiện tại`)
    button.onclick = () => jumpToHistoryRow(row.id)

    const label = document.createElement("span")
    label.className = "history-entry-label"
    label.textContent = row.label
    const meta = document.createElement("span")
    meta.className = "history-entry-meta"
    const time = document.createElement("time")
    time.dateTime = new Date(row.at).toISOString()
    time.textContent = historyTime(row.at)
    meta.append(time)
    if (historyKindLabels[row.kind]) {
      const kind = document.createElement("span")
      kind.className = "history-entry-kind"
      kind.textContent = historyKindLabels[row.kind]
      meta.append(kind)
    }
    const move = document.createElement("span")
    move.className = "history-entry-move"
    move.textContent = delta > 0 ? `hoàn tác ${delta}` : delta < 0 ? `làm lại ${-delta}` : "hiện tại"
    meta.append(move)
    button.append(label, meta)
    const li = document.createElement("li")
    li.append(button)
    return li
  }))

  if (!focused) return
  const restored = list.querySelector(`[data-history-id="${focused}"]:not(:disabled)`)
  ;(restored ?? byId("history-search")).focus()
}

function toggleHistoryPanel(open = byId("history-panel").hidden) {
  const panel = byId("history-panel")
  const button = byId("history-toggle")
  panel.hidden = !open
  button.setAttribute("aria-expanded", String(open))
  if (open) {
    syncHistoryPanel()
    byId("history-search").focus()
  } else {
    button.focus()
  }
}

// Enter jumps to the newest matching action that is not the current state: the search narrows
// which action is chosen, never what that action means. Pending edits are committed first, so the
// choice is made on the timeline the panel is about to show.
function jumpToNewestMatch() {
  if (!prepareHistoryJump()) return false
  const rows = history.entries()
  const applied = rows.filter((row) => row.applied).length
  const row = history.entries({ query: byId("history-search").value })
    .filter((item) => applied !== item.index + 1)
    .at(-1)
  if (!row) {
    syncHistoryPanel()
    return status(msg("status.history.noTarget"), true)
  }
  return jumpHistory(historyJumpTarget(rows, row), row.label)
}

byId("history-toggle").onclick = () => toggleHistoryPanel()
byId("history-close").onclick = () => toggleHistoryPanel(false)
byId("history-start").onclick = () => jumpToHistoryStart()
byId("history-search").addEventListener("input", syncHistoryPanel)

// Arrow keys walk the named timeline, Enter jumps, Escape closes the panel and hands focus back
// to the toolbar button that opened it. The panel owns its keys, including undo and redo: while
// the timeline holds focus the search box must not swallow Ctrl+Z as a text edit.
byId("history-panel").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault()
    return toggleHistoryPanel(false)
  }
  if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
    event.preventDefault()
    event.stopPropagation()
    return restoreHistory(event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo")
  }
  if (event.key === "Enter" && event.target === byId("history-search")) {
    event.preventDefault()
    return jumpToNewestMatch()
  }
  // The search box keeps its native caret keys: Home/End and the horizontal arrows belong to the
  // text field, so editing a query never turns into a focus jump inside the list.
  if (event.target === byId("history-search") && ["Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key)) return
  const steps = { ArrowDown: 1, ArrowUp: -1 }
  if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return
  const buttons = [...byId("history-list").querySelectorAll(".history-entry:not(:disabled)")]
  if (!buttons.length) return
  event.preventDefault()
  const from = buttons.indexOf(event.target)
  const next = event.key === "Home" ? 0
    : event.key === "End" ? buttons.length - 1
      : from < 0 ? (steps[event.key] > 0 ? 0 : buttons.length - 1)
        : from + steps[event.key]
  buttons[clamp(next, 0, buttons.length - 1)].focus()
})

function renderFontOptions() {
  const select = byId("box-font")
  const current = select.value
  select.replaceChildren(...allFonts().map((name) => new Option(name, name)))
  if ([...select.options].some((option) => option.value === current)) select.value = current
}

byId("font-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  try {
    const family = await loadCustomFont(file)
    renderFontOptions()
    const box = selectedBox()
    if (box) {
      commitLiveFormCheckpoint()
      checkpoint(undefined, { label: "Đổi phông chữ khung", kind: "form" })
      box.font = family
      byId("box-font").value = family
      renderCanvas()
      renderInspector()
    }
    status(msg("status.font.loaded", { family: family }))
  } catch (error) {
    status(error.message, true)
  }
}

byId("undo").onclick = () => restoreHistory("undo")
byId("redo").onclick = () => restoreHistory("redo")

for (const field of projectSettings) {
  field.addEventListener("input", () => { projects.changed() })
  let before
  field.addEventListener("focus", () => { before = editorSnapshot() })
  field.addEventListener("change", () => {
    if (before && before.settings[field.id] !== field.value) {
      checkpoint(before, { label: `Đổi cài đặt ${settingLabels.get(field.id) ?? field.id}`, kind: "settings" })
    }
    before = editorSnapshot()
    syncTranslationActions()
  })
}

// The project keeps its own profile, and the last choice becomes the default for new projects:
// rememberExportProfileId also moves the snapshot startNewProject() resets the form from.
byId("export-profile")?.addEventListener("change", (event) => {
  rememberExportProfileId(event.currentTarget.value, defaultProjectSettings, exportProfileIndex)
})

let statusDescriptor = null

// A msg() descriptor renders in the active locale and is remembered, so a locale switch redraws
// the line the user is reading instead of leaving it in the previous language.
function status(message, error = false) {
  statusDescriptor = isMessage(message) ? message : null
  editorStatus.textContent = statusDescriptor ? t(statusDescriptor.key, statusDescriptor.params) : String(message ?? "")
  editorStatus.toggleAttribute("data-error", error)
}

function refreshStatus() {
  if (statusDescriptor) editorStatus.textContent = t(statusDescriptor.key, statusDescriptor.params)
}

function listButton(text, onClick, label = text) {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = text
  button.setAttribute("aria-label", label)
  button.onclick = onClick
  return button
}

function setView() {
  const library = location.hash === "#library"
  byId("editor").hidden = library
  byId("library").hidden = !library
  document.querySelectorAll("nav a[data-view]").forEach((link) => {
    if ((link.dataset.view === "library") === library) link.setAttribute("aria-current", "page")
    else link.removeAttribute("aria-current")
  })
}
window.addEventListener("hashchange", setView)
if (typeof matchMedia === "function") {
  matchMedia("(max-width: 640px)").addEventListener("change", syncToolControls)
}
// The header wraps on narrow screens, so fixed drawers and the shell height track its real
// measured height through --header-h instead of assuming the desktop 48px.
const appHeader = document.querySelector(".app-header")
if (appHeader && typeof ResizeObserver === "function") {
  const syncHeaderHeight = () => {
    document.documentElement.style.setProperty("--header-h", `${appHeader.offsetHeight}px`)
  }
  new ResizeObserver(syncHeaderHeight).observe(appHeader)
  syncHeaderHeight()
}
setView()

// Nixio #106: the page toolbar changes its index silently, so a page change is announced with the
// name the page list shows instead of only its position.
function pageAnnouncement() {
  const index = selectedIndex()
  return index < 0
    ? t("status.page.none")
    : t("status.page.position", { index: index + 1, total: state.pages.length, name: state.pages[index].name })
}

function selectPage(page, { preserveSelection = false } = {}) {
  commitLiveFormCheckpoint()
  const aborted = gestures.abortGesture()
  if (aborted) {
    const { settings, ...editor } = aborted
    Object.assign(state, editor)
    updateFitLabel()
    page = state.pages.find((item) => item.id === page?.id)
  }
  state.pageId = page?.id ?? null
  state.pageAnchorId = state.pageId
  if (!preserveSelection) state.selectedPageIds.clear()
  state.boxId = null
  state.selectedBoxIds.clear()
  state.placing = false
  state.cloneSource = null
  render()
  announce(pageAnnouncement())
}

function changePage(delta) {
  const page = state.pages[selectedIndex() + delta]
  if (page) selectPage(page)
}

// Bulk page selection (#74): the set is additive UI state — the primary page keeps feeding the
// inspector while the set names what a bulk action touches. Nothing here is checkpointed; only the
// actions below record history.
function selectedPagesInOrder() {
  return selectedPages(state.pages, state.selectedPageIds)
}

function togglePageSelection(page) {
  state.selectedPageIds = togglePageId(state.selectedPageIds, page.id)
  state.pageAnchorId = page.id
  renderPages()
}

function shiftSelectPage(page) {
  commitLiveFormCheckpoint()
  const anchor = rangeAnchorId(state.pages, state.pageAnchorId, state.pageId)
  const ids = pageRangeIds(state.pages, anchor, page.id)
  state.selectedPageIds = new Set(ids)
  state.pageAnchorId = page.id
  // Shift-range moves the primary with the click so the inspector follows, without collapsing
  // the range the way a plain selectPage would.
  selectPage(page, { preserveSelection: true })
}

function pageNameClick(page, event) {
  if (event.ctrlKey || event.metaKey) return togglePageSelection(page)
  if (event.shiftKey) return shiftSelectPage(page)
  selectPage(page)
}

function selectAllPages() {
  state.selectedPageIds = selectAllPageIds(state.pages)
  renderPages()
  status(`Đã chọn cả ${state.pages.length} trang.`)
}

function clearPageSelection() {
  if (!state.selectedPageIds.size) return
  state.selectedPageIds.clear()
  renderPages()
  status("Đã bỏ chọn trang.")
}

// Space on a focused page name toggles that page's membership, the keyboard twin of Ctrl+click.
// The name button keeps Enter for plain navigation; Space is claimed before the native click.
byId("pages").addEventListener("keydown", (event) => {
  if (event.key !== " " || event.repeat) return
  const name = event.target.closest?.(".page-name")
  if (!name || !byId("pages").contains(name)) return
  const page = state.pages.find((item) => item.id === name.dataset.pageId)
  if (!page) return
  event.preventDefault()
  togglePageSelection(page)
})

function movePage(index, delta) {
  if (projectBusy()) return
  const target = index + delta
  if (target < 0 || target >= state.pages.length) return
  checkpoint(undefined, { label: `Đổi thứ tự trang ${state.pages[index].name}`, kind: "page" })
  const [page] = state.pages.splice(index, 1)
  state.pages.splice(target, 0, page)
  renderPages()
  const button = document.getElementById("move-" + page.id + "-" + delta)
  const fallback = document.getElementById("move-" + page.id + "-" + -delta)
  ;(button && !button.disabled ? button : fallback)?.focus()
}

function removePage(index) {
  if (projectBusy()) return
  checkpoint(undefined, { label: `Bỏ trang ${state.pages[index]?.name ?? ""}`, kind: "page" })
  const [page] = state.pages.splice(index, 1)
  if (!page) return
  if (page.id === state.pageId) selectPage(state.pages[Math.min(index, state.pages.length - 1)])
  else renderPages()
  status(msg("status.page.removed", { name: page.name }))
}

// Every bulk action refuses while a task runs: a half-applied batch would be worse than a clear
// refusal, and each action still goes through the same checkpoint path as its single-page twin so
// undo, redo and the dirty marker stay correct.
function refuseWhileBusy() {
  if (!projectBusy()) return false
  status("Hãy chờ tác vụ hiện tại hoàn tất rồi thao tác trên nhiều trang.", true)
  return true
}

function removeSelectedPages() {
  if (refuseWhileBusy()) return
  const pages = selectedPagesInOrder()
  if (!pages.length) return status("Hãy chọn trang cần xóa.", true)
  const first = state.pages.indexOf(pages[0])
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Bỏ ${pages.length} trang`, kind: "page" })
  const ids = new Set(pages.map((page) => page.id))
  state.pages = state.pages.filter((page) => !ids.has(page.id))
  state.selectedPageIds.clear()
  if (ids.has(state.pageId)) selectPage(state.pages[Math.min(first, state.pages.length - 1)])
  else renderPages()
  status(`Đã bỏ ${pages.length} trang.`)
}

function duplicateSelectedPages() {
  if (refuseWhileBusy()) return
  const pages = selectedPagesInOrder()
  if (!pages.length) return status("Hãy chọn trang cần nhân bản.", true)
  if (state.pages.length + pages.length > pageLimit) {
    return status(`Nhân bản sẽ vượt giới hạn ${pageLimit} trang.`, true)
  }
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Nhân bản ${pages.length} trang`, kind: "page" })
  const copies = new Map(pages.map((page) => [page.id, duplicatePage(page)]))
  state.pages = state.pages.flatMap((page) => {
    const copy = copies.get(page.id)
    return copy ? [page, copy] : [page]
  })
  state.selectedPageIds = new Set(copies.values().map((page) => page.id))
  renderPages()
  status(`Đã nhân bản ${pages.length} trang.`)
}

function moveSelectedPagesBy(delta) {
  if (refuseWhileBusy()) return
  if (!state.selectedPageIds.size) return status("Hãy chọn trang cần di chuyển.", true)
  const next = moveSelectedPages(state.pages, state.selectedPageIds, delta)
  if (!next) {
    return status(delta < 0 ? "Các trang đã chọn đang ở đầu danh sách." : "Các trang đã chọn đang ở cuối danh sách.")
  }
  commitLiveFormCheckpoint()
  checkpoint(undefined, {
    label: `Dời ${state.selectedPageIds.size} trang ${delta < 0 ? "lên" : "xuống"}`,
    kind: "page",
  })
  state.pages = next
  renderPages()
}

function projectBusy() {
  return state.openingProject || state.importing || state.importingScript || state.translating || state.exporting || state.processingNative || state.savingProject
}

function syncProjectActions() {
  byId("undo").disabled = projectBusy() || !history.past.length
  byId("redo").disabled = projectBusy() || !history.future.length
  byId("open-project").disabled = projectBusy()
  byId("save-project").disabled = projectBusy()
  byId("new-project").disabled = projectBusy()
  byId("open-templates").disabled = projectBusy()
  byId("open-find").disabled = projectBusy()
  byId("open-style-guide").disabled = projectBusy()
  byId("recent-projects-button").disabled = projectBusy()
  byId("images").disabled = projectBusy()
  byId("script-file").disabled = projectBusy()
  syncHistoryPanel()
}

let chat
function syncTranslationActions() {
  const settings = translation.settings()
  byId("resume-translation").disabled = projectBusy() || !resumePending(state.pages, settings)
  byId("pages").querySelectorAll(".page-job").forEach((element, index) => {
    const page = state.pages[index]
    element.dataset.state = page.translationJob?.state ?? "pending"
    element.textContent = translationLabel(page, settings)
  })
  syncTranslationMemory()
  chat?.refreshModelBadge()
}

function syncToolControls() {
  const toolRail = byId("tool-rail")
  if (toolRail && typeof matchMedia === "function") {
    toolRail.setAttribute("aria-orientation", matchMedia("(max-width: 640px)").matches ? "horizontal" : "vertical")
  }
  const select = byId("cleanup-tool")
  const tool = select.value
  const page = selectedPage()
  const hasRetouch = Boolean(page?.retouchStrokes?.length)
  const isBrushTool = ["erase", "restore", "paint", "clone", "inpaint", "retouch-erase"].includes(tool)
  const activeLabel = byId("active-tool-label")
  if (activeLabel) activeLabel.textContent = select.selectedOptions?.[0]?.textContent || tool
  document.querySelectorAll("#tool-rail .rail-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.tool === tool))
  })
  if (byId("brush-size-field")) byId("brush-size-field").hidden = !isBrushTool
  byId("paint-color-field").hidden = tool !== "paint"
  byId("paint-opacity-field").hidden = !["paint", "clone", "inpaint", "retouch-erase"].includes(tool)
  if (byId("clone-seamless-field")) byId("clone-seamless-field").hidden = tool !== "clone"
  byId("clean-raw").disabled = projectBusy() || !page
  const cleanAllBtn = byId("clean-raw-all")
  if (cleanAllBtn) {
    cleanAllBtn.textContent = cleanRawController ? "Dừng làm sạch" : "Làm sạch cả chương"
    cleanAllBtn.disabled = cleanRawController ? false : (projectBusy() || !state.pages.length)
  }
  const detectBtn = byId("detect-bubbles")
  if (detectBtn) detectBtn.disabled = projectBusy() || !page
  byId("undo-retouch").hidden = !hasRetouch
  byId("clear-retouch").hidden = !hasRetouch
  byId("undo-retouch").disabled = projectBusy() || !hasRetouch
  byId("clear-retouch").disabled = projectBusy() || !hasRetouch
  byId("eyedropper-readout").hidden = tool !== "eyedropper" || !byId("eyedropper-readout").textContent
}

function renderPages() {
  const restoreFocus = holdFocus(byId("pages"))
  projects.refreshDirty()
  // Undo, project switches and page removal can leave ids behind; the set only ever names pages
  // that exist right now.
  for (const id of state.selectedPageIds) {
    if (!state.pages.some((page) => page.id === id)) state.selectedPageIds.delete(id)
  }
  const current = selectedIndex()
  const count = state.pages.length
  const settings = translation.settings()
  if (!state.importing && !state.openingProject) releaseUnusedImages()
  byId("page-count").textContent = count + " / " + pageLimit
  byId("page-indicator").textContent = current === -1 ? "Chưa có trang" : `Trang ${current + 1} / ${count}`
  byId("prev-page").disabled = current <= 0
  byId("next-page").disabled = current < 0 || current >= count - 1
  byId("apply-script").disabled = current < 0 || projectBusy()
  byId("export-script").disabled = !count || projectBusy()
  byId("translate-boxes").disabled = current < 0 || !(selectedPage()?.boxes.length) || projectBusy()
  byId("translate").disabled = current < 0 || projectBusy()
  byId("align-script").disabled = current < 0 || projectBusy()
  byId("translate-all").disabled = !count || projectBusy()
  byId("fit-page").disabled = current < 0
  byId("zoom-in").disabled = current < 0
  byId("zoom-out").disabled = current < 0
  byId("compare-original").disabled = current < 0
  if (byId("split-compare")) byId("split-compare").disabled = current < 0
  byId("add-box").disabled = current < 0 || projectBusy()
  byId("autofit-page").disabled = current < 0 || !(selectedPage()?.boxes.length) || projectBusy()
  byId("export-all").disabled = !count || projectBusy()
  exportButtons.forEach((button) => { button.disabled = current < 0 || projectBusy() })
  syncProjectActions()
  syncToolControls()
  byId("box-form").inert = projectBusy()
  projectSettings.forEach((field) => { field.disabled = state.translating || state.openingProject })
  byId("resume-translation").disabled = projectBusy() || !resumePending(state.pages, settings)
  byId("stop-translation").disabled = !state.translating
  renderPresets()
  byId("check-export").disabled = projectBusy()
  byId("preview-ocr").disabled = projectBusy() || current < 0 || !nativeReady
  byId("run-local-ocr").disabled = projectBusy() || current < 0 || !nativeLanguages.length
  byId("cleanup-expand").disabled = projectBusy()
  if (byId("cleanup-mode")) byId("cleanup-mode").disabled = projectBusy()
  if (byId("open-webtoon")) byId("open-webtoon").disabled = projectBusy() || !count
  byId("pages").replaceChildren(...state.pages.map((page, index) => {
    const li = document.createElement("li")
    if (state.selectedPageIds.has(page.id)) li.classList.add("page-selected")
    const check = document.createElement("input")
    check.type = "checkbox"
    check.className = "page-check"
    check.checked = state.selectedPageIds.has(page.id)
    check.setAttribute("aria-label", `Chọn ${page.name} để thao tác hàng loạt`)
    check.dataset.focusKey = "page-check:" + page.id
    check.onchange = () => togglePageSelection(page)
    const button = listButton(`${index + 1}. ${page.name}`, (event) => pageNameClick(page, event))
    button.className = "page-name"
    button.dataset.focusKey = "page:" + page.id
    button.dataset.pageId = page.id
    if (current === index) button.setAttribute("aria-current", "true")
    const up = listButton("↑", () => movePage(index, -1), "Đưa lên " + page.name)
    up.disabled = index === 0 || projectBusy()
    up.id = "move-" + page.id + "--1"
    up.dataset.focusKey = "page-up:" + page.id
    const down = listButton("↓", () => movePage(index, 1), "Đưa xuống " + page.name)
    down.disabled = index === count - 1 || projectBusy()
    down.id = "move-" + page.id + "-1"
    down.dataset.focusKey = "page-down:" + page.id
    const remove = listButton("×", () => removePage(index), "Bỏ " + page.name)
    remove.disabled = projectBusy()
    remove.dataset.focusKey = "page-remove:" + page.id
    const job = document.createElement("span")
    job.className = "page-job"
    job.dataset.state = page.translationJob?.state ?? "pending"
    job.textContent = translationLabel(page, settings)
    li.append(check, button, up, down, remove, job)
    return li
  }))
  syncPageBulkBar()
  restoreFocus()
}

// The bulk bar stays reachable even with nothing selected so select-all/clear are always one Tab
// away; the five actions only arm once the set names at least one page and no task is running.
function syncPageBulkBar() {
  const bar = byId("page-bulk-bar")
  if (!bar) return
  const selected = state.selectedPageIds.size
  const busy = projectBusy()
  bar.hidden = !state.pages.length
  byId("page-bulk-count").textContent = selected
    ? `Đã chọn ${selected} trang`
    : "Chọn trang để thao tác hàng loạt."
  const armed = selected > 0 && !busy
  for (const id of ["bulk-translate", "bulk-duplicate", "bulk-export", "bulk-delete"]) {
    byId(id).disabled = !armed
  }
  byId("bulk-move-up").disabled = !armed || !moveSelectedPages(state.pages, state.selectedPageIds, -1)
  byId("bulk-move-down").disabled = !armed || !moveSelectedPages(state.pages, state.selectedPageIds, 1)
  byId("bulk-select-all").disabled = selected === state.pages.length
  byId("bulk-clear").disabled = !selected
}

function rectStyle(element, rect) {
  for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.w, height: rect.h })) {
    element.style[name] = value * 100 + "%"
  }
  element.style.transform = rect.rotation ? `rotate(${rect.rotation}deg)` : ""
}

function paintPreview(page) {
  // Compare mode hides every layer; otherwise the layer stack decides what shows and in what order.
  const showLayers = !state.compareOriginal
  const pending = drawPage(pageCanvas, page, { showCleanup: showLayers, showText: showLayers })
  if (!pending || previewRedraw === pending) return
  previewRedraw = pending
  pending.then(() => {
    if (previewRedraw !== pending) return
    previewRedraw = null
    if (selectedPage() === page) paintPreview(page)
  })
}

function syncSplitCompare(page) {
  const active = Boolean(page && state.splitCompare && !state.compareOriginal)
  const compareCanvas = byId("compare-canvas")
  const handle = byId("split-handle")
  const splitBtn = byId("split-compare")
  if (splitBtn) splitBtn.setAttribute("aria-pressed", String(active))
  stage.classList.toggle("split-comparing", active)
  stage.style.setProperty("--split-pos", `${state.splitPos}%`)
  if (!compareCanvas || !handle) return
  compareCanvas.hidden = !active
  handle.hidden = !active
  handle.setAttribute("aria-valuenow", String(Math.round(state.splitPos)))
  handle.setAttribute("aria-valuetext", `Rèm ở ${Math.round(state.splitPos)}%`)
  if (active && page?.image) {
    // The left pane is the original scan: a raw-cleaned page keeps it in `originalImage`, while the
    // working `image` is the cleaned copy and would make the comparison show the same scan twice.
    const source = scanSourceImage(page, { showCleanup: false })
    const w = source.naturalWidth
    const h = source.naturalHeight
    if (compareCanvas.width !== w || compareCanvas.height !== h) {
      compareCanvas.width = w
      compareCanvas.height = h
    }
    compareCanvas.getContext("2d").drawImage(source, 0, 0)
  }
}

function renderCanvas() {
  const restoreFocus = holdFocus(overlays)
  gestures.cancelPendingPaint()
  const page = selectedPage()
  const tool = byId("cleanup-tool").value
  stage.hidden = !page
  byId("canvas-empty").hidden = Boolean(page)
  byId("add-box").setAttribute("aria-pressed", String(state.placing))
  byId("compare-original").setAttribute("aria-pressed", String(state.compareOriginal))
  stage.classList.toggle("placing", state.placing)
  stage.classList.toggle("panning", tool === "pan" || gestures.getSpaceHeld())
  stage.classList.toggle("eyedropper", tool === "eyedropper")
  stage.classList.toggle("bubble", tool === "bubble")
  stage.classList.toggle("cleaning", tool !== "text" && tool !== "pan" && tool !== "eyedropper" && tool !== "bubble")
  if (!page) {
    overlays.replaceChildren()
    pageCanvas.width = 1
    pageCanvas.height = 1
    syncSplitCompare(null)
    gestures.updateZoomDisplay()
    return
  }
  const stageWidth = state.zoom
    ? Math.max(120, Math.round(page.image.naturalWidth * state.zoom))
    : Math.min(page.image.naturalWidth, state.fit ? 720 : Infinity)
  stage.style.width = stageWidth + "px"
  stage.style.maxWidth = state.fit && !state.zoom ? "100%" : "none"
  stage.style.flexShrink = state.fit && !state.zoom ? "1" : "0"
  // The zoom readout reports the measured scale, so it has to run after the stage is resized.
  gestures.updateZoomDisplay()
  paintPreview(page)

  overlays.replaceChildren(...page.boxes.map((box) => {
    const outline = document.createElement("div")
    outline.className = "outline"
    outline.setAttribute("role", "button")
    outline.setAttribute("tabindex", "0")
    outline.setAttribute("aria-label", boxLabel(box))
    outline.dataset.box = box.id
    outline.dataset.focusKey = "box:" + box.id
    // The primary keeps its own marker inside a multi-selection, so the group highlight never hides
    // which box the inspector edits.
    const marks = outlineMarks({ id: box.id, boxId: state.boxId, selectedIds: state.selectedBoxIds })
    if (marks.primary) outline.setAttribute("aria-current", "true")
    if (marks.multi) outline.classList.add("multi-selected")
    outline.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault()
        selectBox(box)
      }
    })
    rectStyle(outline, box)
    if (showsTransformHandles({ marks, tool, placing: state.placing, compareOriginal: state.compareOriginal })) {
      // The handles are the keyboard's resize controls: each is a focusable button named after the
      // edge it moves, and its stable focus key keeps focus on the same handle across a rebuild.
      for (const handle of resizeHandles) {
        const dot = document.createElement("span")
        dot.className = "resize-handle"
        dot.dataset.handle = handle
        dot.dataset.focusKey = `handle:${box.id}:${handle}`
        dot.setAttribute("role", "button")
        dot.setAttribute("tabindex", "0")
        dot.setAttribute("aria-label", resizeHandleLabel(handle))
        dot.title = `${resizeHandleLabel(handle)} — mũi tên để co giãn 1 px (Shift: 10 px)`
        outline.append(dot)
      }
      const rot = document.createElement("span")
      rot.className = "rotate-handle"
      rot.dataset.focusKey = `rotate:${box.id}`
      rot.setAttribute("role", "button")
      rot.setAttribute("tabindex", "0")
      rot.setAttribute("aria-label", rotationHandleLabel())
      rot.title = "Kéo để xoay (giữ Shift theo nấc 15°); mũi tên trái/phải khi đang chọn: xoay 15°"
      outline.append(rot)
    }
    return outline
  }))
  renderCleanupOverlay()
  gestures.renderCloneMarker()
  restoreFocus()
  syncSplitCompare(page)
}

function freezeCleanup(box) {
  if (box.cleanupRect) return
  const { x, y, w, h } = cleanupRectangle(box)
  box.cleanupRect = { x, y, w, h }
}

function renderCleanupOverlay() {
  const canvas = byId("cleanup-overlay")
  canvas.width = pageCanvas.width
  canvas.height = pageCanvas.height
  const box = selectedBox()
  const tool = byId("cleanup-tool").value
  if (!box || !["region", "erase", "restore"].includes(tool)) return
  const rect = cleanupRectangle(box)
  const left = Math.floor(rect.x * canvas.width)
  const top = Math.floor(rect.y * canvas.height)
  const mask = document.createElement("canvas")
  mask.width = Math.max(1, Math.ceil((rect.x + rect.w) * canvas.width) - left)
  mask.height = Math.max(1, Math.ceil((rect.y + rect.h) * canvas.height) - top)
  paintCleanupMask(mask, box, selectedPage().image, left, top)
  const context = mask.getContext("2d")
  context.globalCompositeOperation = "source-in"
  context.fillStyle = "#ed9f24"
  context.fillRect(0, 0, mask.width, mask.height)
  canvas.getContext("2d").drawImage(mask, left, top)
  const outline = document.createElement("div")
  outline.className = "outline cleanup-region"
  rectStyle(outline, rect)
  overlays.querySelector(".cleanup-region")?.remove()
  overlays.append(outline)
}

function renderPresets() {
  const select = byId("style-preset")
  const value = select.value
  select.replaceChildren(...state.presets.map((preset, index) => new Option(preset.name, index)))
  if (state.presets[Number(value)]) select.value = value
  byId("save-preset").disabled = !selectedBox() || projectBusy()
  byId("apply-preset").disabled = !state.presets.length || !state.pages.length || projectBusy()
  byId("delete-preset").disabled = !state.presets.length || projectBusy()
  if (byId("export-presets")) byId("export-presets").disabled = !state.presets.length
  if (byId("import-presets")) byId("import-presets").disabled = projectBusy()
}

byId("save-preset").onclick = () => {
  const box = selectedBox()
  const name = byId("preset-name").value.trim()
  if (!box || projectBusy()) return
  if (!name) return status(msg("status.preset.needName"), true)
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Lưu mẫu dàn chữ "${name}"`, kind: "preset" })
  const preset = { name, style: projectStyle(box) }
  const index = state.presets.findIndex((item) => item.name.toLowerCase() === name.toLowerCase())
  if (index < 0) state.presets.push(preset)
  else state.presets[index] = preset
  state.presets = saveGlobalPresets(state.presets)
  renderPresets()
  const savedIndex = state.presets.findIndex((item) => item.name.toLowerCase() === name.toLowerCase())
  byId("style-preset").value = String(savedIndex >= 0 ? savedIndex : 0)
  status(savedIndex >= 0
    ? msg("status.preset.saved", { name })
    : msg("status.preset.full", { max: MAX_GLOBAL_PRESETS }))
}

byId("apply-preset").onclick = () => {
  const preset = state.presets[Number(byId("style-preset").value)]
  if (!preset || projectBusy()) return
  commitLiveFormCheckpoint()
  const scope = byId("preset-scope").value
  const page = selectedPage()
  const boxes = scope === "chapter"
    ? state.pages.flatMap((p) => p.boxes)
    : scope === "page"
      ? (page?.boxes ?? [])
      : state.selectedBoxIds.size > 1 && page
        ? page.boxes.filter((b) => state.selectedBoxIds.has(b.id))
        : [selectedBox()].filter(Boolean)
  if (!boxes.length) return status(msg("status.preset.needBox"), true)
  checkpoint(undefined, { label: `Áp dụng mẫu "${preset.name}" cho ${boxes.length} khung`, kind: "preset" })
  boxes.forEach((box) => Object.assign(box, PRESET_RESET_DEFAULTS, preset.style))
  render()
  status(msg("status.preset.applied", { count: boxes.length }))
}

byId("delete-preset").onclick = () => {
  if (projectBusy() || !state.presets.length) return
  checkpoint(undefined, { label: `Xóa mẫu dàn chữ "${state.presets[Number(byId("style-preset").value)]?.name ?? ""}"`, kind: "preset" })
  state.presets.splice(Number(byId("style-preset").value), 1)
  saveGlobalPresets(state.presets)
  renderPresets()
}

byId("export-presets")?.addEventListener("click", () => {
  if (!state.presets.length) return status(msg("status.preset.none"), true)
  const json = serializePresetsJson(state.presets)
  saveFile(new Blob([json], { type: "application/json;charset=utf-8" }), "nixio-presets.json")
  status(msg("status.preset.exported", { count: state.presets.length }))
})

byId("import-presets")?.addEventListener("click", () => {
  if (!projectBusy()) byId("presets-file")?.click()
})

byId("presets-file")?.addEventListener("change", async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  try {
    const imported = parsePresetsJson(await file.text())
    commitLiveFormCheckpoint()
    checkpoint(undefined, { label: `Nhập ${imported.length} mẫu dàn chữ`, kind: "preset" })
    state.presets = saveGlobalPresets(mergePresets(state.presets, imported))
    for (const preset of imported) registerFontName(preset.style.font)
    renderFontOptions()
    renderPresets()
    status(msg("status.preset.imported", { imported: imported.length, total: state.presets.length }))
  } catch (error) {
    status(msg("status.preset.importFailed", { error: error.message }), true)
  }
})

byId("reset-cleanup").onclick = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Xóa vùng xoá nền của khung", kind: "cleanup" })
  delete box.cleanupRect
  delete box.cleanupStrokes
  delete box.cleanupExpand
  delete box.cleanupMode
  freezeCleanup(box)
  render()
}

byId("cleanup-mode")?.addEventListener("change", () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Đổi chế độ xoá chữ nền", kind: "cleanup" })
  const mode = byId("cleanup-mode").value
  if (mode === "content-aware") {
    box.cleanup = true
    box.cleanupMode = "content-aware"
    freezeCleanup(box)
  } else {
    delete box.cleanupMode
  }
  render()
  status(
    mode === "content-aware"
      ? msg("status.cleanupMode.contentAware")
      : msg("status.cleanupMode.auto"),
  )
})

byId("undo-retouch").onclick = () => {
  const page = selectedPage()
  if (!page?.retouchStrokes?.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Hoàn tác nét cọ gần nhất", kind: "retouch" })
  page.retouchStrokes.pop()
  render()
  status(msg("status.retouch.undo"))
}

byId("clear-retouch").onclick = () => {
  const page = selectedPage()
  if (!page?.retouchStrokes?.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Xóa toàn bộ nét vẽ tay trang ${page.name}`, kind: "retouch" })
  page.retouchStrokes = []
  render()
  status(msg("status.retouch.cleared"))
}

// The scan the page arrived with is kept before a cleaned copy replaces it, so the original is one
// action away instead of a whole undo chain.
function replaceScan(page, decoded) {
  if (!page.originalFile) {
    page.originalFile = page.file
    page.originalImage = page.image
    page.originalUrl = page.url
  }
  page.file = decoded.file
  page.image = decoded.image
  page.url = decoded.url
}

function restoreOriginalScan() {
  const page = selectedPage()
  if (!page?.originalFile || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Lấy lại ảnh gốc trang ${page.name}`, kind: "raw-cleanup" })
  page.file = page.originalFile
  page.image = page.originalImage
  page.url = page.originalUrl
  delete page.originalFile
  delete page.originalImage
  delete page.originalUrl
  render()
  status("Đã trả trang về ảnh quét gốc trước khi làm sạch raw.")
}

async function runCleanRawSingle(page, options = { strength: 0.7, denoise: true, sharpen: true }) {
  if (!page || projectBusy()) return
  commitLiveFormCheckpoint()
  state.processingNative = true
  renderPages()
  status(msg("status.raw.running"))
  try {
    const { file, engine } = await cleanRawPageImage(page, options)
    const decoded = await openImage(file)
    const token = checkpoint(undefined, { label: `Làm sạch raw trang ${page.name}`, kind: "raw-cleanup" })
    replaceScan(page, decoded)
    render()
    status(msg("status.raw.done", { engine: engine === "native-cs" ? "C#" : engine === "js-worker" ? "Web Worker" : "JS" }))
    notify({
      kind: "success",
      title: t("notify.raw.done.title"),
      message: t("notify.raw.done.message", { page: page.name, engine: engine === "native-cs" ? t("notify.raw.engineNative") : "JS" }),
      key: `clean-raw-${page.id}`,
      actions: [{ label: t("notify.action.undo"), onClick: () => undoCleanupAction(token) }],
    })
  } catch (error) {
    status(msg("status.raw.failed", { error: error.message }), true)
  } finally {
    state.processingNative = false
    render()
  }
}

async function runCleanRawChapter(options = { strength: 0.7, denoise: true, sharpen: true }) {
  if (cleanRawController) {
    cleanRawController.abort()
    return
  }
  if (!state.pages.length || projectBusy()) return
  commitLiveFormCheckpoint()
  cleanRawController = new AbortController()
  state.processingNative = true
  renderPages()
  const total = state.pages.length
  let cleaned = 0
  let engineLabel = "JS"
  let token = null
  let recorded = false
  try {
    for (let i = 0; i < state.pages.length; i++) {
      if (cleanRawController.signal.aborted) break
      const page = state.pages[i]
      status(msg("status.raw.chapterRunning", { index: i + 1, total: total, name: page.name }))
      const { file, engine } = await cleanRawPageImage(page, options)
      if (cleanRawController.signal.aborted) break
      const decoded = await openImage(file)
      if (!recorded) {
        token = checkpoint(undefined, { label: `Làm sạch raw cả chương (${total} trang)`, kind: "raw-cleanup" })
        recorded = true
      }
      replaceScan(page, decoded)
      engineLabel = engine === "native-cs" ? "C#" : engine === "js-worker" ? "Web Worker" : "JS"
      cleaned++
      if (selectedPage() === page) renderCanvas()
    }
    const stopped = cleanRawController.signal.aborted
    status(
      stopped
        ? msg("status.raw.chapterStopped", { cleaned, total })
        : msg("status.raw.chapterDone", { cleaned, total, engine: engineLabel }),
    )
    if (cleaned > 0) {
      notify({
        kind: "success",
        title: stopped ? t("notify.raw.chapter.title.stopped") : t("notify.raw.chapter.title.done"),
        message: t("notify.raw.chapter.message", { cleaned, total, engine: engineLabel }),
        key: "clean-raw-chapter",
        actions: [{ label: t("notify.action.undo"), onClick: () => undoCleanupAction(token) }],
      })
    }
  } catch (error) {
    status(msg("status.raw.chapterFailed", { cleaned: cleaned, total: total, error: error.message }), true)
  } finally {
    cleanRawController = null
    state.processingNative = false
    render()
  }
}

const rawDialog = byId("raw-cleanup-dialog")
let rawPreviewSource = null
function readRawDialogOptions() {
  const strength = clamp((Number(byId("raw-strength")?.value) ?? 70) / 100, 0, 1)
  return {
    strength,
    denoise: Boolean(byId("raw-denoise")?.checked),
    sharpen: Boolean(byId("raw-sharpen")?.checked),
  }
}
function paintRawPreview() {
  if (!rawPreviewSource) return
  const opts = readRawDialogOptions()
  if (byId("raw-strength-val")) byId("raw-strength-val").textContent = `${Math.round(opts.strength * 100)}%`
  const canvas = byId("raw-preview-canvas")
  const res = cleanRawPixels(rawPreviewSource.data, rawPreviewSource.width, rawPreviewSource.height, opts)
  canvas.width = rawPreviewSource.width
  canvas.height = rawPreviewSource.height
  canvas.getContext("2d").putImageData(new ImageData(res.data, rawPreviewSource.width, rawPreviewSource.height), 0, 0)
  if (byId("raw-preview-meta")) {
    byId("raw-preview-meta").textContent = `Mức đen: ${res.blackPoint} · Mức trắng: ${res.whitePoint} · ${res.grayscale ? "Khử ố vàng 3 kênh R/G/B" : "Bảo toàn màu gốc"}`
  }
}
byId("raw-strength")?.addEventListener("input", paintRawPreview)
byId("raw-denoise")?.addEventListener("change", paintRawPreview)
byId("raw-sharpen")?.addEventListener("change", paintRawPreview)
byId("raw-close")?.addEventListener("click", () => rawDialog?.close())
byId("raw-apply-page")?.addEventListener("click", () => {
  const opts = readRawDialogOptions()
  rawDialog?.close()
  runCleanRawSingle(selectedPage(), opts)
})
byId("raw-apply-chapter")?.addEventListener("click", () => {
  const opts = readRawDialogOptions()
  rawDialog?.close()
  runCleanRawChapter(opts)
})

byId("clean-raw").onclick = async () => {
  const page = selectedPage()
  if (!page || projectBusy()) return
  if (!rawDialog?.showModal) return runCleanRawSingle(page)
  const natW = page.image.naturalWidth
  const natH = page.image.naturalHeight
  const scale = Math.min(1, 520 / Math.max(natW, natH))
  const pw = Math.max(16, Math.round(natW * scale))
  const ph = Math.max(16, Math.round(natH * scale))
  const off = document.createElement("canvas")
  off.width = pw
  off.height = ph
  const ctx = off.getContext("2d", { willReadFrequently: true })
  ctx.drawImage(page.image, 0, 0, pw, ph)
  rawPreviewSource = { width: pw, height: ph, data: ctx.getImageData(0, 0, pw, ph).data }
  paintRawPreview()
  rawDialog.showModal()
}

byId("clean-raw-all")?.addEventListener("click", () => runCleanRawChapter(readRawDialogOptions()))

// Webtoon Vertical Stitch & Smart Slice dialog
const webtoonDialog = byId("webtoon-dialog")
byId("open-webtoon")?.addEventListener("click", () => {
  if (projectBusy() || !state.pages.length || !webtoonDialog?.showModal) return
  const count = state.pages.length
  const fromEl = byId("webtoon-stitch-from")
  const toEl = byId("webtoon-stitch-to")
  if (fromEl) { fromEl.max = String(count); fromEl.value = "1" }
  if (toEl) { toEl.max = String(count); toEl.value = String(count) }
  if (byId("webtoon-stitch-run")) byId("webtoon-stitch-run").disabled = count < 2
  if (byId("webtoon-slice-run")) byId("webtoon-slice-run").disabled = !selectedPage()
  webtoonDialog.showModal()
})
byId("webtoon-close")?.addEventListener("click", () => webtoonDialog?.close())
byId("webtoon-stitch-run")?.addEventListener("click", async () => {
  if (projectBusy() || state.pages.length < 2) return
  const from = clamp(Math.round(Number(byId("webtoon-stitch-from")?.value) || 1), 1, state.pages.length)
  const to = clamp(Math.round(Number(byId("webtoon-stitch-to")?.value) || state.pages.length), 1, state.pages.length)
  const startIdx = Math.min(from, to) - 1
  const endIdx = Math.max(from, to) - 1
  if (endIdx <= startIdx) return status(msg("status.webtoon.needPages"), true)
  webtoonDialog?.close()
  commitLiveFormCheckpoint()
  state.processingNative = true
  renderPages()
  status(msg("status.webtoon.stitching", { from: startIdx + 1, to: endIdx + 1 }))
  try {
    const subset = state.pages.slice(startIdx, endIdx + 1)
    const files = await stitchPagesVertically(subset, { maxPages: pageLimit - (state.pages.length - subset.length) })
    const decoded = []
    for (const file of files) decoded.push(await openImage(file))
    checkpoint(undefined, { label: `Ghép dọc ${subset.length} trang`, kind: "page" })
    state.pages.splice(startIdx, subset.length, ...decoded)
    selectPage(decoded[0])
    status(msg("status.webtoon.stitched", { pages: subset.length, strips: decoded.length }))
  } catch (error) {
    status(msg("status.webtoon.stitchFailed", { error: error.message }), true)
  } finally {
    state.processingNative = false
    render()
  }
})
byId("webtoon-slice-run")?.addEventListener("click", async () => {
  const page = selectedPage()
  if (!page || projectBusy()) return
  const profile = activeExportProfile()
  const targetHeight = clamp(
    Math.round(Number(byId("webtoon-slice-height")?.value) || profile.maxSliceHeight),
    600,
    4000,
  )
  webtoonDialog?.close()
  commitLiveFormCheckpoint()
  state.processingNative = true
  renderPages()
  status(msg("status.webtoon.slicing", { name: page.name }))
  try {
    const files = await smartSlicePageImage(page, { targetHeight, profile })
    if (!files.length) {
      status(msg("status.webtoon.sliceUnneeded"))
      return
    }
    const idx = state.pages.indexOf(page)
    if (state.pages.length - 1 + files.length > pageLimit) {
      throw new Error(`Số mảnh cắt (${files.length}) sẽ vượt giới hạn ${pageLimit} trang. Hãy tăng chiều cao mục tiêu.`)
    }
    const decoded = []
    for (const file of files) decoded.push(await openImage(file))
    checkpoint(undefined, { label: `Cắt thông minh trang ${page.name} thành ${decoded.length} trang`, kind: "page" })
    state.pages.splice(idx, 1, ...decoded)
    selectPage(decoded[0])
    status(msg("status.webtoon.sliced", { pages: decoded.length }))
  } catch (error) {
    status(msg("status.webtoon.sliceFailed", { error: error.message }), true)
  } finally {
    state.processingNative = false
    render()
  }
})

byId("detect-bubbles")?.addEventListener("click", () => {
  const page = selectedPage()
  if (!page || projectBusy()) return
  const direction = byId("direction").value
  const detected = detectAllBubblesOnImage(page.image, { direction })
  if (!detected.length) {
    return status(msg("status.bubble.none"), true)
  }
  const fresh = detected.filter((cand) => {
    const coords = toCoordinates(cand)
    return !page.boxes.some((box) => overlapScore(coords, toCoordinates(box)) > 0.4)
  })
  const capacity = Math.max(0, 24 - page.boxes.length)
  const chosen = fresh.slice(0, capacity)
  if (!chosen.length) {
    return status(msg("status.bubble.alreadyFramed"))
  }
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Quét bong bóng trang ${page.name} (${chosen.length} khung)`, kind: "ocr" })
  let lastBox = null
  for (let i = 0; i < chosen.length; i++) {
    const queuedText = page.unplaced.length
      ? page.unplaced.shift().text
      : state.queue.length
        ? state.queue.shift()
        : `Thoại ${page.boxes.length + 1}`
    const box = makeBox(page, chosen[i], queuedText, state.defaultFont)
    box.fill = false
    box.bubbleFit = true
    page.boxes.push(box)
    lastBox = box
  }
  if (lastBox) {
    state.boxId = lastBox.id
    state.selectedBoxIds.clear()
    state.selectedBoxIds.add(lastBox.id)
  }
  render()
  status(msg("status.bubble.created", { count: chosen.length }))
})

byId("cleanup-tool").onchange = () => {
  state.placing = false
  syncToolControls()
  renderCanvas()
  const tool = byId("cleanup-tool").value
  if (tool === "pan") status(msg("status.tool.pan"))
  else if (tool === "bubble") status(msg("status.tool.bubble"))
  else if (tool === "eyedropper") status(msg("status.tool.eyedropper"))
  else if (tool === "paint") status(msg("status.tool.paint"))
  else if (tool === "clone") status(msg("status.tool.clone"))
  else if (tool === "inpaint") status(msg("status.tool.inpaint"))
  else if (tool === "retouch-erase") status(msg("status.tool.retouchErase"))
  else if (tool !== "text") status(msg("status.tool.generic"))
}
document.querySelectorAll("#tool-rail .rail-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const select = byId("cleanup-tool")
    if (!select || select.value === btn.dataset.tool) return
    select.value = btn.dataset.tool
    select.onchange?.()
  })
  // Nixio #105: a title tooltip never opens for keyboard focus, so focusing a rail button previews the
  // same name in the pill that already names the active tool.
  btn.addEventListener("focus", () => {
    const label = byId("active-tool-label")
    if (label) label.textContent = btn.getAttribute("aria-label") || btn.title
  })
  btn.addEventListener("blur", () => syncToolControls())
})

function selectBox(box) {
  commitLiveFormCheckpoint()
  state.boxId = box.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(box.id)
  renderCanvas()
  renderInspector()
}

function toggleSelectBox(box) {
  commitLiveFormCheckpoint()
  if (state.selectedBoxIds.has(box.id)) {
    state.selectedBoxIds.delete(box.id)
    if (state.boxId === box.id) {
      state.boxId = [...state.selectedBoxIds].at(-1) ?? null
    }
  } else {
    state.selectedBoxIds.add(box.id)
    state.boxId = box.id
  }
  renderCanvas()
  renderInspector()
}

// The geometry fields are pixels on the page, so they are rewritten from the model whenever the
// inspector or a keyboard gesture changes the box.
function syncGeometryFields() {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box) return
  const px = geometryPixels(box, { width: page.image.naturalWidth, height: page.image.naturalHeight })
  byId("box-x").value = px.x
  byId("box-y").value = px.y
  byId("box-w").value = px.w
  byId("box-h").value = px.h
  byId("box-rotation").value = box.rotation
}

function renderInspector() {
  const restoreFocus = holdFocus(byId("boxes"), byId("queue"), byId("layers-panel"))
  const page = selectedPage()
  const box = selectedBox()
  const boxes = page?.boxes ?? []
  const multiCount = state.selectedBoxIds.size
  renderPresets()
  syncToolControls()
  byId("autofit-page").disabled = !boxes.length || projectBusy()
  byId("translate-boxes").disabled = !boxes.length || projectBusy()
  byId("cleanup-inspector").hidden = !box
  byId("reset-cleanup").disabled = projectBusy()
  byId("box-count").textContent = boxes.length

  const multiPanel = byId("multi-select-panel")
  multiPanel.hidden = multiCount < 2
  if (multiCount >= 2) {
    byId("multi-select-count").textContent = `Đang chọn ${multiCount} khung (Shift+bấm để thêm/bớt).`
    multiPanel.querySelectorAll("[data-distribute]").forEach((btn) => {
      btn.disabled = multiCount < 3 || projectBusy()
    })
    multiPanel.querySelectorAll("[data-align], #multi-autofit, #multi-delete").forEach((btn) => {
      btn.disabled = projectBusy()
    })
  }

  byId("inspector-empty").hidden = Boolean(box) || multiCount >= 2
  form.hidden = !box
  if (box) {
    registerFontName(box.font)
    renderFontOptions()
    // A box the user emptied keeps an empty field, and the complaint from a rejected save belongs
    // to the box it was raised on, not to the next one.
    setBoxTextError("")
    byId("box-text").value = box.text
    byId("box-size").value = box.size
    byId("box-font").value = box.font
    byId("box-color").value = box.color
    byId("box-align").value = box.align
    byId("box-bold").checked = Boolean(box.bold)
    byId("box-italic").checked = Boolean(box.italic)
    byId("box-uppercase").checked = Boolean(box.uppercase)
    byId("box-vertical").checked = Boolean(box.vertical)
    byId("box-bubble-fit").checked = Boolean(box.bubbleFit)
    byId("box-warp").value = box.warp ?? "none"
    byId("box-warp-amount").value = box.warpAmount ?? 0
    byId("box-line-height").value = box.lineHeight ?? 1.15
    byId("box-stroke-width").value = box.strokeWidth ?? 0
    byId("box-stroke-color").value = box.strokeColor ?? "#ffffff"
    byId("box-shadow-blur").value = box.shadowBlur ?? 0
    byId("box-shadow-color").value = box.shadowColor ?? "#000000"
    byId("box-fill").checked = box.fill
    byId("box-fill-shape").value = box.fillShape ?? "rect"
    byId("box-fill-color").value = box.fillColor ?? "#ffffff"
    byId("box-cleanup").checked = Boolean(box.cleanup)
    if (byId("cleanup-mode")) byId("cleanup-mode").value = box.cleanupMode ?? "auto"
    byId("cleanup-expand").value = box.cleanupExpand ?? 0
    const idx = boxes.findIndex((item) => item.id === box.id)
    byId("box-layer-down").disabled = idx <= 0 || projectBusy()
    byId("box-layer-up").disabled = idx < 0 || idx >= boxes.length - 1 || projectBusy()
    syncGeometryFields()
  }
  byId("boxes").replaceChildren(...boxes.map((item) => {
    const li = document.createElement("li")
    const button = listButton(boxLabel(item), (event) => {
      if (event.shiftKey) toggleSelectBox(item)
      else selectBox(item)
    })
    button.dataset.focusKey = "box-list:" + item.id
    if (box?.id === item.id || state.selectedBoxIds.has(item.id)) button.setAttribute("aria-current", "true")
    li.append(button)
    return li
  }))
  const queue = [
    ...state.queue.map((text, index) => ({ text, remove: () => state.queue.splice(index, 1) })),
    ...(page?.unplaced ?? []).map((line, index) => ({
      ...line, remove: () => page.unplaced.splice(index, 1),
    })),
  ]
  // Identical lines share their text, so the occurrence number keeps each row's key stable while
  // other rows come and go.
  const occurrences = new Map()
  const queueKey = (text) => {
    const seen = (occurrences.get(text) ?? 0) + 1
    occurrences.set(text, seen)
    return `queue:${seen}:${text}`
  }
  byId("queue-section").hidden = !queue.length
  byId("queue").replaceChildren(...queue.map((line) => {
    const li = document.createElement("li")
    const button = listButton(line.text, () => {
      if (!selectedPage() || projectBusy()) return
      commitLiveFormCheckpoint()
      checkpoint(undefined, { label: "Đặt lời thoại từ hàng chờ", kind: "box" })
      line.remove()
      addBox({ x: .32, y: .4, w: .36, h: .16 }, line.text, false)
    })
    button.dataset.focusKey = queueKey(line.text)
    button.disabled = !page || projectBusy()
    li.append(button)
    return li
  }))
  syncLayers()
  restoreFocus()
}

function render() {
  renderPages()
  renderCanvas()
  renderInspector()
  syncTranslationMemory()
}

async function openImage(file) {
  const url = URL.createObjectURL(file)
  ownedUrls.add(url)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
    if (image.naturalWidth * image.naturalHeight > 28000000) throw new Error("Ảnh vượt giới hạn kích thước.")
    return { id: crypto.randomUUID(), name: file.name, file, image, url, boxes: [], unplaced: [], retouchStrokes: [], layers: defaultLayers() }
  } catch (error) {
    URL.revokeObjectURL(url)
    ownedUrls.delete(url)
    throw error
  }
}

async function importPages(files) {
  if (projectBusy()) return []
  commitLiveFormCheckpoint()
  state.importing = true
  syncProjectActions()
  const loaded = []
  const rejected = []
  try {
    for (const file of files) {
      if (state.pages.length + loaded.length >= pageLimit || !isImageFile(file)) {
        rejected.push(file.name)
        continue
      }
      try {
        loaded.push(await openImage(file))
      } catch {
        rejected.push(file.name)
      }
    }
    if (loaded.length) checkpoint(undefined, { label: `Thêm ${loaded.length} ảnh vào chương`, kind: "page" })
    state.pages.push(...loaded)
    if (loaded.length && !selectedPage()) selectPage(loaded[0])
    else render()
    if (rejected.length) {
      status(msg("status.images.addedSkipped", { added: loaded.length, skipped: rejected.length }), true)
    } else if (loaded.length) {
      status(msg("status.images.added", { count: loaded.length }))
    }
    return loaded
  } finally {
    state.importing = false
    renderPages()
    releaseUnusedImages()
    byId("images").value = ""
  }
}
byId("images").onchange = (event) => importPages([...event.target.files])
const dropzone = byId("dropzone")
dropzone.ondragover = (event) => {
  event.preventDefault()
  dropzone.classList.add("dragging")
}
dropzone.ondragleave = () => dropzone.classList.remove("dragging")
dropzone.ondrop = (event) => {
  event.preventDefault()
  dropzone.classList.remove("dragging")
  importPages([...event.dataTransfer.files])
}
setupLibrary(async (files) => {
  const pages = await importPages(files)
  if (!pages.length) throw new Error("Không còn chỗ hoặc không đọc được ảnh.")
  selectPage(pages[0])
  location.hash = "editor"
})

byId("prev-page").onclick = () => changePage(-1)
byId("next-page").onclick = () => changePage(1)
function updateFitLabel() {
  byId("fit-page").textContent = state.fit ? "Vừa trang" : "Kích thước gốc"
}
byId("fit-page").onclick = () => {
  state.zoom = null
  state.fit = !state.fit
  updateFitLabel()
  renderCanvas()
}
// Every path that switches a compare view reports the view the editor ends up in, so turning a
// toggle off names the restored view instead of claiming the edit view came back.
function compareStatus() {
  const mode = compareMode(state)
  if (mode === "original") return "Đang xem ảnh gốc (nhấn \\ để quay lại)."
  if (mode === "split") return "Đang bật thanh kéo so sánh gốc (kéo rèm hoặc nhấn Shift+\\ để tắt)."
  return "Đã quay lại bản biên tập."
}

byId("compare-original").onclick = () => {
  if (!selectedPage()) return
  Object.assign(state, toggleCompare(state, "original"))
  renderCanvas()
  status(compareStatus())
}

byId("split-compare")?.addEventListener("click", () => {
  if (!selectedPage()) return
  Object.assign(state, toggleCompare(state, "split"))
  renderCanvas()
  status(compareStatus())
})

byId("script-file").onchange = async (event) => {
  const file = event.target.files[0]
  event.target.value = ""
  if (!file || projectBusy()) return
  state.importingScript = true
  syncProjectActions()
  try {
    const script = await readDialogueFile(file)
    checkpoint(undefined, { label: `Nhập kịch bản ${file.name}`, kind: "script" })
    byId("script-text").value = script
    status(msg("status.script.read", { name: file.name }))
  } catch (error) {
    status(msg("status.script.failed", { error: error.message }), true)
  } finally {
    state.importingScript = false
    renderPages()
  }
}

function distribute(page, lines, direction) {
  const columns = lines.length > 4 ? 2 : 1
  const rows = Math.ceil(lines.length / columns)
  const width = columns === 1 ? .48 : .4
  const height = Math.min(.16, .79 / rows)
  return lines.map((line, index) => {
    const column = index % columns
    const x = columns === 1 ? .26 : direction === "rtl" ? .55 - column * .49 : .06 + column * .49
    const y = .07 + Math.floor(index / columns) * (.86 / rows)
    const box = makeBox(page, { x, y, w: width, h: height }, line, state.defaultFont)
    box.size = clamp(Math.round(Math.min(box.size, height * page.image.naturalHeight * .44)), 8, 400)
    return box
  })
}

function pageForScript(reference, current) {
  if (reference === null) return current
  if (typeof reference === "number") return state.pages[reference]
  return state.pages.find((page) => page.name.toLowerCase() === reference)
}

byId("apply-script").onclick = () => {
  const current = selectedPage()
  const groups = groupDialogue(byId("script-text").value)
  if (projectBusy()) return
  if (!current || !groups.length) return status(msg("status.script.needInput"), true)
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Dàn kịch bản (${groups.length} nhóm thoại)`, kind: "script" })
  const unplaced = []
  let placed = 0
  for (const { reference, lines } of groups) {
    const page = pageForScript(reference, current)
    if (!page) {
      unplaced.push(...lines)
      continue
    }
    const available = Math.max(0, 24 - page.boxes.length)
    const chosen = lines.slice(0, available)
    page.boxes.push(...distribute(page, chosen, byId("direction").value))
    placed += chosen.length
    unplaced.push(...lines.slice(available))
  }
  state.queue.push(...unplaced)
  render()
  status(msg("status.script.placed", { placed: placed, unplaced: unplaced.length }))
  notifyOverflowIfAny(current, "sau khi dàn kịch bản")
}

function addBox(rectangle, line, record = true) {
  const page = selectedPage()
  if (!page || projectBusy()) return
  commitLiveFormCheckpoint()
  if (record) checkpoint(undefined, { label: "Thêm khung thoại", kind: "box" })
  const box = makeBox(page, rectangle, line, state.defaultFont)
  page.boxes.push(box)
  state.boxId = box.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(box.id)
  state.placing = false
  renderCanvas()
  renderInspector()
  status(msg("status.box.added"))
}

byId("add-box").onclick = () => {
  byId("cleanup-tool").value = "text"
  syncToolControls()
  state.placing = !state.placing
  renderCanvas()
  if (state.placing) {
    stage.focus()
    status(msg("status.box.placing"))
  } else {
    status(msg("status.box.placingCancelled"))
  }
}

// The inline message next to the text field, shared by the rejected save and the live edit that
// clears it again, so the field never carries a stale complaint.
function setBoxTextError(message) {
  const error = byId("box-text-error")
  if (!error) return
  error.textContent = message ?? ""
  if (message) byId("box-text").setAttribute("aria-invalid", "true")
  else byId("box-text").removeAttribute("aria-invalid")
}

function applyFormToBox(box, { requireText = false } = {}) {
  const text = byId("box-text").value
  if (requireText && boxTextError(text)) return false
  applyBoxText(box, text)
  box.font = byId("box-font").value
  box.size = clamp(Number(byId("box-size").value) || box.size, 8, 400)
  box.lineHeight = clamp(Number(byId("box-line-height").value) || 1.15, .8, 2.2)
  box.color = byId("box-color").value
  box.rotation = clamp(Number(byId("box-rotation").value) || 0, -180, 180)
  box.align = byId("box-align").value
  box.bold = byId("box-bold").checked
  box.italic = byId("box-italic").checked
  box.uppercase = byId("box-uppercase").checked
  box.vertical = byId("box-vertical").checked
  box.bubbleFit = byId("box-bubble-fit").checked
  box.warp = byId("box-warp").value
  box.warpAmount = clamp(Number(byId("box-warp-amount").value) || 0, -50, 50)
  box.strokeWidth = clamp(Number(byId("box-stroke-width").value) || 0, 0, 24)
  box.strokeColor = byId("box-stroke-color").value
  box.shadowBlur = clamp(Number(byId("box-shadow-blur").value) || 0, 0, 24)
  box.shadowColor = byId("box-shadow-color").value
  box.fill = byId("box-fill").checked
  box.fillShape = byId("box-fill-shape").value
  box.fillColor = byId("box-fill-color").value
  box.cleanup = byId("box-cleanup").checked
  // A geometry field still showing the model is left alone: rounding to whole pixels would
  // otherwise pull the box every time an unrelated field of the form is edited.
  const page = selectedPage()
  if (page) {
    const size = { width: page.image.naturalWidth, height: page.image.naturalHeight }
    const shown = geometryPixels(box, size)
    const read = (key, span) => {
      const field = byId(`box-${key}`)
      const typed = field?.value.trim()
      const value = Number(typed)
      if (!typed || !Number.isFinite(value) || value === shown[key]) return box[key]
      return value / Math.max(1, span)
    }
    Object.assign(box, clampRect({
      x: read("x", size.width), y: read("y", size.height),
      w: read("w", size.width), h: read("h", size.height),
    }))
  }
  if (box.cleanup) freezeCleanup(box)
  return true
}

function liveUpdateForm() {
  const box = selectedBox()
  const page = selectedPage()
  if (!box || !page || projectBusy()) return
  if (!formEditSnapshot) formEditSnapshot = editorSnapshot()
  applyFormToBox(box)
  projects.changed()
  const outline = overlays.querySelector('[aria-current="true"]')
  if (outline) rectStyle(outline, box)
  paintPreview(page)
}
byId("box-warp").addEventListener("change", () => {
  if (byId("box-warp").value !== "none" && Number(byId("box-warp-amount").value) === 0) {
    byId("box-warp-amount").value = "20"
  }
})
form.addEventListener("input", liveUpdateForm)
form.addEventListener("change", liveUpdateForm)
byId("box-text").addEventListener("input", () => {
  if (!boxTextError(byId("box-text").value)) setBoxTextError("")
})

form.onsubmit = (event) => {
  event.preventDefault()
  const box = selectedBox()
  if (!box || projectBusy()) return
  // An empty field is a draft, not a saved box: the save refuses it, keeps the caret in the field
  // and explains why inline instead of restoring the line the user just deleted.
  const error = boxTextError(byId("box-text").value)
  if (error) {
    setBoxTextError(error)
    byId("box-text").focus()
    return
  }
  setBoxTextError("")
  if (!commitLiveFormCheckpoint()) checkpoint(undefined, { label: "Lưu khung thoại", kind: "form" })
  applyFormToBox(box, { requireText: true })
  renderPages()
  renderCanvas()
  renderInspector()
  status(msg("status.box.saved"))
}

function deleteSelectedBoxes() {
  const page = selectedPage()
  if (!page || projectBusy()) return
  const ids = state.selectedBoxIds.size ? new Set(state.selectedBoxIds) : (state.boxId ? new Set([state.boxId]) : null)
  if (!ids?.size) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: ids.size > 1 ? `Xóa ${ids.size} khung thoại` : "Xóa khung thoại", kind: "box" })
  const removed = page.boxes.filter((box) => ids.has(box.id)).length
  page.boxes = page.boxes.filter((box) => !ids.has(box.id))
  state.boxId = null
  state.selectedBoxIds.clear()
  renderCanvas()
  renderInspector()
  status(removed > 1 ? msg("status.box.removedMany", { count: removed }) : msg("status.box.removed"))
}

byId("delete-box").onclick = deleteSelectedBoxes
byId("multi-delete").onclick = deleteSelectedBoxes

byId("autofit-box").onclick = () => {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Tự khớp cỡ chữ khung", kind: "text" })
  const next = autoFitBox(page, box)
  box.size = next
  byId("box-size").value = next
  renderCanvas()
  renderInspector()
  status(msg("status.fit.auto", { size: next }))
}

byId("autofit-page").onclick = () => {
  const page = selectedPage()
  if (!page?.boxes.length || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Tự khớp cỡ chữ trang ${page.name}`, kind: "text" })
  page.boxes.forEach((box) => { box.size = autoFitBox(page, box) })
  render()
  status(msg("status.fit.page", { count: page.boxes.length }))
}

byId("multi-autofit").onclick = () => {
  const page = selectedPage()
  if (!page || state.selectedBoxIds.size < 2 || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: `Tự khớp cỡ chữ ${state.selectedBoxIds.size} khung đã chọn`, kind: "text" })
  const targets = page.boxes.filter((box) => state.selectedBoxIds.has(box.id))
  targets.forEach((box) => { box.size = autoFitBox(page, box) })
  render()
  status(msg("status.fit.selected", { count: targets.length }))
}

document.querySelectorAll("[data-align]").forEach((button) => {
  button.onclick = () => {
    const page = selectedPage()
    if (!page || state.selectedBoxIds.size < 2 || projectBusy()) return
    commitLiveFormCheckpoint()
    const before = editorSnapshot()
    if (!alignBoxes(page.boxes, state.selectedBoxIds, button.dataset.align)) return
    checkpoint(before, { label: `Căn ${alignLabels[button.dataset.align] ?? button.dataset.align} ${state.selectedBoxIds.size} khung`, kind: "layout" })
    render()
    status(msg("status.align.done"))
  }
})

document.querySelectorAll("[data-distribute]").forEach((button) => {
  button.onclick = () => {
    const page = selectedPage()
    if (!page || state.selectedBoxIds.size < 3 || projectBusy()) return
    commitLiveFormCheckpoint()
    const before = editorSnapshot()
    if (!distributeBoxes(page.boxes, state.selectedBoxIds, button.dataset.distribute)) return
    checkpoint(before, { label: `Chia đều khoảng cách ${distributeLabels[button.dataset.distribute] ?? ""} ${state.selectedBoxIds.size} khung`, kind: "layout" })
    render()
    status(msg("status.distribute.done"))
  }
})

function duplicateSelectedBox() {
  const page = selectedPage()
  const box = selectedBox()
  if (!page || !box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Nhân bản khung thoại", kind: "box" })
  const copy = duplicateBox(box)
  page.boxes.push(copy)
  state.boxId = copy.id
  state.selectedBoxIds.clear()
  state.selectedBoxIds.add(copy.id)
  render()
  status(msg("status.box.duplicated"))
}
byId("duplicate-box").onclick = duplicateSelectedBox

function moveBoxLayer(delta) {
  const page = selectedPage()
  if (!page || !state.boxId || projectBusy()) return
  commitLiveFormCheckpoint()
  const result = reorderBox(page.boxes, state.boxId, delta)
  if (!result.moved) return
  checkpoint(undefined, { label: delta > 0 ? "Đưa khung lên lớp trên" : "Đưa khung xuống lớp dưới", kind: "box" })
  page.boxes = result.boxes
  render()
  status(delta > 0 ? msg("status.zOrder.up") : msg("status.zOrder.down"))
}
byId("box-layer-up").onclick = () => moveBoxLayer(1)
byId("box-layer-down").onclick = () => moveBoxLayer(-1)

// `onPlaced` receives every box this pass wrote, so the caller that knows the translation settings
// can record which source line each box now holds and skip it on the next run.
function applyTranslation(page, lines, onPlaced) {
  const regions = page.boxes.length ? page.boxes.map((box) => ({ box: toCoordinates(box.originalBox ?? box), existing: box }))
    : lines.filter((line) => line.box).map((line) => ({ box: line.box }))
  const { placed, unplaced } = matchDialogue(lines, regions)
  for (const { line, region } of placed) {
    const box = region.existing ?? makeBox(page, toRectangle(region.box), line.text, state.defaultFont)
    box.text = line.text
    box.originalBox = toRectangle(line.box)
    if (!region.existing) {
      box.fill = false
      box.cleanup = true
      page.boxes.push(box)
    }
    onPlaced?.(box, line)
  }
  page.unplaced = unplaced
  return placed.length
}

byId("cleanup-expand").onchange = () => {
  const box = selectedBox()
  if (!box || projectBusy()) return
  commitLiveFormCheckpoint()
  checkpoint(undefined, { label: "Đổi độ giãn vùng xoá nền", kind: "cleanup" })
  box.cleanupExpand = clamp(Math.round(Number(byId("cleanup-expand").value) || 0), -8, 8)
  render()
}

const notifications = createNotificationCenter({ byId, locale: () => i18n.locale, t })
// Panels that render their own copy redraw through here when the locale changes.
refreshLocaleViews = () => {
  notifications.render()
  dialogs?.renderFindResults()
  chat?.refreshWelcome?.()
}
const notify = (options) => notifications.notify(options)

// One ledger for every paid provider call in the window; the project that is open when a call lands
// is the project it is billed to.
const usageLedger = createUsageLedger({ projectKey: () => state.projectId || "unsaved" })
setupUsage({ byId, ledger: usageLedger, notify, pageId: () => state.pageId })
// Turn transcripts belong to the project that was open when the turn ran, so the panel reads them the
// same way the chat session is restored. A session with no file yet shares the "unsaved" bucket the
// usage ledger already uses.
const replay = setupReplay({ byId, projectId: () => state.projectId || "unsaved", notify, t })
replay.refresh()

function notifyOverflowIfAny(page, sourceLabel = "") {
  if (!page?.boxes?.length) return
  let overflowCount = 0
  for (const box of page.boxes) {
    try {
      if (textOverflows(page, box)) overflowCount++
    } catch {
      // Ignore canvas measurement errors.
    }
  }
  if (!overflowCount) return
  notify({
    kind: "warning",
    title: t("notify.overflow.title", { count: overflowCount }),
    message: t("notify.overflow.message", { page: page.name, source: sourceLabel ? ` (${sourceLabel})` : "", over: overflowCount, total: page.boxes.length }),
    key: `overflow-${page.id}`,
    actions: [
      {
        label: t("notify.action.autofitPage"),
        primary: true,
        onClick: () => {
          if (selectedPage() !== page) selectPage(page)
          byId("autofit-page")?.click()
        },
      },
    ],
  })
}

const updateDialog = byId("update-dialog")
let activeUpdateResult = null
function showUpdateDialog(result) {
  if (!updateDialog || !result) return
  activeUpdateResult = result
  const release = result.release ?? {}
  byId("update-dialog-title").textContent = result.hasUpdate
    ? t("update.dialog.available", { version: result.latestVersion })
    : t("update.dialog.latest")
  const dateText = release.publishedAt
    ? " · " + t("update.dialog.released", { date: formatDate(i18n.locale, release.publishedAt) })
    : ""
  byId("update-version-row").textContent = result.hasUpdate
    ? t("update.dialog.versions", { current: result.currentVersion, latest: result.latestVersion, released: dateText })
    : t("update.dialog.current", { current: result.currentVersion, released: dateText })
  byId("update-notes").textContent = release.notes
    || (result.hasUpdate
      ? t("update.dialog.notesHint")
      : t("update.dialog.notesLatest"))

  const assetsEl = byId("update-assets")
  const assets = Array.isArray(release.assets) ? release.assets : []
  assetsEl.hidden = !result.hasUpdate || !assets.length
  if (!assetsEl.hidden) {
    assetsEl.replaceChildren(
      ...assets.map((asset) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "button"
        const nameSpan = document.createElement("span")
        nameSpan.textContent = "↓ " + asset.name
        const sizeSpan = document.createElement("span")
        sizeSpan.className = "muted"
        sizeSpan.textContent = formatBytes(asset.size)
        btn.append(nameSpan, sizeSpan)
        btn.onclick = () => {
          openExternalUrl(asset.downloadUrl).catch(() => {})
        }
        return btn
      }),
    )
  }
  byId("update-dismiss-version").hidden = !result.hasUpdate
  updateDialog.showModal()
}

byId("update-open-release").onclick = () => {
  const url = activeUpdateResult?.release?.url || RELEASES_PAGE_URL
  openExternalUrl(url).catch(() => {})
}
byId("update-dismiss-version").onclick = () => {
  if (activeUpdateResult?.latestVersion) {
    dismissUpdateVersion(activeUpdateResult.latestVersion)
    status(msg("status.update.dismissedFor", { version: activeUpdateResult.latestVersion }))
  }
  updateDialog.close()
}
byId("update-close").onclick = () => updateDialog.close()

let checkingUpdate = false
async function runUpdateCheck({ force = false } = {}) {
  if (checkingUpdate) return
  checkingUpdate = true
  const checkBtn = byId("check-update")
  if (force && checkBtn) checkBtn.disabled = true
  if (force) status(msg("status.update.checking"))
  try {
    const result = await checkAppUpdate({ force, currentVersion: APP_VERSION })
    if (result.skipped) return
    if (!result.ok) {
      if (force) {
        status(result.error || t("status.update.checkFailed"), true)
        notify({
          kind: "warning",
          title: t("notify.update.failed.title"),
          message: result.error || t("notify.update.failed.message"),
          key: "app-update",
        })
      }
      return
    }
    if (result.hasUpdate && (!result.dismissed || force)) {
      if (force) status(msg("status.update.available", { version: result.latestVersion }))
      notify({
        kind: "update",
        title: t("notify.update.available.title", { version: result.latestVersion }),
        message: t("notify.update.available.message", { current: result.currentVersion }),
        key: "app-update",
        actions: [
          { label: t("notify.action.openRelease"), primary: true, onClick: () => showUpdateDialog(result) },
          {
            label: t("update.dismiss"),
            onClick: () => {
              dismissUpdateVersion(result.latestVersion)
              status(msg("status.update.dismissed", { version: result.latestVersion }))
            },
          },
        ],
      })
      if (force) showUpdateDialog(result)
    } else if (force) {
      status(msg("status.update.latest", { version: result.currentVersion }))
      notify({
        kind: "success",
        title: t("notify.update.latest.title"),
        message: t("notify.update.latest.message", { version: result.currentVersion }),
        key: "app-update",
      })
    }
  } catch {
    // Keep silent on unexpected startup check errors.
  } finally {
    checkingUpdate = false
    if (force && checkBtn) checkBtn.disabled = false
  }
}

byId("check-update").onclick = () => runUpdateCheck({ force: true })
byId("notifications-check-update").onclick = () => {
  notifications.closePanel()
  runUpdateCheck({ force: true })
}

window.addEventListener("offline", () => {
  notify({
    kind: "warning",
    title: t("notify.offline.title"),
    message: t("notify.offline.message"),
    key: "network-state",
  })
})
window.addEventListener("online", () => {
  notify({
    kind: "success",
    title: t("notify.online.title"),
    message: t("notify.online.message"),
    key: "network-state",
  })
})

// Nixio #60: the legacy LLM record is sanitized before any settings writer exists, and the promise is
// handed to the translation controller so a write that lands mid-migration waits instead of putting
// the plaintext keys back on disk. A storage failure is reported and startup continues.
const credentialMigration = migrateLegacyCredentials()
const MIGRATION_NOTICES = new Set([
  CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED,
  CREDENTIAL_SETTINGS_CODES.MIGRATION_CLEANED,
  CREDENTIAL_SETTINGS_CODES.MIGRATION_REENTRY,
  CREDENTIAL_SETTINGS_CODES.STORAGE_UNAVAILABLE,
  CREDENTIAL_SETTINGS_CODES.CONFIG_CORRUPT,
])

credentialMigration.then(
  (outcome) => {
    // An up-to-date install and a missing record say nothing: only the answers that changed something,
    // need a key again, or failed to read storage are worth a status line.
    if (!outcome || !MIGRATION_NOTICES.has(outcome.code)) return
    status(outcome.message, outcome.code !== CREDENTIAL_SETTINGS_CODES.MIGRATION_APPLIED)
  },
  // The helper reports its own failures, so a rejection here would be a defect rather than a state to
  // explain; it must not stop the editor from opening.
  () => {},
)

const shared = {
  state, byId, status, t, locale: () => i18n.locale, checkpoint, renderPages, renderInspector,
  renderCanvas, render, selectedPage, selectedBox, projectBusy, notify, notifyOverflowIfAny,
}
const gestures = setupGestures({
  ...shared, stage, overlays, pageCanvas, viewport, editorSnapshot,
  commitLiveForm: commitLiveFormCheckpoint, selectBox, toggleSelectBox,
  addBox, freezeCleanup, rectStyle, paintPreview, renderCleanupOverlay, changePage,
})
const translation = setupTranslation({
  ...shared,
  pageForScript,
  applyTranslation,
  translationMemory,
  configWritesReady: credentialMigration,
  usageLedger,
  onSettingsChange: () => {
    syncTranslationActions()
    chat?.refreshModelBadge()
  },
})
syncTranslationMemory = () => translation.syncMemory()
const projects = setupProjects({
  ...shared, projectSettings, defaultProjectSettings, history, openImage,
  selectPage, selectedIndex, updateFitLabel, releaseUnusedImages,
  hasGesture: () => gestures.hasGesture(),
  onCapabilities: (ready, languages) => { nativeReady = ready; nativeLanguages = languages },
  commitLiveForm: commitLiveFormCheckpoint,
  registerFontName,
  renderFontOptions,
  translationMemory,
  qaReview,
  onProjectSwitch: () => {
    chat?.syncProjectSession()
    translation.refreshGlossaryStatus()
    syncExportProfileSummary()
  },
})
const dialogs = setupDialogs({
  ...shared, selectPage, selectBox, listButton, commitLiveForm: commitLiveFormCheckpoint,
  editorSnapshot, onStyleGuideChange: syncTranslationActions,
})
const recordNudge = (before) => checkpoint(before, NUDGE_META)
const recordResize = (before) => checkpoint(before, RESIZE_META)
const recordRotate = (before) => checkpoint(before, ROTATE_META)

shortcuts = setupShortcuts({
  state, byId, stage, pageCanvas, gestures, dialogs,
  selectedPage, selectedBox, projectBusy, editorSnapshot,
  commitLiveForm: commitLiveFormCheckpoint,
  formEditing: () => Boolean(formEditSnapshot),
  renderCanvas,
  syncGeometry: syncGeometryFields,
  restoreHistory, duplicateSelectedBox, deleteSelectedBoxes,
  toggleHistoryPanel,
  recordNudge, recordResize, recordRotate,
  pageSelection: {
    count: () => state.selectedPageIds.size,
    clear: clearPageSelection,
    selectAll: selectAllPages,
    owns: (target) => Boolean(target?.closest?.("#pages")),
  },
})
setupTasks(byId)
setupOcr(shared)
const layers = setupLayers({
  ...shared, editorSnapshot,
  commitLiveForm: commitLiveFormCheckpoint,
  restoreOriginal: restoreOriginalScan,
})
syncLayers = layers.sync
const exportUi = setupExports({
  ...shared, selectPage, selectBox, listButton,
  qaReview,
  readTranslationSettings: translation.settings,
  isNativeReady: () => projects.ready,
  commitLiveForm: commitLiveFormCheckpoint,
  changed: () => projects.changed(),
})
syncExportProfileSummary = exportUi.syncProfileSummary
chat = setupChat({
  ...shared,
  editorSnapshot,
  selectedIndex,
  selectPage,
  commitLiveForm: commitLiveFormCheckpoint,
  readTranslationSettings: translation.settings,
  onSkillChange: syncTranslationActions,
  registerFontName,
  renderFontOptions,
  restoreHistory,
  usageLedger,
  replay,
})

// The bulk bar's five actions reuse the single-page/chapter paths: translation goes through the
// same processPages job as "Dịch cả lượt", export through the ZIP dialog's page list, and the
// page edits record one checkpoint each so undo restores the whole batch at once.
byId("bulk-translate").onclick = () => translation.translatePages(selectedPagesInOrder())
byId("bulk-duplicate").onclick = duplicateSelectedPages
byId("bulk-move-up").onclick = () => moveSelectedPagesBy(-1)
byId("bulk-move-down").onclick = () => moveSelectedPagesBy(1)
byId("bulk-export").onclick = () => exportUi.openZipExport(selectedPagesInOrder())
byId("bulk-delete").onclick = removeSelectedPages
byId("bulk-select-all").onclick = selectAllPages
byId("bulk-clear").onclick = clearPageSelection

restoreCustomFonts().then((restored) => {
  if (!restored.length) return
  renderFontOptions()
  if (selectedPage()) render()
})

setTimeout(() => {
  runUpdateCheck({ force: false })
}, 4000)

render()
