import assert from "node:assert/strict"
import test from "node:test"

function fakeElement(tag = "div") {
  const listeners = new Map()
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    open: false,
    textContent: "",
    title: "",
    href: "",
    target: "",
    rel: "",
    type: "",
    scrollTop: 0,
    scrollHeight: 0,
    focused: false,
    onclick: null,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    appendChild(node) { element.children.push(node); return node },
    addEventListener(type, handler) { listeners.set(type, handler) },
    removeEventListener(type) { listeners.delete(type) },
    dispatch(type, event) { return listeners.get(type)?.(event) },
    setAttribute(name, value) { element[name] = String(value) },
    getAttribute(name) { return element[name] },
    removeAttribute(name) { delete element[name] },
    querySelectorAll() { return [] },
    querySelector() { return null },
    focus() { element.focused = true; globalThis.document.activeElement = element },
    remove() { element.removed = true },
    click() { if (!element.disabled) element.onclick?.() },
    requestSubmit() { element.submitted = true },
  }
  return element
}

function findAll(root, predicate, found = []) {
  for (const child of root.children || []) {
    if (predicate(child)) found.push(child)
    findAll(child, predicate, found)
  }
  return found
}

const byClass = (root, className) => findAll(root, (node) => node.className === className)
const byButtonLabel = (root, label) =>
  findAll(root, (node) => node.tagName === "BUTTON" && String(node.textContent || "").trim() === label)

function textOf(node) {
  if (!node) return ""
  if (node.nodeType === 3) return String(node.textContent || "")
  return (node.children || []).map(textOf).join("")
}

const reviewLabelText = (row) => findAll(row, (node) => node.className === "chat-review-label")[0]?.textContent ?? ""
const reviewNoteText = (row) => findAll(row, (node) => node.className === "chat-review-note")[0]?.textContent ?? ""

function installBrowserGlobals() {
  const store = new Map()
  const listeners = new Map()
  globalThis.document = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelectorAll: () => [],
    querySelector: () => null,
    activeElement: null,
    addEventListener(type, handler) { listeners.set(type, handler) },
    dispatch(type, event) { return listeners.get(type)?.(event) },
  }
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  globalThis.Option = class {
    constructor(text, value) { this.text = text; this.value = value }
  }
  return store
}

function geminiPayload(parts) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ candidates: [{ content: { role: "model", parts } }] }),
  })
}

const geminiText = (text) => geminiPayload([{ text }])
const geminiPlan = (plan) => geminiPayload([{ functionCall: { name: "submit_plan", args: { plan } } }])
const geminiStatus = (status) => Promise.resolve({ ok: false, status, headers: { get: () => null } })

function hangingFetch(init) {
  return new Promise((resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    const abort = () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function drain() {
  for (let i = 0; i < 12; i++) await tick()
}

const planMarkdown = "# Kế hoạch rà soát toàn chương\n- Bước 1: đọc lời thoại.\n- Bước 2: sửa thuật ngữ."

function sessionHistory() {
  return [
    { role: "user", text: "Nhân vật chính tên gì?" },
    { role: "assistant", text: "Nhân vật chính là Wiothemilo." },
    { role: "user", text: "Dịch trang 1 giúp mình." },
    { role: "assistant", text: "Đã dịch trang 1." },
    { role: "user", text: "Xưng hô cậu/tớ nhé." },
    { role: "assistant", text: "Đã chốt xưng hô cậu/tớ." },
  ]
}

async function createHarness({ prepareStorage, pages = [], replay = null, t = null } = {}) {
  installBrowserGlobals()
  prepareStorage?.()
  const elements = new Map()
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id))
    return elements.get(id)
  }
  const chips = ["Tra thuật ngữ", "/autofit", "/qc", "Rà xưng hô", "Lập kế hoạch"].map((prompt) => {
    const chip = fakeElement("button")
    chip.dataset.chatPrompt = prompt
    return chip
  })
  const panel = byId("chat-panel")
  panel.querySelectorAll = (selector) => (selector === "[data-chat-prompt]" ? chips : [])
  byId("gemini-key").value = "test-key"
  byId("chat-allow-edits").checked = true
  byId("chat-allow-web").checked = false
  byId("chat-confirm-bulk").checked = true
  byId("chat-review-changes").checked = true

  let busy = false
  const fetchCalls = []
  let fetchHandler = (index) => geminiText(`Phản hồi ${index}`)
  globalThis.fetch = (url, init) => {
    fetchCalls.push({ url, init })
    return fetchHandler(fetchCalls.length - 1, init)
  }

  const checkpoints = []
  const notifications = []
  const state = { pages, projectId: "project-1" }
  const { setupChat } = await import("../src/controllers/chat.js")
  const chat = setupChat({
    state,
    byId,
    checkpoint(snapshot, meta) { checkpoints.push({ snapshot, meta }) },
    editorSnapshot: () => ({}),
    render() {},
    selectedPage: () => state.pages[0] ?? null,
    selectedIndex: () => 0,
    selectPage() {},
    projectBusy: () => busy,
    commitLiveForm() {},
    readTranslationSettings: () => ({
      provider: "gemini",
      model: "gemini-2.5-flash",
      source: "Japanese",
      target: "Vietnamese",
      direction: "ltr",
      notes: "",
      glossary: "",
    }),
    onSkillChange() {},
    registerFontName() {},
    renderFontOptions() {},
    notify(notification) { notifications.push(notification) },
    restoreHistory() {},
    replay,
    ...(t ? { t } : {}),
  })

  return {
    byId,
    chat,
    chips,
    checkpoints,
    document: globalThis.document,
    fetchCalls,
    notifications,
    panel,
    state,
    setBusy(value) { busy = value },
    setFetch(handler) { fetchHandler = handler },
    submit(text) {
      const input = byId("chat-input")
      if (text !== undefined) input.value = text
      byId("chat-form").onsubmit({ preventDefault() {} })
    },
    status: () => byId("chat-status").textContent,
    messages: () => byId("chat-messages").children,
    planCard() {
      return byClass(byId("chat-messages"), "chat-plan-card")[0]
    },
    reviewCard() {
      return byClass(byId("chat-messages"), "chat-review-card").at(-1)
    },
    reviewRows() {
      const card = this.reviewCard()
      return card ? byClass(card, "chat-review-item") : []
    },
  }
}

