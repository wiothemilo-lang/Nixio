import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { addLayer, defaultLayers, layerLimit, removeLayer } from "../src/layers.js"
import { createQaReviewStore, qaExportOverrideNote } from "../src/qa-review.js"

const desktopCalls = { tasks: [], cancelled: [] }

function fakeElement(tag = "div") {
  const listeners = new Map()
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    value: "",
    checked: false,
    open: false,
    hidden: false,
    textContent: "",
    href: "",
    target: "",
    rel: "",
    focused: false,
    selected: false,
    scrolled: false,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type, event) { return listeners.get(type)?.(event) },
    removeEventListener() {},
    setAttribute(name, value) { element[name] = value },
    getAttribute(name) { return element[name] },
    removeAttribute() {},
    querySelectorAll() { return [] },
    querySelector() { return null },
    focus() { element.focused = true },
    select() { element.selected = true },
    showModal() { element.open = true },
    close() { element.open = false },
    scrollIntoView() { element.scrolled = true },
    remove() {},
    click() { element.onclick?.() },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 } },
    closest() { return null },
    contains() { return false },
    insertBefore() {},
    cloneNode() { return fakeElement(tag) },
    requestSubmit() { element.submitted = true },
    getContext() { return { putImageData() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }), measureText: (text) => ({ width: String(text).length * 8 }) } },
  }
  return element
}

function createById() {
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  return { byId, elements }
}

const liveRegions = new Map()

function liveRegion(id) {
  if (!liveRegions.has(id)) liveRegions.set(id, { id, textContent: "" })
  return liveRegions.get(id)
}

function installBrowserGlobals() {
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ textContent: text }),
    querySelectorAll: () => [],
    querySelector: () => fakeElement(),
    addEventListener() {},
    visibilityState: "visible",
    getElementById: (id) => (id === "live-region" || id === "live-region-alert" ? liveRegion(id) : null),
  }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.window = {
    addEventListener() {},
    confirm: () => true,
    open: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  }
  globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value } }
  globalThis.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height }
  }
  globalThis.requestAnimationFrame = () => 0
  globalThis.cancelAnimationFrame = () => {}
  globalThis.khungThoaiDesktop = {
    native: async () => ({ result: {} }),
    onTask(handler) { desktopCalls.tasks.push(handler) },
    cancelTask(id) { desktopCalls.cancelled.push(id) },
    projectBegin: async () => null,
  }
}

installBrowserGlobals()
const controllers = (name) => import(`../src/controllers/${name}.js`)

const baseArguments = (byId, state) => ({
  state,
  byId,
  status() {},
  checkpoint() {},
  render() {},
  renderPages() {},
  selectedPage: () => null,
  selectedBox: () => null,
  projectBusy: () => false,
  commitLiveForm() {},
  notify() {},
  listButton(label, onClick) {
    const button = fakeElement("button")
    button.textContent = label
    button.onclick = onClick
    return button
  },
  selectPage() {},
  selectBox() {},
  readTranslationSettings: () => ({}),
  isNativeReady: () => false,
})

test("task panel renders native progress, hides cancel for finished work, and keeps ten rows", async () => {
  const { byId } = createById()
  const { setupTasks } = await controllers("tasks")
  setupTasks(byId)
  assert.equal(desktopCalls.tasks.length, 1)
  const emit = desktopCalls.tasks[0]
  const panel = byId("task-panel")
  const list = byId("task-list")

  emit({ id: "a", operation: "ocr", stage: "đọc chữ", progress: 40, state: "running" })
  assert.equal(panel.hidden, false)
  assert.equal(list.children.length, 1)
  // #107: the task panel is a visual list, so its state changes are also announced.
  assert.equal(liveRegion("live-region").textContent, "ocr: đọc chữ.")
  const row = list.children[0]
  assert.equal(row.children[0].textContent, "ocr · đọc chữ")
  assert.equal(row.children[1].value, 40)
  assert.equal(row.children[1].getAttribute("aria-label"), "ocr · đọc chữ")
  const cancel = row.children.find((child) => child.tagName === "BUTTON")
  assert.ok(cancel, "running tasks expose a cancel button")
  cancel.click()
  assert.deepEqual(desktopCalls.cancelled, ["a"])
  emit({ id: "a", operation: "ocr", stage: "vẫn đang đọc", progress: 55, state: "running" })
  assert.equal(liveRegion("live-region").textContent, "ocr: đọc chữ.", "progress ticks stay silent")

  emit({ id: "a", operation: "ocr", stage: "xong", progress: 100, state: "done" })
  assert.equal(list.children[0].children.length, 2, "finished tasks drop the cancel button")
  assert.equal(liveRegion("live-region").textContent, "ocr: xong.")
  emit({ id: "b", operation: "redraw", stage: "hết bộ nhớ", progress: 10, state: "error" })
  assert.equal(liveRegion("live-region-alert").textContent, "redraw: hết bộ nhớ.", "errors are assertive")

  for (let index = 0; index < 11; index++) {
    emit({ id: `job-${index}`, operation: "redraw", stage: "chạy", progress: index, state: "running" })
  }
  assert.equal(list.children.length, 10, "the panel keeps only the ten most recent tasks")
})

