// Token and cost accounting for every paid provider call (Nixio #65).
//
// The provider answer is the source of truth for tokens: when the response carries usage metadata it
// is used as-is, and only a missing count is estimated from the prompt size. Prices are never a
// vendor constant baked into the app — the ledger keeps a user-editable price table, and a model
// without a price is reported as unpriced instead of being billed at a guessed rate.
//
// Nothing here accepts prompt or answer text, only character counts, so no accounting record can
// carry dialogue content into storage or a log.

import { estimateTokensFromChars } from "./agent-context.js"

export const USAGE_STORAGE_KEY = "khung-thoai-usage-ledger"
export const TOKENS_PER_MILLION = 1000000
export const DEFAULT_WARN_PERCENT = 80
export const LEDGER_VERSION = 1

// The ledger travels with the browser profile, so every bucket is bounded: a long chapter must not
// turn one localStorage record into a slow read.
const MAX_PROJECTS = 24
const MAX_SESSIONS = 12
const MAX_PAGES = 200
const MAX_MODELS = 24
const USD_PRECISION = 1000000

/**
 * Count the characters a prompt actually contains, ignoring the image bytes a data URL or inline
 * attachment would otherwise contribute (an image is billed by its area, not by its base64 length).
 * Accepts a plain string, OpenAI `messages` or Gemini `contents`.
 */
export function estimatePromptChars(input) {
  if (typeof input === "string") return input.length
  if (!Array.isArray(input)) return 0
  let chars = 0
  for (const item of input) {
    if (!item || typeof item !== "object") continue
    if (typeof item.content === "string") chars += item.content.length
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "text" && typeof part.text === "string") chars += part.text.length
      }
    }
    if (Array.isArray(item.parts)) {
      for (const part of item.parts) {
        if (typeof part?.text === "string") chars += part.text.length
        if (part?.functionResponse?.response) chars += JSON.stringify(part.functionResponse.response).length
      }
    }
  }
  return chars
}

// Both provider shapes are read by the same key list: Gemini's `usageMetadata`, OpenAI's `usage` and
// the harness-normalized form never share a key name, so a flat lookup is unambiguous.
function firstCount(usage, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((node, part) => (node == null ? node : node[part]), usage)
    if (Number.isFinite(value)) return Number(value)
  }
  return null
}

/**
 * Normalize one provider answer into billable token counts. `estimated` marks a count the provider
 * did not report, so the UI can tell a measurement from an estimate.
 */
export function normalizeUsage({ usage = null, promptChars = 0, completionChars = 0 } = {}) {
  const promptRaw = firstCount(usage, ["promptTokenCount", "prompt_tokens", "promptTokens"])
  const completionRaw = firstCount(usage, ["candidatesTokenCount", "completion_tokens", "outputTokens"])
  const cachedRaw = firstCount(usage, ["cachedContentTokenCount", "prompt_tokens_details.cached_tokens", "cachedTokens"])
  const measuredPrompt = promptRaw !== null && promptRaw > 0
  const promptTokens = measuredPrompt ? Math.round(promptRaw) : estimateTokensFromChars(promptChars)
  const completionTokens = completionRaw !== null
    ? Math.max(0, Math.round(completionRaw))
    : estimateTokensFromChars(completionChars)
  const cachedTokens = Math.min(Math.max(0, Math.round(cachedRaw ?? 0)), promptTokens)
  return {
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: !measuredPrompt || completionRaw === null,
  }
}

// The persisted price table only keeps keys up to this length. Build keys inside that bound so a
// price entered for a long model id survives a reload and the budget gate keeps enforcing it.
const priceKeyLimit = 120

// A plain prefix of a long id would merge models that differ only after the cut. Two independent
// rolling hashes over the *full* id make the bounded key collision-resistant without changing any
// short key that existing ledgers already use.
function modelDigest(name) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b + code, 0x85ebca6b) >>> 0
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

export function priceKey(provider, model) {
  const name = String(model ?? "").trim().toLowerCase()
  const prefix = (provider === "openai" ? "openai" : "gemini") + ":"
  const full = name || "auto"
  const room = priceKeyLimit - prefix.length
  if (full.length <= room) return prefix + full
  const digest = modelDigest(full)
  return prefix + full.slice(0, room - digest.length - 1) + "~" + digest
}