function planCardControls(harness) {
  const card = harness.planCard()
  assert.ok(card, "plan card should be rendered")
  const badge = byClass(card, "chat-badge")[0]
  const execBtn = byButtonLabel(card, "Thực thi kế hoạch")[0]
    || byButtonLabel(card, "Thử lại thực thi")[0]
  assert.ok(badge && execBtn, "plan card should expose a badge and an execute button")
  return { card, badge, execBtn }
}

test("plan execution refuses read-only projects without flipping the edit switch", async () => {
  const harness = await createHarness()
  harness.byId("chat-plan-mode").checked = true
  harness.byId("chat-allow-edits").checked = false
  harness.setFetch((index) => (index === 0 ? geminiPlan(planMarkdown) : geminiText("Đã gửi kế hoạch để bạn duyệt.")))

  harness.submit("/plan Rà soát toàn bộ chương")
  await drain()

  const { badge, execBtn } = planCardControls(harness)
  assert.equal(badge.textContent, "Chờ duyệt")
  const fetchesBefore = harness.fetchCalls.length
  execBtn.click()
  assert.equal(harness.fetchCalls.length, fetchesBefore, "read-only refusal must not start a turn")
  assert.equal(harness.byId("chat-allow-edits").checked, false, "edit permission stays untouched")
  assert.equal(harness.byId("chat-plan-mode").checked, true, "plan mode survives the refusal")
  assert.equal(badge.textContent, "Chờ duyệt")
  assert.equal(execBtn.disabled, false, "the plan can be executed once edits are enabled")
  assert.match(harness.status(), /quyền sửa/)
})

test("plan execution rejects busy projects without lying and retries after release", async () => {
  const harness = await createHarness()
  harness.byId("chat-plan-mode").checked = true
  harness.setFetch((index) => (index === 0 ? geminiPlan(planMarkdown) : geminiText("Đã chạy xong các bước.")))

  harness.submit("/plan Khảo sát và lập kế hoạch")
  await drain()
  const { badge, execBtn } = planCardControls(harness)

  harness.setBusy(true)
  const fetchesBefore = harness.fetchCalls.length
  execBtn.click()
  assert.equal(harness.fetchCalls.length, fetchesBefore)
  assert.equal(badge.textContent, "Chờ duyệt", "rejected admission must not claim progress")
  assert.equal(execBtn.disabled, false, "the button stays available for a retry")
  assert.equal(harness.byId("chat-plan-mode").checked, true)
  assert.match(harness.status(), /chờ tác vụ hiện tại/i)

  harness.setBusy(false)
  execBtn.click()
  assert.equal(badge.textContent, "Đang thực thi")
  assert.equal(execBtn.disabled, true)
  assert.equal(harness.byId("chat-plan-mode").checked, false, "plan mode ends only after admission")
  assert.equal(harness.byId("chat-allow-edits").checked, true)

  await drain()
  assert.equal(badge.textContent, "Hoàn tất")
  assert.equal(execBtn.disabled, true)
  assert.match(String(harness.fetchCalls[2].init.body), /Kế hoạch đã được duyệt/)
})