test("a cancel press keeps the caret on the button and the panel leaves once the work ends", async () => {
  const { byId } = createById()
  const { setupTasks } = await controllers("tasks")
  setupTasks(byId)
  const emit = desktopCalls.tasks.at(-1)
  const panel = byId("task-panel")
  const list = byId("task-list")
  desktopCalls.cancelled.length = 0
  const cancelButton = () => list.children[0].children.find((child) => child.tagName === "BUTTON")

  emit({ id: "a", operation: "ocr", stage: "đọc chữ", progress: 10, state: "running" })
  globalThis.document.activeElement = cancelButton()

  emit({ id: "a", operation: "ocr", stage: "đang đọc", progress: 55, state: "running" })
  assert.equal(cancelButton().focused, true, "the progress tick must not drop the caret out of the panel")

  cancelButton().click()
  assert.deepEqual(desktopCalls.cancelled, ["a"], "one press cancels the task once")
  assert.equal(cancelButton().textContent, "Đang hủy…")
  assert.equal(cancelButton().getAttribute("aria-disabled"), "true")
  cancelButton().click()
  assert.deepEqual(desktopCalls.cancelled, ["a"], "a second press must not queue another cancellation")

  emit({ id: "a", operation: "ocr", stage: "xong", progress: 100, state: "done" })
  assert.equal(panel.hidden, true, "the panel hides when nothing is running or queued")
  assert.equal(list.children[0].children.length, 2)
  globalThis.document.activeElement = null
})

test("find and replace renders matches, jumps to boxes, and reports replacements", async () => {
  const { byId } = createById()
  const { setupDialogs } = await controllers("dialogs")
  const state = {
    pages: [{
      id: "p1",
      name: "page-1",
      boxes: [{ id: "b1", text: "Anh trai" }],
      unplaced: [{ text: "anh" }],
    }],
  }
  const events = []
  let busy = false
  const api = setupDialogs({
    ...baseArguments(byId, state),
    status: (message, error) => events.push(["status", message, error]),
    checkpoint: () => events.push(["checkpoint"]),
    render: () => events.push(["render"]),
    selectPage: (page) => events.push(["page", page.id]),
    selectBox: (box) => events.push(["box", box.id]),
    projectBusy: () => busy,
    commitLiveForm: () => events.push(["commit"]),
  })
  const dialog = byId("find-replace-dialog")
  const query = byId("find-query")
  const results = byId("find-results")

  api.openFind()
  assert.equal(dialog.open, true)
  assert.equal(query.focused, true)
  assert.equal(query.selected, true)
  assert.equal(byId("find-summary").textContent, "Nhập từ khóa để tìm trong toàn bộ chương.")
  assert.equal(results.children.length, 0)
  assert.deepEqual(events, [["commit"]])

  query.value = "anh"
  api.renderFindResults()
  assert.equal(byId("find-summary").textContent, "Tìm thấy 1 kết quả trong 1 mục.")
  assert.equal(results.children.length, 1)
  const matchButton = results.children[0].children[0]
  assert.match(matchButton.textContent, /^Trang 1 · Anh trai/)
  matchButton.click()
  assert.equal(dialog.open, false)
  assert.deepEqual(events.slice(-2), [["page", "p1"], ["box", "b1"]])

  byId("find-unplaced").checked = true
  api.renderFindResults()
  assert.equal(byId("find-summary").textContent, "Tìm thấy 2 kết quả trong 2 mục.")
  results.children[1].children[0].click()
  assert.equal(byId("queue-section").scrolled, true, "unplaced matches scroll the queue into view")

  byId("replace-text").value = "Em"
  query.value = "Anh"
  events.length = 0
  byId("replace-all-btn").onclick()
  assert.deepEqual(events.slice(0, 3), [["commit"], ["checkpoint"], ["render"]])
  assert.equal(state.pages[0].boxes[0].text, "Em trai")
  assert.equal(state.pages[0].unplaced[0].text, "Em")
  assert.deepEqual(events.at(-1), ["status", "Đã thay 2 vị trí trong 2 mục.", undefined])

  events.length = 0
  query.value = ""
  query.focused = false
  byId("replace-all-btn").onclick()
  assert.deepEqual(events, [], "validation errors render inside the dialog, not the status bar")
  assert.equal(byId("find-error").textContent, "Hãy nhập nội dung cần tìm.")
  assert.equal(query.getAttribute("aria-invalid"), "true")
  assert.equal(query.focused, true)

  query.value = "anh"
  query.oninput()
  assert.equal(byId("find-error").textContent, "")

  busy = true
  events.length = 0
  api.openFind()
  byId("replace-all-btn").onclick()
  assert.deepEqual(events, [
    ["status", "Hãy chờ tác vụ hiện tại hoàn tất.", true],
    ["status", "Hãy chờ tác vụ hiện tại hoàn tất.", true],
  ], "busy projects explain why find and replace did nothing")
  assert.equal(byId("open-shortcuts").onclick, api.openShortcuts)
})