/**
 * Validate one price row (USD per 1M tokens). A row that only holds zeros is the same as no price:
 * a free-looking model must not read as a measured cost of zero.
 */
export function normalizePrice(value) {
  if (!value || typeof value !== "object") return null
  const read = (key) => {
    const raw = value[key]
    if (raw === undefined || raw === null || raw === "") return 0
    const number = Number(raw)
    return Number.isFinite(number) && number >= 0 ? number : null
  }
  const inputPerMTok = read("inputPerMTok")
  const outputPerMTok = read("outputPerMTok")
  const cachedPerMTok = read("cachedPerMTok")
  if (inputPerMTok === null || outputPerMTok === null || cachedPerMTok === null) return null
  if (inputPerMTok === 0 && outputPerMTok === 0 && cachedPerMTok === 0) return null
  return { inputPerMTok, outputPerMTok, cachedPerMTok }
}

/**
 * Price one call. Prompt tokens that the provider served from its cache are billed at the cached
 * rate, so the two input rows never double count the same token.
 */
export function priceTokens(price, tokens = {}) {
  const promptTokens = Math.max(0, Math.round(Number(tokens?.promptTokens) || 0))
  const completionTokens = Math.max(0, Math.round(Number(tokens?.completionTokens) || 0))
  const cachedTokens = Math.min(promptTokens, Math.max(0, Math.round(Number(tokens?.cachedTokens) || 0)))
  const row = normalizePrice(price)
  if (!row) return { promptUsd: 0, cachedUsd: 0, completionUsd: 0, costUsd: 0, priced: false }
  const promptUsd = ((promptTokens - cachedTokens) / TOKENS_PER_MILLION) * row.inputPerMTok
  const cachedUsd = (cachedTokens / TOKENS_PER_MILLION) * row.cachedPerMTok
  const completionUsd = (completionTokens / TOKENS_PER_MILLION) * row.outputPerMTok
  return { promptUsd, cachedUsd, completionUsd, costUsd: promptUsd + cachedUsd + completionUsd, priced: true }
}

export function emptyTotals() {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    estimatedCalls: 0,
  }
}

function addTotals(left, right) {
  const a = left ?? emptyTotals()
  const b = right ?? {}
  const sum = (key) => (Number(a[key]) || 0) + (Number(b[key]) || 0)
  return {
    calls: sum("calls"),
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    cachedTokens: sum("cachedTokens"),
    totalTokens: sum("totalTokens"),
    costUsd: sum("costUsd"),
    unpricedCalls: sum("unpricedCalls"),
    estimatedCalls: sum("estimatedCalls"),
  }
}

export function countCall(totals, entry) {
  return addTotals(totals, {
    ...entry,
    calls: 1,
    unpricedCalls: entry?.priced === false ? 1 : 0,
    estimatedCalls: entry?.estimated ? 1 : 0,
  })
}

function cleanTotals(raw) {
  const totals = emptyTotals()
  for (const key of Object.keys(totals)) {
    const value = Number(raw?.[key])
    if (!Number.isFinite(value) || value <= 0) continue
    totals[key] = key === "costUsd" ? Math.round(value * USD_PRECISION) / USD_PRECISION : Math.round(value)
  }
  return totals
}

function cleanPriceTable(raw) {
  const prices = {}
  for (const [key, value] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const row = normalizePrice(value)
    if (row && typeof key === "string" && key && key.length <= priceKeyLimit) prices[key] = row
  }
  return prices
}

function cleanBudget(raw) {
  const limitUsd = Number(raw?.limitUsd)
  const warnPercent = Number(raw?.warnPercent)
  return {
    limitUsd: Number.isFinite(limitUsd) && limitUsd > 0 ? limitUsd : 0,
    warnPercent: Number.isFinite(warnPercent) && warnPercent >= 1 && warnPercent <= 100
      ? Math.round(warnPercent)
      : DEFAULT_WARN_PERCENT,
  }
}

function cleanBuckets(raw, limit, decorate = () => ({})) {
  const buckets = {}
  for (const [key, value] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (typeof key !== "string" || !key) continue
    buckets[key] = { ...cleanTotals(value), ...decorate(value) }
  }
  return trimBuckets(buckets, limit)
}

// Object key order is the recency order: a touched bucket is re-inserted last, so the oldest rows
// are the ones dropped first.
function trimBuckets(buckets, limit) {
  const keys = Object.keys(buckets)
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) delete buckets[key]
  return buckets
}