test("failed plan execution reports failure and offers a working retry", async () => {
  const harness = await createHarness()
  harness.byId("chat-plan-mode").checked = true
  harness.setFetch((index) => {
    if (index === 0) return geminiPlan(planMarkdown)
    if (index === 1) return geminiText("Đã gửi kế hoạch để bạn duyệt.")
    if (index === 2) return geminiStatus(400)
    return geminiText("Đã chạy lại kế hoạch.")
  })

  harness.submit("/plan Lập kế hoạch")
  await drain()
  const { badge, execBtn } = planCardControls(harness)

  execBtn.click()
  await drain()
  assert.equal(badge.textContent, "Thất bại")
  assert.equal(execBtn.disabled, false)
  assert.equal(execBtn.textContent, "Thử lại thực thi")
  assert.equal(harness.byId("chat-allow-edits").checked, true)
  assert.equal(harness.byId("chat-plan-mode").checked, false)

  execBtn.click()
  assert.equal(badge.textContent, "Đang thực thi")
  await drain()
  assert.equal(badge.textContent, "Hoàn tất")
  assert.equal(execBtn.disabled, true)
  assert.equal(execBtn.textContent, "Thực thi kế hoạch")
})

test("cancelled plan execution releases the badge and allows another attempt", async () => {
  const harness = await createHarness()
  harness.byId("chat-plan-mode").checked = true
  harness.setFetch((index, init) => {
    if (index === 0) return geminiPlan(planMarkdown)
    if (index === 1) return geminiText("Đã gửi kế hoạch để bạn duyệt.")
    return hangingFetch(init)
  })

  harness.submit("/plan Lập kế hoạch")
  await drain()
  const { badge, execBtn } = planCardControls(harness)

  execBtn.click()
  assert.equal(badge.textContent, "Đang thực thi")
  await drain()
  harness.byId("chat-stop").onclick()
  await drain()
  assert.equal(badge.textContent, "Đã dừng")
  assert.equal(execBtn.disabled, false)
  assert.equal(execBtn.textContent, "Thử lại thực thi")
  assert.equal(harness.byId("chat-send").disabled, false)
  assert.equal(harness.byId("chat-stop").hidden, true)
})

test("a rejected plan command keeps the draft and current plan mode", async () => {
  const harness = await createHarness()
  const planMode = harness.byId("chat-plan-mode")
  planMode.checked = false
  harness.setBusy(true)
  harness.submit("/plan Rà soát chương")
  assert.equal(harness.byId("chat-input").value, "/plan Rà soát chương")
  assert.equal(planMode.checked, false)
  assert.equal(harness.fetchCalls.length, 0)
})

test("busy submission keeps the draft and disables every chat control", async () => {
  const harness = await createHarness()
  harness.setBusy(true)
  const input = harness.byId("chat-input")
  input.value = "Dịch lại khung 3"
  harness.submit()
  assert.equal(input.value, "Dịch lại khung 3", "rejected submissions keep the draft")
  assert.equal(harness.fetchCalls.length, 0)
  assert.match(harness.status(), /chờ tác vụ hiện tại/i)

  harness.setBusy(false)
  harness.setFetch((index, init) => hangingFetch(init))
  harness.submit()
  assert.equal(input.value, "")
  assert.equal(input.disabled, true)
  assert.equal(harness.byId("chat-send").disabled, true)
  assert.equal(harness.byId("chat-compact").disabled, true)
  assert.equal(harness.byId("chat-clear").disabled, true)
  assert.equal(harness.chips.every((chip) => chip.disabled), true)
  assert.equal(harness.byId("chat-stop").hidden, false, "stop stays reachable while work is cancellable")
  assert.equal(harness.panel.getAttribute("aria-busy"), "true")

  input.value = "Bản nháp mới"
  harness.submit()
  assert.equal(input.value, "Bản nháp mới", "a rejection never deletes newer text")

  const messageCount = harness.messages().length
  harness.chips[0].onclick()
  assert.match(harness.status(), /AI đang xử lý/)
  harness.byId("chat-clear").onclick()
  harness.byId("chat-compact").onclick()
  assert.equal(harness.messages().length, messageCount, "busy clear and compact leave the session alone")
  assert.equal(harness.fetchCalls.length, 1)

  harness.byId("chat-stop").onclick()
  await drain()
  assert.equal(harness.status(), "Đã dừng.")
  assert.equal(input.disabled, false)
  assert.equal(harness.byId("chat-send").disabled, false)
  assert.equal(harness.byId("chat-compact").disabled, false)
  assert.equal(harness.byId("chat-clear").disabled, false)
  assert.equal(harness.chips.every((chip) => chip.disabled === false), true)
  assert.equal(harness.byId("chat-stop").hidden, true)
  assert.equal(harness.panel.getAttribute("aria-busy"), "false")
  assert.equal(input.value, "Bản nháp mới")
})

