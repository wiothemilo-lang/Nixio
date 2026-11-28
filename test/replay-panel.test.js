import assert from "node:assert/strict"
import test from "node:test"
import { setupReplay } from "../src/controllers/replay.js"
import { createTurnRecorder } from "../src/agent-replay.js"
import { translate } from "../src/i18n.js"
import { SLASH_COMMANDS_HELP, parseSlashCommand } from "../src/agent-commands.js"
import { loadProjectTurnRecords } from "../src/chat-storage.js"

function fakeElement(tag = "div") {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    hidden: false,
    disabled: false,
    open: false,
    textContent: "",
    type: "",
    onclick: null,
    append(...nodes) { element.children.push(...nodes) },
    replaceChildren(...nodes) { element.children = nodes },
    click() { if (!element.disabled) element.onclick?.() },
  }
  return element
}

function findAll(root, predicate, found = []) {
  for (const child of root.children || []) {
    if (predicate(child)) found.push(child)
    if (child && typeof child === "object") findAll(child, predicate, found)
  }
  return found
}

const byClass = (root, className) => findAll(root, (node) => node.className === className)

function installBrowserGlobals() {
  const store = new Map()
  globalThis.document = { createElement: (tag) => fakeElement(tag) }
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
  return store
}

function makePanel(options = {}) {
  const ids = [
    "chat-replay", "chat-replay-list", "chat-replay-empty",
    "chat-replay-trace", "chat-replay-export", "chat-replay-clear",
  ]
  const elements = new Map(ids.map((id) => [id, fakeElement(id === "chat-replay-list" ? "ol" : "div")]))
  const writes = []
  let project = "proj-a"
  const panel = setupReplay({
    byId: (id) => elements.get(id) ?? null,
    projectId: () => project,
    notify: () => {},
    writeFile: (blob, filename) => writes.push({ blob, filename }),
    ...options,
  })
  return {
    panel,
    elements,
    writes,
    setProject: (value) => { project = value },
  }
}

function recordFor({ id, approve = "approved", tool = "list_boxes", status = "completed", category = "read" } = {}) {
  const recorder = createTurnRecorder({ id, now: () => 1000 })
  recorder.begin({ provider: "gemini", model: "gemini-3.1-flash-lite", userMessage: "Đọc trang 1" })
  recorder.step({
    step: 1,
    text: "Đã đọc",
    usage: { promptTokens: 1200, outputTokens: 34, cachedTokens: 200 },
    toolCalls: [{ name: tool }],
  })
  recorder.tool({
    step: 1,
    entry: {
      id: "tc1",
      name: tool,
      args: { boxId: "b1" },
      category,
      ok: approve !== "rejected",
      approvalRequired: approve !== "not-required",
      code: approve === "rejected" ? "TOOL_APPROVAL_REJECTED" : null,
      summary: approve === "rejected" ? "Người dùng đã từ chối thực thi thao tác." : "Đã xong",
      durationMs: 20,
    },
  })
  recorder.step({ step: 2, text: "Hoàn tất", toolCalls: [] })
  recorder.finish({ status, elapsedMs: 1500 })
  return recorder.snapshot()
}

test("a turn record can be saved under the project the turn started in", async () => {
  installBrowserGlobals()
  const { panel } = makePanel()
  const record = recordFor({ id: "turn-project-switch" })
  assert.equal(panel.save(record, "proj-b"), true)
  assert.deepEqual(loadProjectTurnRecords("proj-a"), [], "the active project does not inherit another turn's record")
  assert.equal(loadProjectTurnRecords("proj-b").length, 1)
  assert.equal(panel.save(record), true)
  assert.equal(loadProjectTurnRecords("proj-a").length, 1, "the default remains the active project")
})

test("the step usage line follows the active locale", async () => {
  installBrowserGlobals()
  const { panel, elements } = makePanel({ t: (key, params) => translate("en", key, params) })
  assert.equal(panel.save(recordFor({ id: "turn-en" })), true)
  assert.equal((await panel.open("turn-en")).ok, true)
  const usage = byClass(elements.get("chat-replay-trace"), "chat-replay-usage")
  assert.equal(usage.length, 1)
  assert.match(usage[0].textContent, /1\.2k in/)
  assert.match(usage[0].textContent, /34 out/)
  assert.match(usage[0].textContent, /200 cached/)
})