export function createLedger() {
  return {
    version: LEDGER_VERSION,
    prices: {},
    budget: { limitUsd: 0, warnPercent: DEFAULT_WARN_PERCENT },
    totals: emptyTotals(),
    sessions: {},
    pages: {},
    models: {},
  }
}

/** Read one project ledger back from storage, dropping anything the current shape does not own. */
export function hydrateLedger(raw) {
  if (!raw || typeof raw !== "object") return createLedger()
  return {
    version: LEDGER_VERSION,
    prices: cleanPriceTable(raw.prices),
    budget: cleanBudget(raw.budget),
    totals: cleanTotals(raw.totals),
    sessions: cleanBuckets(raw.sessions, MAX_SESSIONS),
    pages: cleanBuckets(raw.pages, MAX_PAGES),
    models: cleanBuckets(raw.models, MAX_MODELS, (value) => ({
      provider: value?.provider === "openai" ? "openai" : "gemini",
      model: typeof value?.model === "string" ? value.model.slice(0, 120) : "auto",
      priceKey: typeof value?.priceKey === "string" ? value.priceKey : "",
    })),
  }
}

function bucket(buckets, key, entry, limit, decorate = () => ({})) {
  if (!key) return buckets
  const previous = buckets[key]
  const next = { ...buckets }
  delete next[key]
  next[key] = countCall(previous, entry)
  Object.assign(next[key], decorate())
  return trimBuckets(next, limit)
}

/**
 * Append one call to a ledger. Pure: the ledger is not mutated and the priced entry is returned so a
 * caller can show what the call cost.
 */
export function recordCall(ledger, call = {}) {
  const base = ledger ?? createLedger()
  const provider = call.provider === "openai" ? "openai" : "gemini"
  // Key the bucket on the full id before truncating the display name, so two long models that share
  // a 120-character prefix still get their own prices and usage history.
  const fullModel = String(call.model || "auto")
  const model = fullModel.slice(0, 120)
  const tokens = call.tokens ?? {}
  const promptTokens = Math.max(0, Math.round(Number(tokens.promptTokens) || 0))
  const completionTokens = Math.max(0, Math.round(Number(tokens.completionTokens) || 0))
  const cachedTokens = Math.min(promptTokens, Math.max(0, Math.round(Number(tokens.cachedTokens) || 0)))
  const key = priceKey(provider, fullModel)
  const priced = priceTokens(base.prices?.[key] ?? null, { promptTokens, completionTokens, cachedTokens })
  const entry = {
    at: Number(call.at) || 0,
    provider,
    model,
    kind: String(call.kind || "chat"),
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: Boolean(tokens.estimated),
    priced: priced.priced,
    costUsd: priced.costUsd,
  }
  const next = {
    ...base,
    totals: countCall(base.totals, entry),
    sessions: bucket(base.sessions ?? {}, String(call.sessionId || ""), entry, MAX_SESSIONS),
    pages: bucket(base.pages ?? {}, String(call.pageId || ""), entry, MAX_PAGES),
    models: bucket(base.models ?? {}, key, entry, MAX_MODELS, () => ({ provider, model, priceKey: key })),
  }
  return { ledger: next, entry }
}

/** Clear what has been spent while keeping the price table and the budget the user configured. */
export function resetLedger(ledger) {
  const base = ledger ?? createLedger()
  return {
    ...createLedger(),
    prices: { ...(base.prices ?? {}) },
    budget: cleanBudget(base.budget),
  }
}

export function budgetStatus(ledger) {
  const budget = cleanBudget(ledger?.budget)
  const spentUsd = Math.max(0, Number(ledger?.totals?.costUsd) || 0)
  const enabled = budget.limitUsd > 0
  const percent = enabled ? (spentUsd / budget.limitUsd) * 100 : 0
  const level = !enabled ? "off" : percent >= 100 ? "over" : percent >= budget.warnPercent ? "warn" : "ok"
  return {
    enabled,
    limitUsd: budget.limitUsd,
    warnPercent: budget.warnPercent,
    spentUsd,
    percent: Math.round(Math.min(percent, 999) * 10) / 10,
    remainingUsd: enabled ? Math.max(0, budget.limitUsd - spentUsd) : 0,
    level,
  }
}

