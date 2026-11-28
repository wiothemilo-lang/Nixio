import assert from "node:assert/strict"
import test from "node:test"
import { runAgentTurn, summarizeHistoryWithLlm } from "../src/agent-harness.js"
import { createUsageLedger } from "../src/token-accounting.js"

function fakeStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
}

function fakeTools() {
  return {
    definitions: () => [{
      name: "list_boxes",
      description: "Đọc danh sách khung",
      parameters: { type: "object", properties: {} },
    }],
    categoryOf: () => "read",
    execute: async () => ({ ok: true, summary: "1 khung", data: { boxes: [] } }),
    getTodos: () => [],
    getPlan: () => null,
    getRuntimeSnapshot: () => ({ pageCount: 1 }),
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => payload,
  }
}

const openAiSettings = {
  provider: "openai",
  baseUrl: "http://localhost:11434/v1",
  llmModel: "qwen2.5:7b",
  source: "Japanese",
  target: "Vietnamese",
}

function makeLedger(projectKey = () => "project-a") {
  return createUsageLedger({ storage: fakeStorage(), projectKey, sessionId: "s1", now: () => 1000 })
}

test("runAgentTurn books the provider usage of every step and reports the turn total", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: "Đã kiểm tra xong." } }],
    usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 200 } },
  })

  const ledger = makeLedger()
  ledger.setPrice("openai", "qwen2.5:7b", { inputPerMTok: 0.5, outputPerMTok: 1.5, cachedPerMTok: 0.1 })
  const events = []
  const result = await runAgentTurn({
    userMessage: "Kiểm tra khung thoại",
    settings: openAiSettings,
    tools: fakeTools(),
    accounting: {
      record: (call) => ledger.record(call),
      gate: () => ledger.gate(),
    },
    onEvent: (event) => events.push(event),
  })

  // Measured counts come from the provider answer, cached tokens included.
  assert.equal(result.usageTotals.calls, 1)
  assert.equal(result.usageTotals.promptTokens, 1200)
  assert.equal(result.usageTotals.completionTokens, 80)
  assert.equal(result.usageTotals.cachedTokens, 200)
  assert.equal(result.usageTotals.totalTokens, 1280)
  assert.equal(result.usageTotals.estimatedCalls, 0)
  // 1000 uncached input at 0.5 $/M + 200 cached at 0.1 $/M + 80 output at 1.5 $/M.
  assert.equal(Math.round(result.usageTotals.costUsd * 1e6) / 1e6, 0.00064)

  const snapshot = ledger.snapshot()
  assert.equal(snapshot.totals.calls, 1)
  assert.equal(snapshot.totals.totalTokens, 1280)
  assert.equal(snapshot.session.calls, 1)
  assert.equal(snapshot.models[0].model, "qwen2.5:7b")
  assert.equal(snapshot.models[0].price.inputPerMTok, 0.5)
  assert.equal(result.budgetBlocked, false)

  const usageEvent = events.find((event) => event.type === "usage")
  assert.equal(usageEvent.accounting.call.kind, "chat")
  assert.equal(usageEvent.accounting.turn.totalTokens, 1280)
})

test("an unpriced model is still counted, and the turn total says it has no price", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  // A local server that reports no usage block at all: the counts fall back to an estimate.
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: "Đã xong." } }],
  })

  const ledger = makeLedger()
  const result = await runAgentTurn({
    userMessage: "Chào bạn",
    settings: openAiSettings,
    tools: fakeTools(),
    accounting: {
      record: (call) => ledger.record(call),
      gate: () => ledger.gate(),
    },
  })

  assert.equal(result.usageTotals.calls, 1)
  assert.ok(result.usageTotals.promptTokens > 0, "the prompt size gives an estimate")
  assert.equal(result.usageTotals.estimatedCalls, 1)
  assert.equal(result.usageTotals.unpricedCalls, 1)
  assert.equal(result.usageTotals.costUsd, 0)
  assert.equal(ledger.snapshot().totals.unpricedCalls, 1)
})