test("the welcome card follows the active locale", async () => {
  const { translate } = await import("../src/i18n.js")
  const harness = await createHarness({ t: (key, params) => translate("en", key, params) })
  const welcome = byClass(harness.byId("chat-messages"), "chat-msg system")[0]
  assert.match(welcome.textContent, /AI assistant Harness v3/)
  assert.doesNotMatch(welcome.textContent, /Trợ lý AI/)
})

test("a project switch during AI compaction hands the panel back to the new project", async () => {
  const { loadProjectChatSession, saveProjectChatSession } = await import("../src/chat-storage.js")
  const harness = await createHarness()
  saveProjectChatSession("project-1", { history: sessionHistory(), todos: [] })
  saveProjectChatSession("project-2", { history: [{ role: "user", text: "Câu cũ của dự án 2" }], todos: [] })
  harness.chat.syncProjectSession()
  harness.setFetch((index, init) => hangingFetch(init))

  harness.submit("/compact ai")
  await drain()
  assert.equal(harness.byId("chat-stop").hidden, false)

  harness.state.projectId = "project-2"
  harness.chat.syncProjectSession()
  harness.byId("chat-stop").onclick()
  await drain()

  // The old project keeps its compacted transcript, but the panel now shows the open project's own
  // chat, so the next prompt cannot append project 1's rows to project 2.
  assert.deepEqual(loadProjectChatSession("project-1").history, sessionHistory(), "the old project's transcript is untouched")
  assert.match(textOf(harness.byId("chat-messages")), /Câu cũ của dự án 2/)
  assert.doesNotMatch(textOf(harness.byId("chat-messages")), /Nhân vật chính tên gì/)

  harness.setFetch(() => geminiText("Trả lời của dự án 2"))
  harness.submit("Câu hỏi mới")
  await drain()
  assert.deepEqual(
    loadProjectChatSession("project-2").history.map((message) => message.text),
    ["Câu cũ của dự án 2", "Câu hỏi mới", "Trả lời của dự án 2"],
  )
})

test("AI compaction disables the composer, releases on cancel, and reports failures", async () => {
  const harness = await createHarness({
    prepareStorage: () => {
      globalThis.localStorage.setItem(
        "khung-thoai-chat-sessions",
        JSON.stringify({ "project-1": { history: sessionHistory(), todos: [], updatedAt: 1 } }),
      )
    },
  })
  const input = harness.byId("chat-input")
  harness.setFetch((index, init) => hangingFetch(init))

  harness.submit("/compact ai")
  assert.equal(input.value, "")
  assert.equal(input.disabled, true, "AI compaction owns the composer")
  assert.equal(harness.byId("chat-send").disabled, true)
  assert.equal(harness.byId("chat-compact").disabled, true)
  assert.equal(harness.byId("chat-clear").disabled, true)
  assert.equal(harness.chips.every((chip) => chip.disabled), true)
  assert.equal(harness.byId("chat-stop").hidden, false)
  assert.equal(harness.panel.getAttribute("aria-busy"), "true")
  assert.equal(harness.status(), "Đang dùng AI tóm tắt ngữ cảnh…")

  harness.byId("chat-stop").onclick()
  await drain()
  assert.equal(harness.status(), "Đã dừng tóm tắt ngữ cảnh.")
  assert.equal(input.disabled, false)
  assert.equal(harness.byId("chat-send").disabled, false)
  assert.equal(harness.byId("chat-compact").disabled, false)
  assert.equal(harness.chips.every((chip) => chip.disabled === false), true)
  assert.equal(harness.panel.getAttribute("aria-busy"), "false")

  harness.setFetch(() => geminiStatus(400))
  harness.submit("/compact ai")
  await drain()
  assert.match(harness.status(), /^Không tóm tắt được bằng AI:/)
  assert.equal(input.disabled, false, "failures restore the composer")
  assert.equal(harness.byId("chat-stop").hidden, true)
  assert.equal(harness.chips.every((chip) => chip.disabled === false), true)

  const fetchesBefore = harness.fetchCalls.length
  harness.submit("/help")
  await drain()
  assert.equal(input.value, "")
  assert.equal(harness.fetchCalls.length, fetchesBefore, "slash commands stay offline and keep working")
  assert.match(textOf(harness.messages().at(-1)), /Các lệnh nhanh/)
  assert.equal(harness.byId("chat-send").disabled, false)
  assert.equal(input.disabled, false)
})