test("the replay panel lists recorded turns, replays one offline and highlights a broken transcript", async (t) => {
  const originalFetch = globalThis.fetch
  installBrowserGlobals()
  t.after(() => { globalThis.fetch = originalFetch })
  let fetched = 0
  globalThis.fetch = async () => {
    fetched++
    throw new Error("bảng phát lại không được gọi nhà cung cấp")
  }

  const { panel, elements, writes } = makePanel()
  const exportBtn = elements.get("chat-replay-export")
  const clearBtn = elements.get("chat-replay-clear")
  const trace = elements.get("chat-replay-trace")
  const list = elements.get("chat-replay-list")
  const empty = elements.get("chat-replay-empty")

  assert.deepEqual(panel.refresh(), [])
  assert.equal(empty.hidden, false)
  assert.equal(clearBtn.disabled, true)

  // No project yet: the panel refuses instead of inventing a bucket.
  const missingProject = makePanel()
  assert.equal((await missingProject.panel.open("latest")).ok, false)

  assert.equal(panel.save(recordFor({ id: "turn-a" })), true)
  assert.equal(panel.save(recordFor({ id: "turn-b", approve: "rejected", tool: "delete_box", category: "write" })), true)
  assert.equal(list.children.length, 2)
  assert.equal(empty.hidden, true)
  assert.equal(clearBtn.disabled, false)
  assert.match(list.children[0].children[0].textContent, /turn-b/)
  assert.match(list.children[0].children[0].textContent, /Hoàn tất/)

  const opened = await panel.open("turn-b")
  assert.equal(opened.ok, true)
  assert.match(opened.message, /khớp bản ghi/)
  assert.equal(elements.get("chat-replay").open, true)
  assert.equal(trace.hidden, false)
  assert.equal(exportBtn.disabled, false)
  const tools = byClass(trace, "chat-replay-tool")
  assert.equal(tools.length, 1)
  assert.equal(tools[0].dataset.state, "match")
  assert.equal(tools[0].dataset.category, "write")
  assert.match(tools[0].children.find((child) => child.className === "chat-replay-badge").textContent, /bị từ chối/)
  assert.equal(byClass(trace, "chat-replay-end").length, 1)
  assert.equal(fetched, 0)

  // Clicking the row button replays through the same path.
  list.children[1].children[1].click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(trace.children[0].textContent, /turn-a/)
  // #142 follow-up: a step shows the provider's own counts instead of only the turn total.
  const usage = byClass(trace, "chat-replay-usage")
  assert.equal(usage.length, 1)
  assert.match(usage[0].textContent, /1\.2k vào/)
  assert.match(usage[0].textContent, /34 ra/)
  assert.match(usage[0].textContent, /200 đệm/)

  // A truncated transcript is shown as a difference, not silently accepted.
  const broken = recordFor({ id: "turn-broken" })
  broken.tools = []
  panel.save(broken)
  const brokenOpen = await panel.open("turn-broken")
  assert.equal(brokenOpen.ok, true)
  assert.match(brokenOpen.message, /khác biệt/)
  const differences = byClass(trace, "chat-replay-diff")
  assert.equal(differences.length, 1)
  assert.equal(differences[0].dataset.count, "1")
  assert.match(differences[0].children[0].textContent, /số lần gọi/)

  assert.equal(panel.exportSelected(), true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].filename, "nixio-luot-turn-broken.json")
  assert.ok(writes[0].blob)

  assert.equal(panel.clearAll(), true)
  assert.equal(list.children.length, 0)
  assert.equal(trace.hidden, true)
  assert.equal(exportBtn.disabled, true)
  assert.deepEqual(loadProjectTurnRecords("proj-a"), [])

  const unknown = await panel.open("turn-nope")
  assert.equal(unknown.ok, false)
  assert.match(unknown.message, /Không tìm thấy bản ghi/)
  const nothing = await panel.open("latest")
  assert.equal(nothing.ok, false)
  assert.match(nothing.message, /Chưa có bản ghi/)
})

test("the play button of a listed turn replays that turn with its results, not the latest", async () => {
  installBrowserGlobals()
  const { panel, elements, setProject } = makePanel()
  panel.save(recordFor({ id: "turn-first" }))
  panel.save(recordFor({ id: "turn-second" }))
  const trace = elements.get("chat-replay-trace")

  const listed = elements.get("chat-replay-list").children
  assert.equal(listed.length, 2)
  listed[1].children[1].click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.match(trace.children[0].textContent, /turn-first/)

  // Another project has its own bucket of transcripts.
  setProject("proj-b")
  panel.refresh()
  assert.equal(elements.get("chat-replay-list").children.length, 0)
  assert.equal((await panel.open("latest")).ok, false)
})

test("/replay resolves the newest record or a named one", () => {
  assert.deepEqual(parseSlashCommand("/replay"), { kind: "replay", id: "latest" })
  assert.deepEqual(parseSlashCommand("/replay last"), { kind: "replay", id: "latest" })
  assert.deepEqual(parseSlashCommand("/replay turn-abc"), { kind: "replay", id: "turn-abc" })
  assert.match(SLASH_COMMANDS_HELP, /\/replay \[id\|latest\]/)
})

test("a play button with nothing to play says so instead of doing nothing (#review)", async () => {
  installBrowserGlobals()
  const ids = ["chat-replay", "chat-replay-list", "chat-replay-empty", "chat-replay-trace", "chat-replay-export", "chat-replay-clear"]
  const elements = new Map(ids.map((id) => [id, fakeElement(id === "chat-replay-list" ? "ol" : "div")]))
  const notifications = []
  const panel = setupReplay({
    byId: (id) => elements.get(id) ?? null,
    projectId: () => "proj-a",
    notify: (notification) => notifications.push(notification),
  })
  panel.save(recordFor({ id: "turn-gone" }))
  const listed = elements.get("chat-replay-list").children
  assert.equal(listed.length, 1)

  // The record is gone by the time the row is clicked: a stored transcript was cleared elsewhere.
  const { clearProjectTurnRecords } = await import("../src/chat-storage.js")
  clearProjectTurnRecords("proj-a")
  listed[0].children[1].click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].kind, "error")
  assert.match(notifications[0].message, /turn-gone/)
})