test("the soft budget refuses the step that would spend past the limit", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls++
    return jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "list_boxes", arguments: "{}" } }],
        },
      }],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    })
  }

  const ledger = makeLedger()
  // 900 prompt tokens at 2000 $/M cost 1.8 $: the first step fits no budget, so the real gate blocks
  // the second one.
  ledger.setPrice("openai", "qwen2.5:7b", { inputPerMTok: 2000, outputPerMTok: 0, cachedPerMTok: 0 })
  ledger.setBudget({ limitUsd: 1, warnPercent: 80 })
  const events = []
  const result = await runAgentTurn({
    userMessage: "Kiểm tra toàn bộ trang",
    settings: openAiSettings,
    tools: fakeTools(),
    accounting: {
      record: (call) => ledger.record(call),
      gate: () => ledger.gate(),
    },
    onEvent: (event) => events.push(event),
  })

  assert.equal(fetchCalls, 1, "the second call never leaves")
  assert.equal(result.steps, 1)
  assert.equal(result.budgetBlocked, true)
  assert.match(result.answer, /hạn mức chi phí AI/)
  assert.equal(result.usageTotals.calls, 1, "only the paid step is booked")
  assert.ok(events.some((event) => event.type === "budget"))
  const budgetEvent = events.find((event) => event.type === "budget")
  assert.equal(budgetEvent.level, "over")
})

test("a budget that is already over stops the turn before the first call", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls++
    return jsonResponse({ choices: [{ message: { content: "không được gọi" } }] })
  }

  const ledger = makeLedger()
  ledger.setPrice("openai", "qwen2.5:7b", { inputPerMTok: 1000, outputPerMTok: 0, cachedPerMTok: 0 })
  ledger.setBudget({ limitUsd: 1, warnPercent: 80 })
  ledger.record({ provider: "openai", model: "qwen2.5:7b", tokens: { promptTokens: 1500 } })

  const result = await runAgentTurn({
    userMessage: "Kiểm tra khung thoại",
    settings: openAiSettings,
    tools: fakeTools(),
    accounting: {
      record: (call) => ledger.record(call),
      gate: () => ledger.gate(),
    },
  })

  assert.equal(fetchCalls, 0)
  assert.equal(result.steps, 0)
  assert.equal(result.budgetBlocked, true)
  assert.match(result.answer, /Hãy tăng hạn mức hoặc bấm “Đặt lại kế toán”/)
  assert.equal(result.usageTotals.calls, 0)
})

test("AI compaction never pays for a summary after the budget gate blocked it", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return jsonResponse({ choices: [{ message: { content: "- Mục tiêu" } }] })
  }

  const ledger = makeLedger()
  ledger.setPrice("openai", "qwen2.5:7b", { inputPerMTok: 1000, outputPerMTok: 0, cachedPerMTok: 0 })
  ledger.setBudget({ limitUsd: 1, warnPercent: 80 })
  ledger.record({ provider: "openai", model: "qwen2.5:7b", tokens: { promptTokens: 1500 } })
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Lượt ${index + 1} nội dung`,
  }))

  const result = await summarizeHistoryWithLlm({
    history,
    settings: openAiSettings,
    keepRecentMessages: 4,
    accounting: { record: (call) => ledger.record(call), gate: () => ledger.gate() },
  })
  assert.equal(calls, 0, "the blocked summary made no provider call")
  assert.equal(result.budgetBlocked, true)
  assert.match(result.message, /Hãy tăng hạn mức hoặc bấm “Đặt lại kế toán”/)
  assert.equal(ledger.snapshot().totals.calls, 1, "only the earlier blocking call is booked")
})

test("the AI compaction call is booked like any other paid call", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: "- Mục tiêu: dịch chương 1" } }],
    usage: { prompt_tokens: 500, completion_tokens: 30 },
  })

  const ledger = makeLedger()
  const history = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Lượt ${index + 1} nội dung`,
  }))
  const summarized = await summarizeHistoryWithLlm({
    history,
    settings: openAiSettings,
    keepRecentMessages: 4,
    accounting: {
      record: (call) => ledger.record(call),
      gate: () => ledger.gate(),
    },
  })

  assert.equal(summarized.usage.kind, "summary")
  assert.equal(summarized.usage.promptTokens, 500)
  assert.equal(ledger.snapshot().totals.calls, 1)
  assert.equal(ledger.snapshot().models[0].model, "qwen2.5:7b")
})
