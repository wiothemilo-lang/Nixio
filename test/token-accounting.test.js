import assert from "node:assert/strict"
import test from "node:test"
import {
  USAGE_STORAGE_KEY,
  budgetGate,
  budgetStatus,
  createLedger,
  createUsageLedger,
  emptyTotals,
  estimatePromptChars,
  formatTokens,
  formatUsd,
  hydrateLedger,
  normalizePrice,
  normalizeUsage,
  priceKey,
  priceTokens,
  recordCall,
  resetLedger,
} from "../src/token-accounting.js"

function fakeStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    raw: () => store,
  }
}

function priced(overrides = {}) {
  return { inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: 0.5, ...overrides }
}

test("normalizeUsage reads Gemini and OpenAI usage metadata verbatim", () => {
  const gemini = normalizeUsage({
    usage: { promptTokenCount: 1200, candidatesTokenCount: 300, cachedContentTokenCount: 400 },
    promptChars: 999999,
  })
  assert.deepEqual(gemini, {
    promptTokens: 1200,
    completionTokens: 300,
    cachedTokens: 400,
    totalTokens: 1500,
    estimated: false,
  })

  const openAi = normalizeUsage({
    usage: { prompt_tokens: 800, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 300 } },
  })
  assert.equal(openAi.promptTokens, 800)
  assert.equal(openAi.completionTokens, 120)
  assert.equal(openAi.cachedTokens, 300)
  assert.equal(openAi.estimated, false)

  // The already-normalized harness shape stays readable too.
  const normalized = normalizeUsage({ usage: { promptTokens: 50, outputTokens: 10 } })
  assert.equal(normalized.promptTokens, 50)
  assert.equal(normalized.totalTokens, 60)
})

test("a missing usage block is estimated from the prompt size and never carries prompt text", () => {
  const tokens = normalizeUsage({
    usage: null,
    promptChars: 3600,
    completionChars: 36,
  })
  assert.equal(tokens.promptTokens, 1000)
  assert.equal(tokens.completionTokens, 10)
  assert.equal(tokens.estimated, true)
  // Only counts leave this function: an accounting record can never hold dialogue content.
  assert.deepEqual(Object.keys(tokens).sort(), [
    "cachedTokens",
    "completionTokens",
    "estimated",
    "promptTokens",
    "totalTokens",
  ])

  // A provider that reports prompt tokens but no completion count is still an estimate.
  const partial = normalizeUsage({ usage: { promptTokenCount: 400 }, completionChars: 360 })
  assert.equal(partial.promptTokens, 400)
  assert.equal(partial.completionTokens, 100)
  assert.equal(partial.estimated, true)
})

test("estimatePromptChars counts text only, so image bytes never inflate the estimate", () => {
  const base64 = "A".repeat(5000)
  assert.equal(estimatePromptChars("hello"), 5)
  assert.equal(
    estimatePromptChars([
      { role: "system", content: "abc" },
      { role: "user", content: [{ type: "text", text: "de" }, { type: "image_url", image_url: { url: base64 } }] },
    ]),
    5,
  )
  assert.equal(
    estimatePromptChars([{ role: "user", parts: [{ text: "abc" }, { inlineData: { data: base64 } }] }]),
    3,
  )
  assert.equal(estimatePromptChars(null), 0)
})

test("priceTokens bills cached prompt tokens at the cached rate", () => {
  const priced_ = priceTokens(priced(), { promptTokens: 1000000, completionTokens: 500000, cachedTokens: 400000 })
  assert.equal(priced_.priced, true)
  assert.equal(priced_.promptUsd, 0.6) // 600k uncached input tokens at 1 $/M
  assert.equal(priced_.cachedUsd, 0.2) // 400k cached tokens at 0.5 $/M
  assert.equal(priced_.completionUsd, 1) // 500k output tokens at 2 $/M
  assert.equal(priced_.costUsd, 1.8)

  const unpriced = priceTokens(null, { promptTokens: 1000, completionTokens: 10 })
  assert.deepEqual(unpriced, { promptUsd: 0, cachedUsd: 0, completionUsd: 0, costUsd: 0, priced: false })
})