// The desktop shell owns the provider credential: chat is handed a provider and an operation, and the
// key never enters a request envelope. `providerStream` answers with the same fixed code main uses when
// nothing is stored for the scope, so both the success and the rejection path are covered here.
const CHAT_DESKTOP_SECRET = "sk-renderer-chat-must-not-travel-51bd"

function installDesktopProvider(t, { credentialError = false, answer = "Đã kiểm tra trang 1." } = {}) {
  const requests = []
  let listener = null
  const frames = [
    {
      type: "chunk",
      ticket: "t1",
      text: "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }) + "\n\n",
    },
    { type: "end", ticket: "t1" },
  ]
  const previous = globalThis.khungThoaiDesktop
  globalThis.khungThoaiDesktop = {
    async providerRequest(envelope) {
      requests.push(JSON.parse(JSON.stringify(envelope)))
      return { ok: false, code: "ERR_PROVIDER_POLICY", message: "The buffered path is not used here." }
    },
    async providerStream(envelope) {
      requests.push(JSON.parse(JSON.stringify(envelope)))
      if (credentialError) {
        return {
          ok: false,
          code: "ERR_PROVIDER_CREDENTIAL",
          message: "No usable API key is stored for this provider and endpoint.",
        }
      }
      return { ok: true, status: 200, contentType: "sse", ticket: "t1" }
    },
    async providerActivate() {
      queueMicrotask(() => { for (const frame of frames) listener?.(frame) })
      return { ok: true, active: true }
    },
    providerCancel: () => ({ ok: true }),
    onProviderEvent(callback) {
      listener = callback
      return () => { listener = null }
    },
    async credentialStatus() {
      return { stored: true, supported: true, protection: "safeStorage", reason: null }
    },
    async credentialSave() { return { stored: true } },
    async credentialRemove() { return { removed: true } },
  }
  t.after(() => {
    if (previous === undefined) delete globalThis.khungThoaiDesktop
    else globalThis.khungThoaiDesktop = previous
  })
  return requests
}

// The password field reports every read, so "the desktop never takes the key" is a recorded fact.
function watchSecretField(element) {
  const reads = []
  let held = CHAT_DESKTOP_SECRET
  Object.defineProperty(element, "value", {
    configurable: true,
    get() { reads.push("read"); return held },
    set(next) { held = String(next ?? "") },
  })
  return reads
}

test("a desktop chat turn uses the vault and never reads or sends the password field", async (t) => {
  const harness = await createHarness()
  const requests = installDesktopProvider(t)
  const reads = watchSecretField(harness.byId("gemini-key"))

  harness.submit("Xin chào")
  await drain()

  assert.deepEqual(reads, [], "the desktop must not read the key field")
  assert.equal(harness.fetchCalls.length, 0, "a desktop turn must not fall back to the renderer fetch")
  assert.equal(requests.length, 1)
  assert.deepEqual(
    Object.keys(requests[0]).sort(),
    ["model", "operation", "payload", "provider", "requestId", "timeoutMs"],
    "the envelope names a provider, an operation and a deadline, never a key or a URL",
  )
  assert.equal(JSON.stringify(requests).includes(CHAT_DESKTOP_SECRET), false)
  assert.match(textOf(harness.messages().at(-1)), /Đã kiểm tra trang 1\./)
})

test("a desktop chat turn with no stored key reports the vault in Vietnamese", async (t) => {
  const harness = await createHarness()
  const requests = installDesktopProvider(t, { credentialError: true })
  const reads = watchSecretField(harness.byId("gemini-key"))

  harness.submit("Xin chào")
  await drain()

  assert.deepEqual(reads, [], "a missing credential is main's answer, not a reason to read the field")
  assert.equal(harness.fetchCalls.length, 0)
  assert.equal(requests.length, 1)
  const errorCard = byClass(harness.byId("chat-messages"), "chat-msg error").at(-1)
  assert.ok(errorCard, "the failed turn is reported in the transcript")
  assert.match(String(errorCard.textContent), /Chưa có khóa API Gemini trong kho bảo mật/)
  assert.equal(
    String(errorCard.textContent).includes("No usable API key"),
    false,
    "main's own wording is not shown",
  )
})

test("a finished AI turn leaves the caret in the field the user moved to", async () => {
  const harness = await createHarness()
  harness.setFetch(() => geminiText("Đã kiểm tra trang 1."))
  const input = harness.byId("chat-input")
  const editorField = harness.byId("box-text")
  harness.document.activeElement = input

  harness.submit("Rà lỗi chính tả trang 1.")
  // The user leaves the composer for the inspector while the turn is still running.
  harness.document.activeElement = editorField
  await drain()
  assert.equal(input.focused, false, "the turn must not pull the caret out of the inspector")
  assert.equal(harness.document.activeElement, editorField)
  assert.match(harness.status(), /Hoàn tất/)
})