test("the find dialog ships an in-dialog alert region for validation errors", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8")
  const dialog = html.slice(
    html.indexOf('id="find-replace-dialog"'),
    html.indexOf('id="shortcuts-dialog"'),
  )
  assert.match(dialog, /<p id="find-error"[^>]*role="alert"/)
  assert.match(html, /id="open-find"[^>]*Ctrl\+H \/ Ctrl\+F/)
})

test("chat setup exposes its panel controls and resolves the active skill", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupChat } = await controllers("chat")
  const api = setupChat({
    ...baseArguments(byId, state),
    editorSnapshot: () => ({}),
    selectedIndex: () => 0,
    onSkillChange() {},
    registerFontName() {},
    renderFontOptions() {},
    restoreHistory() {},
  })
  assert.deepEqual(Object.keys(api).sort(), ["close", "getActiveSkill", "open", "refreshModelBadge", "refreshWelcome", "syncProjectSession"])
  assert.equal(typeof api.getActiveSkill().id, "string")
  api.open()
  api.close()
})

test("export setup binds the script exporter and ignores exports without pages", async () => {
  const { byId } = createById()
  const state = { pages: [], exporting: false, openingProject: false }
  const statuses = []
  const { setupExports } = await controllers("export")
  setupExports({ ...baseArguments(byId, state), status: (message, error) => statuses.push([message, error]) })
  const scriptButton = byId("export-script")
  assert.equal(typeof scriptButton.onclick, "function")
  scriptButton.onclick()
  assert.deepEqual(statuses, [])
})

// Nixio #76. The board is driven through the dialog the user actually sees: the QA check opens it,
// each row carries its own state select and note, the filters narrow the list, and applying a
// suggestion edits the box before the re-run retires the row.
function qaRowControls(byId, findingId, tag) {
  const stack = [...byId("preflight-issues").children]
  while (stack.length) {
    const node = stack.shift()
    if (!node) continue
    if (node.dataset?.qaFinding === findingId && node.tagName === tag) return node
    if (Array.isArray(node.children)) stack.push(...node.children)
  }
  return null
}

function qaButton(byId, label) {
  const stack = [...byId("preflight-issues").children]
  while (stack.length) {
    const node = stack.shift()
    if (!node) continue
    if (node.tagName === "BUTTON" && node.textContent === label) return node
    if (Array.isArray(node.children)) stack.push(...node.children)
  }
  return null
}

test("the QA board stores a note with its state, filters rows, and applies the punctuation fix", async () => {
  const { byId } = createById()
  const box = (id, text) => ({
    id, text, x: .1, y: .1, w: .5, h: .25,
    size: 24, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true,
  })
  const page = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [box("b1", ""), box("b2", "Chào bạn  , đi thôi....")],
    unplaced: [],
  }
  const state = { pages: [page], queue: [], exporting: false, openingProject: false }
  const events = []
  const store = createQaReviewStore()
  const { setupExports } = await controllers("export")
  setupExports({
    ...baseArguments(byId, state),
    status: (message, error) => events.push(["status", message, error]),
    checkpoint: (snapshot, meta) => events.push(["checkpoint", meta?.kind]),
    render: () => events.push(["render"]),
    readTranslationSettings: () => ({}),
    qaReview: store,
  })

  byId("check-export").onclick()
  assert.equal(byId("preflight-dialog").open, true)
  assert.equal(byId("preflight-issues").children.length, 2)
  assert.equal(byId("qa-summary").textContent, "2 mục QA · 2 chờ xử lý · 0 đã xử lý · hiện 2")
  assert.equal(byId("qa-filter-state").value, "all")
  assert.match(byId("preflight-issues").children[0].children[0].textContent, /^01\.png · Cảnh báo — Khung thoại bị trống/)

  const emptyRow = byId("preflight-issues").children[0]
  const stateSelect = qaRowControls(byId, "1:0:empty_or_placeholder", "SELECT")
  const noteInput = qaRowControls(byId, "1:0:empty_or_placeholder", "INPUT")
  assert.equal(stateSelect.value, "open")

  // Ignoring a finding without a reason is refused in the row, not in the status bar.
  stateSelect.value = "ignored"
  stateSelect.onchange()
  assert.equal(emptyRow.children[2].textContent, "Bỏ qua một mục QA cần lý do.")
  assert.equal(store.size, 0)

  noteInput.value = "Trang bìa, không cần thoại"
  noteInput.onchange()
  assert.equal(emptyRow.children[2].textContent, "")
  assert.equal(store.entry("1:0:empty_or_placeholder").state, "ignored")
  assert.equal(store.entry("1:0:empty_or_placeholder").note, "Trang bìa, không cần thoại")
  assert.equal(byId("qa-summary").textContent, "2 mục QA · 1 chờ xử lý · 1 đã xử lý · hiện 2")

  byId("qa-filter-state").value = "ignored"
  byId("qa-filter-state").onchange()
  assert.equal(byId("preflight-issues").children.length, 1)
  assert.equal(byId("qa-summary").textContent, "2 mục QA · 1 chờ xử lý · 1 đã xử lý · hiện 1")

  byId("qa-filter-state").value = "all"
  byId("qa-filter-state").onchange()
  byId("qa-filter-severity").value = "info"
  byId("qa-filter-severity").onchange()
  assert.equal(byId("preflight-issues").children.length, 1)
  assert.equal(qaButton(byId, "Áp dụng & tiếp").textContent, "Áp dụng & tiếp")

  events.length = 0
  qaButton(byId, "Áp dụng & tiếp").onclick()
  assert.equal(page.boxes[1].text, "Chào bạn, đi thôi...")
  assert.deepEqual(events.slice(0, 2), [["checkpoint", "qa"], ["render"]])
  assert.equal(store.entry("1:1:punctuation_spacing"), null)
  assert.equal(byId("preflight-issues").children.length, 1, "the fixed row is retired by the re-run")
  assert.match(byId("preflight-issues").children[0].children[0].textContent, /bị trống nội dung/)
  assert.deepEqual(events.at(-1), ["status", "Đã sửa khung và đánh dấu mục QA là đã xử lý.", undefined])

  byId("close-preflight").onclick()
  assert.equal(byId("preflight-dialog").open, false)
})