test("normalizePrice rejects junk and treats an all-zero row as no price", () => {
  assert.deepEqual(normalizePrice({ inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: 0.5 }), priced())
  assert.equal(normalizePrice({ inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0 }), null)
  assert.equal(normalizePrice({ inputPerMTok: -1 }), null)
  assert.equal(normalizePrice({ inputPerMTok: "abc" }), null)
  assert.equal(normalizePrice(null), null)
  // An empty cached field means the provider charges nothing cached, not an invalid row.
  assert.deepEqual(normalizePrice({ inputPerMTok: 1, outputPerMTok: 2 }), priced({ cachedPerMTok: 0 }))
})

test("recordCall aggregates one call into totals, session, page and model buckets", () => {
  const ledger = { ...createLedger(), prices: { [priceKey("gemini", "auto")]: priced() } }
  const first = recordCall(ledger, {
    provider: "gemini",
    model: "auto",
    kind: "chat",
    sessionId: "s1",
    pageId: "p1",
    at: 10,
    tokens: { promptTokens: 1000, completionTokens: 200, cachedTokens: 0, totalTokens: 1200, estimated: false },
  })
  assert.equal(first.entry.priced, true)
  assert.equal(first.entry.costUsd, 0.0014) // 1000 in at 1 $/M + 200 out at 2 $/M
  assert.equal(first.ledger.totals.calls, 1)
  assert.equal(first.ledger.totals.totalTokens, 1200)
  assert.equal(first.ledger.sessions.s1.totalTokens, 1200)
  assert.equal(first.ledger.pages.p1.totalTokens, 1200)
  assert.equal(first.ledger.models[priceKey("gemini", "auto")].calls, 1)
  assert.equal(first.ledger.models[priceKey("gemini", "auto")].provider, "gemini")

  const second = recordCall(first.ledger, {
    provider: "openai",
    model: "local-7b",
    kind: "translate",
    sessionId: "s1",
    pageId: "p2",
    tokens: { promptTokens: 500, completionTokens: 100, estimated: true },
  })
  assert.equal(second.entry.priced, false)
  assert.equal(second.ledger.totals.calls, 2)
  assert.equal(second.ledger.totals.unpricedCalls, 1)
  assert.equal(second.ledger.totals.estimatedCalls, 1)
  assert.equal(second.ledger.totals.costUsd, 0.0014)
  assert.equal(second.ledger.pages.p1.totalTokens, 1200)
  assert.equal(second.ledger.pages.p2.totalTokens, 600)
  // A pure ledger: the input is untouched by the write.
  assert.equal(ledger.totals.calls, 0)
})

test("a price entered for a long model id survives a reload and still gates spend", () => {
  const storage = fakeStorage()
  const options = { storage, projectKey: () => "p", sessionId: "s1", now: () => 1000 }
  const model = "m".repeat(115)
  const key = priceKey("openai", model)
  assert.ok(key.length <= 120, "price keys stay inside the persisted table's limit")

  createUsageLedger(options).setPrice("openai", model, { inputPerMTok: 1, outputPerMTok: 2 })
  const reloaded = createUsageLedger(options)
  assert.deepEqual(reloaded.snapshot().prices[key], normalizePrice({ inputPerMTok: 1, outputPerMTok: 2 }))
  assert.equal(reloaded.snapshot().models.length, 0)

  reloaded.record({ provider: "openai", model, tokens: { promptTokens: 1000, completionTokens: 0 } })
  const priced = createUsageLedger(options).snapshot()
  assert.equal(priced.models.find((row) => row.key === key).price.inputPerMTok, 1)
  assert.ok(priced.totals.costUsd > 0, "the restored price is applied to later calls")
})

test("long model ids with the same display prefix keep separate prices and usage buckets", () => {
  const storage = fakeStorage()
  const options = { storage, projectKey: () => "p", sessionId: "s1", now: () => 1000 }
  const shared = "m".repeat(130)
  const first = shared + "a"
  const second = shared + "b"
  const firstKey = priceKey("openai", first)
  const secondKey = priceKey("openai", second)
  assert.notEqual(firstKey, secondKey, "the full model id must take part in the key")
  assert.ok(firstKey.length <= 120 && secondKey.length <= 120, "keys stay inside the persisted table's limit")
  assert.equal(priceKey("openai", "x"), "openai:x", "short keys stay unchanged")

  const ledger = createUsageLedger(options)
  ledger.setPrice("openai", first, { inputPerMTok: 1, outputPerMTok: 0 })
  ledger.setPrice("openai", second, { inputPerMTok: 2, outputPerMTok: 0 })
  ledger.record({ provider: "openai", model: first, tokens: { promptTokens: 1000 } })
  ledger.record({ provider: "openai", model: second, tokens: { promptTokens: 1000 } })

  const reloaded = createUsageLedger(options).snapshot()
  assert.equal(reloaded.prices[firstKey].inputPerMTok, 1)
  assert.equal(reloaded.prices[secondKey].inputPerMTok, 2)
  assert.equal(reloaded.models.length, 2, "usage stays in two buckets")
  assert.equal(reloaded.totals.promptTokens, 2000)
})