test("the composer takes the caret back while the user stays in the panel", async () => {
  const harness = await createHarness()
  harness.setFetch(() => geminiText("Đã kiểm tra trang 1."))
  const input = harness.byId("chat-input")
  harness.panel.contains = (node) => node === input
  harness.document.activeElement = input

  harness.submit("Rà lỗi chính tả trang 1.")
  await drain()

  assert.equal(input.focused, true, "typing the next message must not need another click")
})

test("closing the chat panel hands the caret back to its toggle and Escape closes it too", async () => {
  const harness = await createHarness()
  const toggle = harness.byId("open-chat")
  const close = harness.byId("chat-close")
  const panel = harness.panel
  panel.hidden = false
  panel.contains = (node) => node === close
  harness.document.activeElement = close

  close.onclick()
  assert.equal(panel.hidden, true)
  assert.equal(toggle.getAttribute("aria-pressed"), "false")
  assert.equal(toggle.focused, true, "the × hands the caret back to the button that opened the panel")

  toggle.onclick()
  assert.equal(panel.hidden, false)
  assert.equal(harness.byId("chat-input").focused, true, "opening still moves into the composer")

  harness.document.activeElement = close
  harness.document.dispatch("keydown", { key: "Escape" })
  assert.equal(panel.hidden, true, "Escape is the keyboard twin of the ×")
  assert.equal(toggle.focused, true)
})

test("an Escape that belongs to the editor closes the panel without stealing the caret", async () => {
  const harness = await createHarness()
  const panel = harness.panel
  const editorField = harness.byId("box-text")
  panel.hidden = false
  harness.document.activeElement = editorField

  harness.document.dispatch("keydown", { key: "Escape" })
  assert.equal(panel.hidden, true)
  assert.equal(harness.byId("open-chat").focused, false, "a field outside the panel keeps the caret")

  harness.document.dispatch("keydown", { key: "Escape" })
  assert.equal(panel.hidden, true, "Escape on a closed panel changes nothing")
})

// #91: the transcript must not drag a reader back to the end while an answer streams, so the test
// drives a real SSE stream and scrolls away between two deltas.
function streamingResponse() {
  const encoder = new TextEncoder()
  let controller = null
  const body = new ReadableStream({ start(inner) { controller = inner } })
  const send = (text) => controller.enqueue(encoder.encode(
    "data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }) + "\n\n",
  ))
  return {
    body,
    send,
    close: () => controller.close(),
    response: () => Promise.resolve({ ok: true, status: 200, headers: { get: () => "text/event-stream" }, body }),
  }
}

test("streaming follows the tail until the reader scrolls back and offers a jump control", async () => {
  const harness = await createHarness()
  const stream = streamingResponse()
  harness.setFetch(() => stream.response())
  const messages = harness.byId("chat-messages")
  const jump = harness.byId("chat-jump")
  Object.defineProperty(messages, "clientHeight", { configurable: true, get: () => 100 })
  Object.defineProperty(messages, "scrollHeight", {
    configurable: true,
    get: () => (messages.children.length ? 400 : 0),
  })

  harness.submit("Dịch trang 1")
  await drain()
  stream.send("Phần một.")
  await drain()
  assert.equal(messages.scrollTop, 400, "a reader at the tail follows the stream")

  messages.scrollTop = 0
  messages.dispatch("scroll")

  stream.send("Phần hai.")
  await drain()
  assert.equal(messages.scrollTop, 0, "a later delta must not drag the reader back")
  assert.equal(jump.hidden, false, "leaving the tail offers the jump control")

  jump.click()
  assert.equal(messages.scrollTop, 400, "the jump control returns to the newest output")
  assert.equal(jump.hidden, true)
  assert.equal(harness.byId("chat-input").focused, true)

  stream.close()
  await drain()
  assert.equal(messages.scrollTop, 400, "the finished turn keeps the tail pinned")
})

function reviewPage() {
  return {
    id: "p1",
    name: "01.png",
    image: { naturalWidth: 800, naturalHeight: 1200 },
    boxes: [{ id: "b1", text: "Cũ", x: 0.1, y: 0.1, w: 0.3, h: 0.1, size: 24, font: "Arial", color: "#000000", align: "center" }],
    unplaced: [],
  }
}

const geminiCall = (name, args) => Promise.resolve({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] }),
})