test("a triage decision marks the project dirty and keeps the caret in the row it changed (#review)", async () => {
  const { byId } = createById()
  const page = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [{
      id: "b1", text: "", x: .1, y: .1, w: .5, h: .25,
      size: 24, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true,
    }],
    unplaced: [],
  }
  const state = { pages: [page], queue: [], exporting: false, openingProject: false }
  const store = createQaReviewStore()
  let changed = 0
  const { setupExports } = await controllers("export")
  setupExports({
    ...baseArguments(byId, state),
    readTranslationSettings: () => ({}),
    qaReview: store,
    changed: () => { changed++ },
  })
  // The board looks up the control it just painted the way the real DOM would.
  byId("preflight-issues").querySelectorAll = (selector) => {
    const wanted = /^\[data-qa-finding="(.*)"\]$/.exec(selector)?.[1]
    const found = []
    const stack = [...byId("preflight-issues").children]
    while (stack.length) {
      const node = stack.shift()
      if (!node) continue
      if (node.dataset?.qaFinding === wanted) found.push(node)
      if (Array.isArray(node.children)) stack.push(...node.children)
    }
    return found
  }

  byId("check-export").onclick()
  const id = "1:0:empty_or_placeholder"
  const select = qaRowControls(byId, id, "SELECT")
  assert.equal(changed, 0, "opening the board changes nothing")
  globalThis.document.activeElement = select
  select.value = "fixed"
  select.onchange()
  globalThis.document.activeElement = null

  assert.equal(store.entry(id).state, "fixed")
  // The decision records the text of the box it was taken on, so a later delete cannot slide it onto
  // whatever box inherits the position.
  assert.match(store.entry(id).boxStamp, /^[0-9a-f]{8}$/)
  assert.equal(changed, 1, "a decision is an unsaved change")
  const repainted = qaRowControls(byId, id, "SELECT")
  assert.notEqual(repainted, select, "the board repainted the row")
  assert.equal(repainted.value, "fixed")
  assert.equal(repainted.focused, true, "the caret stays on the control the user just used")
})

test("an open warning gates the export and continuing records the override as a decision", async () => {
  const { byId } = createById()
  const page = {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [{
      id: "b1", text: "", x: .1, y: .1, w: .5, h: .25,
      size: 24, font: "Arial", color: "#171717", align: "center", rotation: 0, fill: true,
    }],
    unplaced: [],
  }
  const state = { pages: [page], queue: [], exporting: false, openingProject: false }
  const store = createQaReviewStore()
  let changed = 0
  const { setupExports } = await controllers("export")
  setupExports({
    ...baseArguments(byId, state),
    readTranslationSettings: () => ({}),
    qaReview: store,
    changed: () => { changed++ },
  })

  byId("check-export").onclick()
  assert.equal(byId("continue-export").textContent, "Duyệt cảnh báo & xuất")
  assert.equal(changed, 0, "opening the board changes nothing")
  byId("continue-export").onclick()
  assert.equal(store.entry("1:0:empty_or_placeholder").state, "accepted")
  assert.equal(store.entry("1:0:empty_or_placeholder").note, qaExportOverrideNote)
  // Regression for #140: the override has to mark the project dirty or the acceptances are never saved.
  assert.equal(changed, 1, "recording the override is an unsaved change")
  assert.equal(byId("preflight-dialog").open, false)

  // The decision is visible the next time the board opens, so the gate no longer counts the row.
  byId("check-export").onclick()
  assert.equal(byId("continue-export").textContent, "Vẫn xuất")
  assert.equal(byId("qa-summary").textContent, "1 mục QA · 0 chờ xử lý · 1 đã xử lý · hiện 1")
})