test("hydrateLedger keeps a valid record and drops anything the shape does not own", () => {
  const raw = {
    version: 99,
    prices: { "gemini:auto": priced(), "openai:x": { inputPerMTok: -5 } },
    budget: { limitUsd: "oops", warnPercent: 250 },
    totals: { calls: 2, promptTokens: 10, costUsd: 0.25, bogus: 7 },
    sessions: { s1: { calls: 1, promptTokens: 10 } },
    pages: "not-an-object",
    models: { "gemini:auto": { provider: "unknown", model: "auto", calls: 1 } },
  }
  const ledger = hydrateLedger(raw)
  assert.deepEqual(Object.keys(ledger.prices), ["gemini:auto"])
  assert.deepEqual(ledger.budget, { limitUsd: 0, warnPercent: 80 })
  assert.equal(ledger.totals.calls, 2)
  assert.equal(ledger.totals.costUsd, 0.25)
  assert.equal("bogus" in ledger.totals, false)
  assert.equal(ledger.sessions.s1.promptTokens, 10)
  assert.deepEqual(ledger.pages, {})
  assert.equal(ledger.models["gemini:auto"].provider, "gemini")
  assert.equal(hydrateLedger(null).totals.calls, 0)
})

test("budgetStatus grades the spend and budgetGate refuses the next call when over", () => {
  const ledger = createLedger()
  ledger.budget = { limitUsd: 1, warnPercent: 80 }
  ledger.totals = { ...emptyTotals(), costUsd: 0.5 }
  const ok = budgetStatus(ledger)
  assert.equal(ok.level, "ok")
  assert.equal(ok.percent, 50)
  assert.equal(budgetGate(ledger).blocked, false)

  ledger.totals = { ...emptyTotals(), costUsd: 0.85 }
  const warn = budgetGate(ledger)
  assert.equal(warn.status.level, "warn")
  assert.equal(warn.blocked, false)

  ledger.totals = { ...emptyTotals(), costUsd: 1.2 }
  const over = budgetGate(ledger)
  assert.equal(over.status.level, "over")
  assert.equal(over.blocked, true)
  assert.match(over.message, /hạn mức chi phí AI/)
  assert.match(over.message, /Đặt lại kế toán/)

  // No limit configured means no gate at all.
  const disabled = budgetGate({ ...createLedger(), totals: { ...emptyTotals(), costUsd: 99 } })
  assert.equal(disabled.status.level, "off")
  assert.equal(disabled.blocked, false)
})

test("the usage ledger persists per project, prices each call and survives a reload", () => {
  const storage = fakeStorage()
  let project = "project-a"
  const ledger = createUsageLedger({ storage, projectKey: () => project, sessionId: "s1", now: () => 1000 })
  ledger.setPrice("gemini", "auto", priced())
  ledger.record({
    provider: "gemini",
    model: "auto",
    kind: "translate",
    pageId: "p1",
    tokens: { promptTokens: 1000, completionTokens: 100 },
  })
  const snapshot = ledger.snapshot({ pageId: "p1" })
  assert.equal(snapshot.totals.calls, 1)
  assert.equal(snapshot.session.totalTokens, 1100)
  assert.equal(snapshot.page.totalTokens, 1100)
  assert.equal(snapshot.totals.costUsd, 0.0012)
  assert.equal(snapshot.models[0].price.inputPerMTok, 1)

  // A different project keeps its own record.
  project = "project-b"
  assert.equal(ledger.snapshot().totals.calls, 0)
  ledger.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 10, completionTokens: 1 } })
  assert.equal(ledger.snapshot().totals.calls, 1)

  // Prices and totals are read back per project after a reload.
  project = "project-a"
  const reloaded = createUsageLedger({ storage, projectKey: () => project, sessionId: "s2", now: () => 2000 })
  assert.equal(reloaded.snapshot().totals.calls, 1)
  assert.equal(reloaded.snapshot().prices["gemini:auto"].outputPerMTok, 2)
  assert.equal(reloaded.snapshot().session.calls, 0)
  assert.ok(JSON.parse(storage.raw().get(USAGE_STORAGE_KEY))["project-a"])
  // A new session starts its own bucket while the project total keeps growing.
  reloaded.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 10 } })
  assert.equal(reloaded.snapshot().totals.calls, 2)
  assert.equal(reloaded.snapshot().session.calls, 1)

  project = "project-b"
  const other = createUsageLedger({ storage, projectKey: () => project, sessionId: "s1", now: () => 2000 })
  assert.equal(other.snapshot().totals.calls, 1)
  assert.equal(other.snapshot().totals.unpricedCalls, 1)
})