test("AI edits wait for per-change approval and land as one named history action", async () => {
  const page = reviewPage()
  const harness = await createHarness({ pages: [page] })
  harness.setFetch((index) => (
    index === 0
      ? geminiCall("update_box", { boxId: "b1", text: "Mới", size: 32 })
      : geminiText("Đã đề xuất thay đổi.")
  ))

  harness.submit("Đổi lời thoại khung 1")
  await drain()

  assert.equal(page.boxes[0].text, "Cũ", "nothing is written before the user approves")
  assert.equal(page.boxes[0].size, 24)
  assert.equal(harness.checkpoints.length, 0, "no history entry before approval")

  const card = harness.reviewCard()
  assert.ok(card, "the review card should be rendered")
  const rows = harness.reviewRows()
  assert.equal(rows.length, 2, "one row per changed field")
  assert.match(reviewLabelText(rows[0]), /Tr\.1 · Nội dung: Cũ → Mới/)
  assert.equal(rows[0].dataset.status, "pending")

  byButtonLabel(card, "Áp dụng mục đã chọn")[0].click()

  assert.equal(page.boxes[0].text, "Mới")
  assert.equal(page.boxes[0].size, 32)
  assert.equal(harness.checkpoints.length, 1, "the whole review is one history action")
  assert.equal(harness.checkpoints[0].meta.kind, "ai")
  assert.match(harness.checkpoints[0].meta.label, /Chấp nhận 2 thay đổi từ Trợ lý AI/)
  assert.equal(rows[0].dataset.status, "applied")
  assert.match(byClass(card, "chat-badge")[0].textContent, /Đã áp dụng 2/)
})

test("rejecting a change keeps the project untouched and remembers the refusal", async () => {
  const page = reviewPage()
  const harness = await createHarness({ pages: [page] })
  let turnCalls = 0
  const propose = () => {
    turnCalls = 0
    harness.setFetch(() => (
      turnCalls++ === 0 ? geminiCall("update_box", { boxId: "b1", text: "Mới" }) : geminiText("Đã đề xuất.")
    ))
  }

  propose()
  harness.submit("Đổi lời thoại khung 1")
  await drain()
  const card = harness.reviewCard()
  byButtonLabel(card, "Từ chối tất cả")[0].click()

  assert.equal(page.boxes[0].text, "Cũ", "a rejected change keeps the live state")
  assert.equal(harness.checkpoints.length, 0, "a rejection records no history action")
  assert.match(harness.status(), /từ chối 1 thay đổi/i)
  assert.equal(harness.reviewRows()[0].dataset.status, "rejected")

  // The same proposal in a later turn is flagged instead of being raced through.
  propose()
  harness.submit("Đổi lời thoại khung 1 lần nữa")
  await drain()
  const second = harness.reviewCard()
  const row = byClass(second, "chat-review-item")[0]
  assert.equal(findAll(second, (node) => node.className === "chat-review-note").length, 1)
  assert.match(reviewNoteText(row), /trước đây/)
  assert.equal(findAll(second, (node) => node.className === "chat-review-check")[0].checked, false)
  assert.equal(page.boxes[0].text, "Cũ")

  byButtonLabel(second, "Áp dụng mục đã chọn")[0].click()
  assert.equal(page.boxes[0].text, "Cũ", "unchecked rows are still not applied")
})

test("a trusted turn applies without a click but still records every change", async () => {
  const page = reviewPage()
  const harness = await createHarness({ pages: [page] })
  harness.byId("chat-review-changes").checked = false
  harness.setFetch((index) => (
    index === 0 ? geminiCall("update_box", { boxId: "b1", text: "Mới" }) : geminiText("Đã sửa.")
  ))

  harness.submit("Đổi lời thoại khung 1")
  await drain()

  assert.equal(page.boxes[0].text, "Mới", "trusted mode applies directly")
  assert.equal(harness.checkpoints.length, 1, "still one named history action")
  assert.match(harness.checkpoints[0].meta.label, /Chấp nhận 1 thay đổi/)
  const card = harness.reviewCard()
  assert.ok(card, "the change list is recorded even when auto-applied")
  assert.equal(harness.reviewRows()[0].dataset.status, "applied")
  assert.match(byClass(card, "chat-badge")[0].textContent, /Đã áp dụng 1/)
})