test("gesture setup tracks pressed space and updates the zoom label", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupGestures } = await controllers("gestures")
  const api = setupGestures({
    ...baseArguments(byId, state),
    stage: fakeElement(),
    overlays: fakeElement(),
    pageCanvas: fakeElement(),
    viewport: fakeElement(),
    editorSnapshot: () => ({}),
    toggleSelectBox() {},
    addBox() {},
    freezeCleanup() {},
    rectStyle: () => ({}),
    paintPreview() {},
    renderCleanupOverlay() {},
    renderCanvas() {},
    renderInspector() {},
    changePage() {},
  })
  assert.equal(api.getSpaceHeld(), false)
  api.setSpaceHeld(true)
  assert.equal(api.getSpaceHeld(), true)
  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "100%")
  state.zoom = 1.5
  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "150%")
  assert.equal(api.abortGesture(), null)
  api.cancelPendingPaint()
})

test("split compare handle takes focus on drag and adjusts the curtain from keys", async () => {
  const { byId } = createById()
  const state = { pages: [], splitPos: 50 }
  const { setupGestures } = await controllers("gestures")
  setupGestures({
    ...baseArguments(byId, state),
    stage: fakeElement(),
    overlays: fakeElement(),
    pageCanvas: fakeElement(),
    viewport: fakeElement(),
    editorSnapshot: () => ({}),
    toggleSelectBox() {},
    addBox() {},
    freezeCleanup() {},
    rectStyle: () => ({}),
    paintPreview() {},
    renderCleanupOverlay() {},
    renderCanvas() {},
    renderInspector() {},
    changePage() {},
  })
  const handle = byId("split-handle")

  const pointerEvent = {
    pointerId: 1, clientX: 62,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
  handle.dispatch("pointerdown", pointerEvent)
  assert.equal(handle.focused, true, "dragging the curtain moves focus to the handle")
  assert.equal(state.splitPos, 62, "pointer position maps to curtain percent")
  assert.equal(handle.getAttribute("aria-valuenow"), "62")
  assert.equal(handle.getAttribute("aria-valuetext"), "Rèm ở 62%")

  const keyEvent = (key, shiftKey = false) => ({
    key, shiftKey,
    defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  })
  const right = keyEvent("ArrowRight")
  handle.dispatch("keydown", right)
  assert.equal(state.splitPos, 64)
  assert.equal(right.stopped, true, "handle keys must not bubble to page/document handlers")
  const up = keyEvent("ArrowUp", true)
  handle.dispatch("keydown", up)
  assert.equal(state.splitPos, 54, "Shift+Arrow jumps 10%")
  handle.dispatch("keydown", keyEvent("End"))
  assert.equal(state.splitPos, 100)
  handle.dispatch("keydown", keyEvent("Home"))
  assert.equal(state.splitPos, 0)
})

test("OCR setup wires its dialog controls and stops without a selected page", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  const { setupOcr } = await controllers("ocr")
  setupOcr({ ...baseArguments(byId, state), notifyOverflowIfAny() {} })
  assert.equal(typeof byId("preview-ocr").onclick, "function")
  assert.equal(typeof byId("run-local-ocr").onclick, "function")
  assert.equal(typeof byId("cancel-ocr").onclick, "function")
  await byId("run-local-ocr").onclick()
  assert.equal(state.processingNative, undefined)
  byId("cancel-ocr").onclick()
  assert.equal(byId("ocr-review").open, false)
})

test("OCR review announces its result because the dialog leaves the status line inert", async () => {
  const { byId } = createById()
  const state = { pages: [], processingNative: false }
  const page = {
    id: "p1",
    name: "1.png",
    boxes: [],
    unplaced: [],
    image: { naturalWidth: 100, naturalHeight: 100 },
  }
  const statuses = []
  const previousNative = globalThis.khungThoaiDesktop.native
  globalThis.khungThoaiDesktop.native = async () => ({
    result: { lines: [{ text: "Xin chào", confidence: 90, box: [100, 100, 400, 200] }] },
  })
  const { setupOcr } = await controllers("ocr")
  setupOcr({
    ...baseArguments(byId, state),
    selectedPage: () => page,
    status: (message, error) => statuses.push([message, error]),
    notifyOverflowIfAny() {},
  })
  byId("direction").value = "rtl"

  await byId("run-local-ocr").onclick()
  globalThis.khungThoaiDesktop.native = previousNative

  assert.equal(byId("ocr-review").open, true)
  assert.equal(statuses.some(([, error]) => error), false, "the review path reports success instead of an error")
  assert.equal(
    liveRegion("live-region").textContent,
    "Đã nhận dạng 1 vùng chữ trên máy. Sửa nội dung trước khi đặt lên trang.",
  )
})