test("the ledger budget warns at the configured threshold and refuses the next call", () => {
  const ledger = createUsageLedger({ storage: fakeStorage(), projectKey: () => "p", sessionId: "s1" })
  ledger.setPrice("gemini", "auto", { inputPerMTok: 1000, outputPerMTok: 0, cachedPerMTok: 0 })
  ledger.setBudget({ limitUsd: 1, warnPercent: 80 })
  assert.equal(ledger.gate().blocked, false)
  ledger.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 900 } }) // 0.9 $ -> warn
  assert.equal(ledger.gate().status.level, "warn")
  assert.equal(ledger.gate().blocked, false)
  ledger.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 200 } }) // over 1 $
  assert.equal(ledger.gate().blocked, true)
  assert.equal(ledger.snapshot().status.level, "over")
})

test("reset clears the spend and keeps the price table and budget", () => {
  const ledger = createUsageLedger({ storage: fakeStorage(), projectKey: () => "p", sessionId: "s1" })
  ledger.setPrice("gemini", "auto", priced())
  ledger.setBudget({ limitUsd: 2, warnPercent: 70 })
  ledger.record({ provider: "gemini", model: "auto", pageId: "p1", tokens: { promptTokens: 1000 } })
  assert.equal(ledger.snapshot().totals.calls, 1)

  ledger.reset()
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.totals.calls, 0)
  assert.equal(snapshot.totals.costUsd, 0)
  assert.deepEqual(snapshot.models, [])
  assert.equal(snapshot.prices["gemini:auto"].inputPerMTok, 1)
  assert.deepEqual(snapshot.budget, { limitUsd: 2, warnPercent: 70 })
  assert.equal(ledger.gate().blocked, false)

  // The pure helper keeps the same contract.
  const cleared = resetLedger({ ...createLedger(), prices: { a: priced() }, budget: { limitUsd: 5, warnPercent: 90 } })
  assert.deepEqual(Object.keys(cleared.prices), ["a"])
  assert.deepEqual(cleared.budget, { limitUsd: 5, warnPercent: 90 })
  assert.equal(cleared.totals.calls, 0)
})

test("subscribers receive a fresh snapshot after every change", () => {
  const ledger = createUsageLedger({ storage: fakeStorage(), projectKey: () => "p", sessionId: "s1" })
  const seen = []
  const unsubscribe = ledger.subscribe((snapshot) => seen.push(snapshot.totals.calls))
  ledger.setPrice("gemini", "auto", priced())
  ledger.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 10 } })
  unsubscribe()
  ledger.record({ provider: "gemini", model: "auto", tokens: { promptTokens: 10 } })
  assert.deepEqual(seen, [0, 1])
})

test("token and cost formatting stays readable in the chat status row", () => {
  assert.equal(formatTokens(0), "0")
  assert.equal(formatTokens(999), "999")
  assert.equal(formatTokens(1234), "1.2k")
  assert.equal(formatTokens(2500000), "2.5M")
  assert.equal(formatUsd(0), "0.0000 $")
  assert.equal(formatUsd(0.0123), "0.0123 $")
  assert.equal(formatUsd(0.5), "0.500 $")
  assert.equal(formatUsd(2.5), "2.50 $")
})