export function formatBudgetStop(status) {
  return `Đã chạm hạn mức chi phí AI của dự án (${formatUsd(status?.spentUsd)}/${formatUsd(status?.limitUsd)}). ` +
    "Hãy tăng hạn mức hoặc bấm “Đặt lại kế toán” trong khung Trợ lý AI rồi thử lại."
}

/**
 * The soft budget is a pre-flight gate: a turn checks it before every provider call, so the call that
 * would spend past the limit is the one that never leaves.
 */
export function budgetGate(ledger) {
  const status = budgetStatus(ledger)
  const blocked = status.level === "over"
  return { blocked, status, message: blocked ? formatBudgetStop(status) : "" }
}

export function formatTokens(value) {
  const tokens = Math.max(0, Math.round(Number(value) || 0))
  if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + "M"
  if (tokens >= 1000) return (tokens / 1000).toFixed(1) + "k"
  return String(tokens)
}

export function formatUsd(value) {
  const usd = Math.max(0, Number(value) || 0)
  // One translation call costs a fraction of a cent, so the small range keeps four decimals.
  const digits = usd >= 1 ? 2 : usd >= 0.1 ? 3 : 4
  return usd.toFixed(digits) + " $"
}

function readStoredProjects(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(USAGE_STORAGE_KEY) || "null")
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Project-scoped ledger with its own persistence. `projectKey` resolves the project the editor has
 * open at call time, so a request that lands after the user switched projects still bills the project
 * that made it.
 */
export function createUsageLedger({
  storage = globalThis.localStorage,
  projectKey = () => "unsaved",
  sessionId,
  now = () => Date.now(),
} = {}) {
  const listeners = new Set()
  const session = String(sessionId || "s_" + now())
  let projects = null

  const currentKey = () => String(projectKey() || "unsaved")

  function all() {
    if (!projects) projects = readStoredProjects(storage)
    return projects
  }

  function ledgerFor(key) {
    return hydrateLedger(all()[key])
  }

  function setLedger(key, ledger) {
    const record = { ...ledger, updatedAt: now() }
    const stored = { ...all(), [key]: record }
    const entries = Object.entries(stored).sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0))
    projects = Object.fromEntries(entries.slice(0, MAX_PROJECTS))
    try {
      storage?.setItem?.(USAGE_STORAGE_KEY, JSON.stringify(projects))
    } catch {
      // A full or unavailable storage must not break a translation that already succeeded.
    }
  }

  function snapshot({ pageId = "" } = {}) {
    const ledger = ledgerFor(currentKey())
    const models = Object.entries(ledger.models)
      .map(([key, item]) => ({ ...item, key, price: ledger.prices[key] ?? null }))
      .sort((a, b) => b.totalTokens - a.totalTokens)
    return {
      projectKey: currentKey(),
      sessionId: session,
      totals: ledger.totals,
      session: ledger.sessions[session] ?? emptyTotals(),
      page: pageId ? ledger.pages[pageId] ?? emptyTotals() : emptyTotals(),
      pageId: pageId || "",
      prices: ledger.prices,
      budget: ledger.budget,
      status: budgetStatus(ledger),
      models,
    }
  }

  function emit() {
    const state = snapshot()
    for (const listener of listeners) listener(state)
  }

  return {
    sessionId: session,
    projectKey: currentKey,
    snapshot,
    /** Record one paid call; the returned entry carries the price this project pays for it. */
    record(call = {}) {
      const key = currentKey()
      const { ledger, entry } = recordCall(ledgerFor(key), { ...call, sessionId: session, at: now() })
      setLedger(key, ledger)
      emit()
      return entry
    },
    setPrice(provider, model, value) {
      const key = currentKey()
      const ledger = ledgerFor(key)
      const row = normalizePrice(value)
      const prices = { ...ledger.prices }
      if (row) prices[priceKey(provider, model)] = row
      else delete prices[priceKey(provider, model)]
      setLedger(key, { ...ledger, prices })
      emit()
    },
    setBudget({ limitUsd, warnPercent } = {}) {
      const key = currentKey()
      const ledger = ledgerFor(key)
      setLedger(key, { ...ledger, budget: cleanBudget({ limitUsd, warnPercent }) })
      emit()
    },
    reset() {
      const key = currentKey()
      setLedger(key, resetLedger(ledgerFor(key)))
      emit()
    },
    gate() {
      return budgetGate(ledgerFor(currentKey()))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