test("project setup assigns a project id and exposes dirty state helpers", async () => {
  const { byId } = createById()
  const state = { pages: [], projectId: undefined }
  const { setupProjects } = await controllers("project")
  const api = setupProjects({
    ...baseArguments(byId, state),
    projectSettings: [],
    defaultProjectSettings: {},
    history: { clear() {}, push() {} },
    openImage() {},
    selectedIndex: () => 0,
    updateFitLabel() {},
    releaseUnusedImages() {},
    hasGesture: () => false,
    onCapabilities() {},
    onProjectSwitch() {},
  })
  assert.match(state.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(api.ready, false)
  assert.equal(byId("native-status").getAttribute("role"), "status")
  assert.equal(byId("native-status").getAttribute("aria-live"), "polite")
  assert.equal(typeof api.changed, "function")
  assert.equal(typeof api.refreshDirty, "function")
  assert.equal(typeof byId("new-project").onclick, "function")
})

test("translation setup reads provider, endpoint, and target settings from the form", async () => {
  const { byId } = createById()
  const state = { pages: [] }
  byId("translation-provider").value = "openai"
  byId("llm-base-url").value = " http://localhost:11434/v1 "
  byId("llm-model").value = "llama"
  byId("source-language").value = "ja"
  byId("target-language").value = "vi"
  byId("translation-notes").value = " ghi chú "
  const { setupTranslation } = await controllers("translation")
  const api = setupTranslation({
    ...baseArguments(byId, state),
    renderInspector() {},
    renderCanvas() {},
    pageForScript: () => null,
    applyTranslation() {},
    onSettingsChange() {},
    notifyOverflowIfAny() {},
  })
  const settings = api.settings()
  assert.equal(settings.provider, "openai")
  assert.equal(settings.baseUrl, "http://localhost:11434/v1")
  assert.equal(settings.llmModel, "llama")
  assert.equal(settings.source, "ja")
  assert.equal(settings.target, "vi")
  assert.equal(settings.notes, "ghi chú")
  assert.equal(typeof settings.skillPrompt, "string")

  // The glossary stays one textarea; the status line reads the terminology graph out of it.
  byId("translation-glossary").value = "五条悟 = Gojo Satoru\n@alias 五条先生\n先生 = Thầy"
  assert.equal(api.refreshGlossaryStatus(), "2 thuật ngữ · 0 liên kết")
  byId("translation-glossary").value = "五条悟 = Gojo Satoru\n@bogus x"
  byId("translation-glossary").dispatch("input")
  assert.match(byId("glossary-status").textContent, /^1 thuật ngữ · 0 liên kết · 1 dòng cần xem lại: Chỉ thị "@bogus" không được hỗ trợ\.$/)
})

function setupZoom({ state, page, canvasWidth }) {
  const { byId } = createById()
  const pageCanvas = fakeElement()
  let scale = canvasWidth / page.image.naturalWidth
  const viewport = fakeElement()
  viewport.scrollLeft = 0
  viewport.scrollTop = 0
  viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 520 })
  pageCanvas.getBoundingClientRect = () => ({
    left: -viewport.scrollLeft,
    top: -viewport.scrollTop,
    width: Math.round(page.image.naturalWidth * scale),
    height: Math.round(page.image.naturalHeight * scale),
  })
  const renders = []
  return controllers("gestures").then(({ setupGestures }) => {
    const api = setupGestures({
      ...baseArguments(byId, state),
      state,
      selectedPage: () => page,
      stage: fakeElement(),
      overlays: fakeElement(),
      pageCanvas,
      viewport,
      editorSnapshot: () => ({}),
      toggleSelectBox() {},
      addBox() {},
      freezeCleanup() {},
      rectStyle: (element, rect) => rect,
      paintPreview() {},
      renderCleanupOverlay() {},
      renderCanvas() {
        scale = state.zoom ?? scale
        renders.push(state.zoom)
      },
      renderInspector() {},
      changePage() {},
    })
    return { api, byId, viewport, pageCanvas, renders }
  })
}

test("a brush gesture on a full stack without a brush layer is refused and explained", async () => {
  const { byId } = createById()
  const page = {
    image: { naturalWidth: 400, naturalHeight: 600 },
    boxes: [],
    layers: defaultLayers(),
    retouchStrokes: [],
  }
  removeLayer(page, page.layers.find((layer) => layer.kind === "retouch").id)
  while (page.layers.length < layerLimit) addLayer(page, "cleanup")
  byId("cleanup-tool").value = "paint"
  byId("brush-size").value = "20"
  byId("paint-opacity").value = "100"
  byId("paint-color").value = "#ffffff"

  const statuses = []
  const stage = fakeElement()
  let captured = 0
  stage.setPointerCapture = () => { captured++ }
  const { setupGestures } = await controllers("gestures")
  setupGestures({
    ...baseArguments(byId, { pages: [] }),
    status: (message, error) => statuses.push([message, error]),
    t: (key) => "T:" + key,
    selectedPage: () => page,
    stage,
    overlays: fakeElement(),
    pageCanvas: fakeElement(),
    viewport: fakeElement(),
    editorSnapshot: () => ({}),
    toggleSelectBox() {},
    addBox() {},
    freezeCleanup() {},
    rectStyle: (element, rect) => rect,
    paintPreview() {},
    renderCleanupOverlay() {},
    renderCanvas() {},
    renderInspector() {},
    changePage() {},
  })

  stage.dispatch("pointerdown", {
    pointerId: 1, button: 0, clientX: 10, clientY: 10, preventDefault() {},
  })
  assert.deepEqual(statuses, [["T:status.retouch.noLayer", true]])
  assert.equal(captured, 0, "no drag starts when the stroke could never paint")
  assert.deepEqual(page.retouchStrokes, [])
})