test("a turn that changes nothing explains why in Vietnamese", async () => {
  const harness = await createHarness()
  harness.setFetch(() => geminiText("Khung này không tràn chữ."))
  harness.submit("Khung này có tràn chữ không?")
  await drain()

  const note = byClass(harness.byId("chat-messages"), "chat-msg system").at(-1)
  assert.match(note.textContent, /Lượt này không có thay đổi nào được áp dụng/)
  assert.match(note.textContent, /không gọi công cụ ghi nào/)

  harness.byId("chat-plan-mode").checked = true
  harness.submit("/plan Lập kế hoạch rà soát")
  await drain()
  const planNote = byClass(harness.byId("chat-messages"), "chat-msg system").at(-1)
  assert.ok(planNote, "a plan-mode turn still reports its own reason")
})

test("an Escape that belongs to a dialog leaves the panel open (#review)", async () => {
  const harness = await createHarness()
  const panel = harness.panel
  panel.hidden = false
  // A modal owns Escape while it is open: closing the panel behind it would drop the dialog's host.
  const dialog = fakeElement("dialog")
  harness.document.querySelector = (selector) => (selector === "dialog[open]" ? dialog : null)
  harness.document.dispatch("keydown", { key: "Escape" })
  assert.equal(panel.hidden, false)

  harness.document.querySelector = () => null
  harness.document.dispatch("keydown", { key: "Escape" })
  assert.equal(panel.hidden, true, "with no dialog open Escape closes the panel again")
})

test("a project switch during a turn keeps the transcript in the project the turn started in (#review)", async () => {
  const { loadProjectChatSession } = await import("../src/chat-storage.js")
  const harness = await createHarness()
  const stream = streamingResponse()
  harness.setFetch(() => stream.response())
  harness.submit("Đọc trang 1")
  await drain()

  // The user opens another project while the answer is still streaming.
  harness.state.projectId = "project-2"
  harness.chat.syncProjectSession()
  // The rows above still belong to the first project: the panel says so instead of letting the new
  // project's header sit over a conversation that belongs to the other one.
  const notice = byClass(harness.byId("chat-messages"), "chat-msg system").at(-1)
  // The notice is written as text nodes, so the collector reads them, not textContent.
  assert.match(textOf(notice), /thuộc dự án vừa rời/)
  stream.send("Đã đọc trang 1.")
  stream.close()
  await drain()

  const started = loadProjectChatSession("project-1").history
  assert.ok(started.length >= 2, "the turn lands in the project it started in")
  assert.equal(started.at(-1).text, "Đã đọc trang 1.")
  assert.deepEqual(loadProjectChatSession("project-2").history, [], "nothing leaks into the project the user opened")
})

test("a replay record of a turn stays in the project the turn started in (#review)", async () => {
  const saved = []
  const harness = await createHarness({
    replay: {
      save: (record, projectId) => { saved.push({ record, projectId }); return true },
      refresh() {},
    },
  })
  const stream = streamingResponse()
  harness.setFetch(() => stream.response())
  harness.submit("Đọc trang 1")
  await drain()
  harness.state.projectId = "project-2"
  harness.chat.syncProjectSession()
  stream.send("Đã đọc trang 1.")
  stream.close()
  await drain()

  assert.ok(saved.length >= 1, "the finished turn was recorded for replay")
  assert.ok(saved.every((entry) => entry.projectId === "project-1"), "the record follows the turn, not the open project")
})

test("a project opened mid-turn gets its own chat back when the turn ends (#review)", async () => {
  const { loadProjectChatSession, saveProjectChatSession } = await import("../src/chat-storage.js")
  const harness = await createHarness()
  // A project that already has a chat of its own, loaded the way the editor loads one.
  saveProjectChatSession("project-1", { history: [{ role: "user", text: "Câu cũ của dự án 1" }], todos: [] })
  harness.chat.syncProjectSession()
  assert.match(textOf(harness.byId("chat-messages")), /Câu cũ của dự án 1/)

  const stream = streamingResponse()
  harness.setFetch(() => stream.response())
  harness.submit("Đọc trang 1")
  await drain()

  // The editor opens project 2 while the answer is still streaming, exactly like main.js does.
  harness.state.projectId = "project-2"
  harness.chat.syncProjectSession()
  stream.send("Đã đọc trang 1.")
  stream.close()
  await drain()

  // Project 1 keeps the whole exchange, and the panel stops showing it under project 2.
  assert.equal(loadProjectChatSession("project-1").history.at(-1).text, "Đã đọc trang 1.")
  assert.doesNotMatch(textOf(harness.byId("chat-messages")), /Đọc trang 1/)

  // The next prompt in project 2 starts from that project's own chat, not from project 1's.
  harness.setFetch(() => geminiText("Trả lời của dự án 2"))
  harness.submit("Câu hỏi mới")
  await drain()
  assert.deepEqual(
    loadProjectChatSession("project-2").history.map((message) => message.text),
    ["Câu hỏi mới", "Trả lời của dự án 2"],
  )
})