test("zoom-out follows the measured scale instead of snapping up from Fit", async () => {
  const state = { pages: [], zoom: null, fit: true }
  const page = { id: "p1", name: "page-1", boxes: [], image: { naturalWidth: 4000, naturalHeight: 6000 } }
  const { byId, renders } = await setupZoom({ state, page, canvasWidth: 720 })

  byId("zoom-out").onclick()
  assert.ok(state.zoom < 0.18, `zoom-out from the 18% fit shrinks the page, got ${state.zoom}`)
  assert.equal(renders.length, 1)
  assert.equal(state.fit, false)

  state.zoom = null
  state.fit = true
  byId("zoom-in").onclick()
  assert.equal(state.zoom, 0.25, "zoom-in still picks the next step above the measured scale")
})

test("the zoom readout shows the measured scale while the page is fitted", async () => {
  const state = { pages: [], zoom: null, fit: true }
  const page = { id: "p1", name: "page-1", boxes: [], image: { naturalWidth: 4000, naturalHeight: 6000 } }
  const { api, byId } = await setupZoom({ state, page, canvasWidth: 720 })

  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "18%", "Fit reports the real percentage, not a label")
  state.zoom = 1.25
  api.updateZoomDisplay()
  assert.equal(byId("zoom-level").textContent, "125%")
})

test("ctrl+wheel keeps the image point under the cursor after zooming", async () => {
  const state = { pages: [], zoom: null, fit: true }
  const page = { id: "p1", name: "page-1", boxes: [], image: { naturalWidth: 4000, naturalHeight: 6000 } }
  const { viewport, pageCanvas } = await setupZoom({ state, page, canvasWidth: 2000 })

  const cursor = { clientX: 1000, clientY: 500 }
  const area = pageCanvas.getBoundingClientRect()
  const before = { x: (cursor.clientX - area.left) / area.width, y: (cursor.clientY - area.top) / area.height }
  let prevented = false
  viewport.dispatch("wheel", { ...cursor, ctrlKey: true, deltaY: -100, preventDefault() { prevented = true } })

  assert.equal(prevented, true)
  assert.ok(state.zoom > 0.5, `the wheel zooms in, got ${state.zoom}`)
  const after = pageCanvas.getBoundingClientRect()
  assert.ok(Math.abs((cursor.clientX - after.left) / after.width - before.x) < 1e-9, "x anchor holds")
  assert.ok(Math.abs((cursor.clientY - after.top) / after.height - before.y) < 1e-9, "y anchor holds")
  assert.ok(viewport.scrollLeft > 0 && viewport.scrollTop > 0, "the viewport scrolls to keep the anchor")
})

test("the token accounting panel shows the running cost, takes a price, warns and resets", async () => {
  const { byId } = createById()
  const { setupUsage } = await controllers("usage")
  const { createUsageLedger } = await import("../src/token-accounting.js")
  const store = new Map()
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  }
  const ledger = createUsageLedger({ storage, projectKey: () => "project-a", sessionId: "s1", now: () => 1000 })
  const notices = []
  setupUsage({ byId, ledger, notify: (notice) => notices.push(notice), pageId: () => "p1" })

  const chip = byId("chat-usage")
  assert.equal(chip.hidden, true, "nothing is shown before the first paid call")

  // An unpriced model is still counted, and the row says so.
  ledger.record({ provider: "gemini", model: "auto", pageId: "p1", tokens: { promptTokens: 1200, completionTokens: 300 } })
  assert.equal(chip.hidden, false)
  assert.match(chip.textContent, /1\.5k token/)
  assert.match(chip.textContent, /0\.0000 \$/)
  assert.match(byId("usage-summary").textContent, /Phiên này: 1\.5k token/)
  const models = byId("usage-models")
  assert.equal(models.children.length, 1)
  assert.match(models.children[0].children[0].textContent, /chưa đặt giá/)

  // Typing a price in the row stores it for the next call, and the row loses the "no price" note.
  const inputs = models.children[0].children[1].children.map((label) => label.children[0])
  inputs[0].value = "1"
  inputs[1].value = "2"
  inputs[2].value = "0.5"
  inputs[0].onchange()
  assert.equal(ledger.snapshot().prices["gemini:auto"].inputPerMTok, 1)
  assert.doesNotMatch(byId("usage-models").children[0].children[0].textContent, /chưa đặt giá/)
  ledger.record({ provider: "gemini", model: "auto", pageId: "p1", tokens: { promptTokens: 1000, completionTokens: 100 } })
  // 1000 input at 1 $/M plus 100 output at 2 $/M.
  assert.match(chip.textContent, /2\.6k token · 0\.0012 \$/)

  // The budget input drives the ledger, and crossing the threshold raises one warning.
  byId("usage-budget-limit").value = "0.001"
  byId("usage-budget-limit").onchange()
  assert.equal(ledger.snapshot().budget.limitUsd, 0.001)
  ledger.record({ provider: "gemini", model: "auto", pageId: "p1", tokens: { promptTokens: 1000 } })
  const budgetNotice = notices.find((notice) => notice.key === "usage-budget")
  assert.ok(budgetNotice, "the threshold crossing is announced")
  assert.equal(budgetNotice.kind, "error")
  assert.match(budgetNotice.message, /Lượt gọi AI tiếp theo sẽ bị chặn/)
  assert.equal(ledger.gate().blocked, true)

  // Reset clears the spend but keeps the price table and the limit.
  byId("usage-reset").onclick()
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.totals.calls, 0)
  assert.equal(snapshot.prices["gemini:auto"].outputPerMTok, 2)
  assert.equal(snapshot.budget.limitUsd, 0.001)
  assert.equal(ledger.gate().blocked, false)
  assert.equal(chip.hidden, false, "a configured budget keeps the chip visible at zero spend")
  assert.equal(notices.at(-1).key, "usage-reset")
})

test("a box translation books its usage per page, and a spent budget refuses the next batch", async () => {
  const { byId } = createById()
  const page = {
    id: "p1",
    name: "01.png",
    file: { name: "01.png", type: "image/png", size: 100 },
    boxes: [{ id: "b1", text: "こんにちは" }],
    unplaced: [],
  }
  const state = { pages: [page], pageId: "p1", translating: false }
  byId("translation-provider").value = "gemini"
  byId("gemini-model").value = "gemini-3.1-flash-lite"
  // The credential inputs are cleared when the vault scope binds at setup, so the key is typed after it.
  byId("source-language").value = "Japanese"
  byId("target-language").value = "Vietnamese"
  byId("direction").value = "rtl"

  const { createUsageLedger } = await import("../src/token-accounting.js")
  const store = new Map()
  const ledger = createUsageLedger({
    storage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    projectKey: () => "project-a",
    sessionId: "s1",
    now: () => 1000,
  })

  const statuses = []
  const notices = []
  const originalFetch = globalThis.fetch
  const originalFileReader = globalThis.FileReader
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,AAAA"
      queueMicrotask(() => this.onload())
    }
  }
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify({ lines: [{ id: "B1", text: "Xin chào" }] }) }] },
      }],
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 20 },
    }),
  })
  try {
    const { setupTranslation } = await controllers("translation")
    setupTranslation({
      ...baseArguments(byId, state),
      selectedPage: () => page,
      renderInspector() {},
      renderCanvas() {},
      pageForScript: () => null,
      applyTranslation() {},
      onSettingsChange() {},
      notifyOverflowIfAny() {},
      status: (message) => statuses.push(message),
      notify: (notice) => notices.push(notice),
      usageLedger: ledger,
    })
    // The vault scope binds during setup and clears both key fields, so the key is typed after it.
    byId("gemini-key").value = "test-key"

    // The user's price table decides what this call costs: 1500 input tokens at 1000 $/M.
    ledger.setPrice("gemini", "gemini-3.1-flash-lite", { inputPerMTok: 1000, outputPerMTok: 0, cachedPerMTok: 0 })
    await byId("translate-boxes").onclick()
    assert.equal(page.boxes[0].text, "Xin chào")
    const afterBox = ledger.snapshot({ pageId: "p1" })
    assert.equal(afterBox.totals.calls, 1)
    assert.equal(afterBox.totals.totalTokens, 1520)
    assert.equal(afterBox.page.totalTokens, 1520)
    assert.equal(afterBox.models[0].model, "gemini-3.1-flash-lite")
    assert.equal(afterBox.totals.costUsd, 1.5)
    assert.equal(afterBox.totals.unpricedCalls, 0)
    // A limit the next call cannot afford refuses the whole batch before any page is sent.
    ledger.setBudget({ limitUsd: 0.000001, warnPercent: 80 })
    const callsBefore = ledger.snapshot().totals.calls
    await byId("translate-all").onclick()
    assert.equal(ledger.snapshot().totals.calls, callsBefore, "a refused batch books nothing")
    assert.match(statuses.at(-1), /hạn mức chi phí AI/)
    assert.ok(notices.some((notice) => notice.key === "usage-budget-stop"))
  } finally {
    globalThis.fetch = originalFetch
    globalThis.FileReader = originalFileReader
  }
})
