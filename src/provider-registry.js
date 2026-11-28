// Provider registry (Nixio #69).
//
// One descriptor per chat provider. The agent loop asks this table for everything provider-specific:
//
//   {
//     id, label,                          // identity and the name shown to the user
//     shape,                              // transport shape provider-bridge already speaks
//     endpoint: { kind, ... },            // fixed destination, or typed by the user and validated
//     credential: { required, message, vaultMessage, field },
//     models: { resolve(settings) },      // the model list, in fallback order
//     capabilities: { tools, stream, vision },
//     labels: { agent(settings), badge(settings) },
//     prepareCredential(settings, { vaultKeys, readField }),
//     callStep({ settings, thread, toolDefs, signal, stream, onDelta }),
//     conversation: { pruneShape, createThread({ history, systemPrompt, userText }) },
//   }
//
// `callStep` owns the wire body and the answer decoding; `conversation` owns the message thread, so
// the harness never learns a provider's message shape. Registration validates every entry, so a
// descriptor that cannot work fails at startup with the provider named: a duplicate id, a missing
// handler, a capability the transport cannot carry, or an endpoint kind the shape cannot address.
//
// `resolve` keeps the fallback the harness always had — an absent or unknown provider id is Gemini —
// so a settings record written before a provider existed keeps working.

import { callProvider, providerCredentialsInMain, validateEndpointUrl } from "./provider-bridge.js"
import { parseRetryAfterMs } from "./llm-retry.js"
import { sanitizeEffort } from "./llm-profiles.js"

// The chat effort maps onto each API's own knob. Gemini names the same three levels `thinkingLevel`.
const geminiThinkingLevels = Object.freeze({ low: "low", medium: "medium", high: "high" })

export const PROVIDER_SHAPES = Object.freeze({
  gemini: Object.freeze({ endpointKind: "fixed", pruneShape: "gemini" }),
  openai: Object.freeze({ endpointKind: "user", pruneShape: "openai" }),
})

export const ENDPOINT_KINDS = Object.freeze(["fixed", "user"])

const CAPABILITY_KEYS = new Set(["tools", "stream", "vision"])
const PRUNE_SHAPES = Object.freeze(["gemini", "openai"])
const LABEL_VARIANTS = Object.freeze(["agent", "badge"])

function registryError(message) {
  return new Error("Provider registry: " + message)
}

function normalizeEndpoint(id, entry, shape) {
  const endpoint = entry.endpoint ?? {}
  if (!ENDPOINT_KINDS.includes(endpoint.kind)) {
    throw registryError(`provider "${id}" declares unknown endpoint kind "${endpoint.kind}".`)
  }
  // The transport owns the destination: a fixed shape has one origin, a user shape validates the base
  // URL the user typed. A mismatch would send the request nowhere, so it is rejected here.
  if (endpoint.kind !== shape.endpointKind) {
    throw registryError(
      `provider "${id}" has a ${endpoint.kind} endpoint but the ${entry.shape} transport only speaks ${shape.endpointKind}.`,
    )
  }
  if (endpoint.kind === "fixed") {
    if (!String(endpoint.host ?? "").trim()) throw registryError(`provider "${id}" needs a fixed endpoint host.`)
    return Object.freeze({ kind: "fixed", host: String(endpoint.host).trim() })
  }
  if (!String(endpoint.field ?? "").trim()) {
    throw registryError(`provider "${id}" needs the settings field that holds its endpoint.`)
  }
  if (typeof endpoint.validate !== "function") throw registryError(`provider "${id}" needs an endpoint validator.`)
  return Object.freeze({ kind: "user", field: String(endpoint.field).trim(), validate: endpoint.validate })
}

function normalizeCredential(id, entry) {
  const credential = entry.credential ?? {}
  if (typeof credential.required !== "boolean") {
    throw registryError(`provider "${id}" must declare whether a credential is required.`)
  }
  if (credential.required && !String(credential.message ?? "").trim()) {
    throw registryError(`provider "${id}" needs a message for its missing credential.`)
  }
  if (!String(credential.vaultMessage ?? "").trim()) {
    throw registryError(`provider "${id}" needs the message shown when the vault holds no key.`)
  }
  if (!String(credential.field ?? "").trim()) {
    throw registryError(`provider "${id}" needs the settings field that holds its credential.`)
  }
  return Object.freeze({
    required: credential.required,
    message: String(credential.message ?? ""),
    vaultMessage: String(credential.vaultMessage),
    field: String(credential.field).trim(),
  })
}

function normalizeCapabilities(id, capabilities = {}) {
  for (const key of Object.keys(capabilities)) {
    if (!CAPABILITY_KEYS.has(key)) throw registryError(`provider "${id}" declares unknown capability "${key}".`)
  }
  // A capability the transport cannot carry is off unless the entry turns it on.
  return Object.freeze({
    tools: capabilities.tools === true,
    stream: capabilities.stream === true,
    vision: capabilities.vision === true,
  })
}

function normalizeConversation(id, conversation = {}) {
  if (!PRUNE_SHAPES.includes(conversation.pruneShape)) {
    throw registryError(`provider "${id}" declares unknown prune shape "${conversation.pruneShape}".`)
  }
  if (typeof conversation.createThread !== "function") {
    throw registryError(`provider "${id}" has no conversation factory.`)
  }
  return Object.freeze({ pruneShape: conversation.pruneShape, createThread: conversation.createThread })
}

function normalizeLabels(id, labels = {}) {
  const normalized = {}
  for (const variant of LABEL_VARIANTS) {
    if (typeof labels[variant] !== "function") throw registryError(`provider "${id}" needs a "${variant}" label.`)
    normalized[variant] = labels[variant]
  }
  return Object.freeze(normalized)
}

function normalizeProvider(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw registryError("every entry must be an object.")
  }
  const id = String(entry.id ?? "").trim()
  if (!id) throw registryError("every provider needs an id.")
  const label = String(entry.label ?? "").trim()
  if (!label) throw registryError(`provider "${id}" needs a label.`)
  const shape = PROVIDER_SHAPES[entry.shape]
  if (!shape) throw registryError(`provider "${id}" uses unknown transport shape "${entry.shape}".`)
  if (typeof entry.callStep !== "function") throw registryError(`provider "${id}" has no step handler.`)
  if (!entry.models || typeof entry.models.resolve !== "function") {
    throw registryError(`provider "${id}" needs a model list resolver.`)
  }
  if (typeof entry.prepareCredential !== "function") {
    throw registryError(`provider "${id}" has no credential handler.`)
  }
  return Object.freeze({
    id,
    label,
    shape: entry.shape,
    endpoint: normalizeEndpoint(id, entry, shape),
    credential: normalizeCredential(id, entry),
    models: entry.models,
    capabilities: normalizeCapabilities(id, entry.capabilities),
    labels: normalizeLabels(id, entry.labels),
    prepareCredential: entry.prepareCredential,
    callStep: entry.callStep,
    conversation: normalizeConversation(id, entry.conversation),
  })
}

export function createProviderRegistry(entries = [], { fallbackId } = {}) {
  const providers = (Array.isArray(entries) ? entries : []).map(normalizeProvider)
  if (!providers.length) throw registryError("at least one provider is required.")
  const byId = new Map()
  for (const provider of providers) {
    if (byId.has(provider.id)) throw registryError(`duplicate provider "${provider.id}".`)
    byId.set(provider.id, provider)
  }
  const fallback = fallbackId ?? providers[0].id
  if (!byId.has(fallback)) throw registryError(`fallback provider "${fallback}" is not registered.`)

  function get(id) {
    return byId.get(String(id ?? "")) ?? null
  }

  // Accepts either a settings record (`{ provider }`) or a bare provider id.
  function resolve(settingsOrId) {
    const id = typeof settingsOrId === "string" ? settingsOrId : settingsOrId?.provider
    return byId.get(String(id ?? "")) ?? byId.get(fallback)
  }

  return {
    size: providers.length,
    ids() {
      return providers.map((provider) => provider.id)
    },
    list() {
      return [...providers]
    },
    get,
    has(id) {
      return byId.has(String(id ?? ""))
    },
    resolve,
    models(id, settings) {
      return get(id)?.models.resolve(settings ?? {}) ?? []
    },
    label(settingsOrId, variant = "agent") {
      return resolve(settingsOrId).labels[variant](typeof settingsOrId === "string" ? {} : (settingsOrId ?? {}))
    },
  }
}

export async function readSseEvents(body, onData) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let dataLines = []
  const flush = () => {
    if (!dataLines.length) return
    const payload = dataLines.join("\n").trim()
    dataLines = []
    if (payload && payload !== "[DONE]") onData(payload)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) {
          flush()
          continue
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart())
    flush()
  } finally {
    reader.releaseLock?.()
  }
}

// Text-form tool calls follow the OpenAI function-call convention, so `arguments` is often a
// JSON-encoded string emitted by local/quantized models. Decode it instead of dropping it.
function decodeToolArgs(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" && value !== null ? value : {}
}

export function parseTextToolCalls(text) {
  const calls = []
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let match
  while ((match = pattern.exec(String(text || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed.name === "string") {
        calls.push({
          id: "tc_" + (calls.length + 1),
          name: parsed.name,
          args: decodeToolArgs(parsed.arguments),
        })
      }
    } catch {
      // Ignore malformed inline tool_call blocks.
    }
  }
  return calls
}

const geminiModels = Object.freeze({
  auto: Object.freeze(["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]),
  "gemini-3.1-flash-lite": Object.freeze(["gemini-3.1-flash-lite"]),
  "gemini-3.5-flash-lite": Object.freeze(["gemini-3.5-flash-lite"]),
})

const geminiEndpoint = Object.freeze({ kind: "fixed", host: "generativelanguage.googleapis.com" })

const geminiCredential = Object.freeze({
  required: true,
  message: "Hãy nhập khóa API Gemini ở mục Dịch ảnh & LLM.",
  vaultMessage: "Chưa có khóa API Gemini trong kho bảo mật. Hãy lưu khóa ở mục Dịch ảnh & LLM.",
  field: "gemini-key",
})

const geminiCapabilities = Object.freeze({ tools: true, stream: true, vision: true })

const geminiMarks = Object.freeze({
  agent: (settings) => `Gemini (${settings.model || "auto"})`,
  badge: (settings) => `Gemini (${settings.model})`,
})

const openAiModels = Object.freeze({
  resolve(settings = {}) {
    const model = String(settings.llmModel || "").trim()
    if (!model) throw new Error("Hãy nhập tên Model LLM ở mục Dịch ảnh & LLM.")
    return [model]
  },
})

const openAiEndpoint = Object.freeze({ kind: "user", field: "baseUrl", validate: validateEndpointUrl })

const openAiCredential = Object.freeze({
  // A local server (Ollama, LM Studio) often needs no key, so only the vault message is required.
  required: false,
  message: "",
  vaultMessage: "Chưa có khóa API cho endpoint này trong kho bảo mật. Hãy lưu khóa ở mục Dịch ảnh & LLM.",
  field: "llm-key",
})

const openAiCapabilities = Object.freeze({ tools: true, stream: true, vision: true })

const openAiLabels = Object.freeze({
  agent: (settings) => settings.llmModel || "OpenAI/Local",
  badge: (settings) => settings.llmModel || "Local/OpenAI LLM",
})

async function callGeminiStep({ settings, thread, toolDefs, signal, stream = false, onDelta }) {
  const key = String(settings.key || "").trim()
  // On the desktop the key is read from the OS vault in main, so a missing settings value is not a
  // configuration error there: main answers with a credential error only when nothing is stored.
  if (!key && !providerCredentialsInMain()) throw new Error(geminiCredential.message)
  const models = geminiModels[settings.model] ?? geminiModels.auto
  const { systemPrompt, contents } = thread.request()
  const thinkingLevel = geminiThinkingLevels[sanitizeEffort(settings.effort)]
  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(toolDefs.length && { tools: [{ functionDeclarations: toolDefs }] }),
    ...(thinkingLevel && { generationConfig: { thinkingConfig: { thinkingLevel } } }),
  }
  let response
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    response = await callProvider({
      provider: "gemini",
      model,
      payload,
      key,
      stream,
      signal,
      timeoutMs: 90000,
    })
    if (response.ok) {
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase()
      const isSse = stream && contentType.includes("text/event-stream") && typeof response.body?.getReader === "function"
      const parts = []
      const textParts = []
      const thoughtParts = []
      const toolCalls = []
      let usage = null

      const ingestPayload = (payload) => {
        const meta = payload?.usageMetadata
        if (meta && (meta.promptTokenCount || meta.totalTokenCount)) {
          usage = {
            promptTokens: Number(meta.promptTokenCount || 0),
            outputTokens: Number(meta.candidatesTokenCount || 0),
            cachedTokens: Number(meta.cachedContentTokenCount || 0),
            totalTokens: Number(meta.totalTokenCount || 0),
          }
        }
        const chunkParts = payload?.candidates?.[0]?.content?.parts ?? []
        for (const part of chunkParts) {
          parts.push(part)
          if (part.thought) {
            if (typeof part.text === "string" && part.text) {
              thoughtParts.push(part.text)
              onDelta?.({ text: "", thought: part.text })
            }
            continue
          }
          if (typeof part.text === "string" && part.text) {
            textParts.push(part.text)
            onDelta?.({ text: part.text, thought: "" })
          }
          if (part.functionCall?.name) {
            toolCalls.push({
              id: "gem_" + (toolCalls.length + 1) + "_" + Date.now(),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            })
          }
        }
      }

      if (isSse) {
        await readSseEvents(response.body, (raw) => {
          try {
            ingestPayload(JSON.parse(raw))
          } catch {
            // Ignore partial or non-JSON SSE keepalive frames.
          }
        })
      } else {
        ingestPayload(await response.json())
      }

      return {
        rawModelContent: { role: "model", parts },
        text: textParts.join(isSse ? "" : "\n").trim(),
        thought: thoughtParts.join("").trim(),
        toolCalls,
        usage,
      }
    }
    const canFallback = [404, 429, 500, 502, 503, 504].includes(response.status) && i + 1 < models.length
    if (!canFallback) break
  }
  const err = new Error(`Gemini trả lỗi ${response.status}. Kiểm tra khóa API và hạn mức.`)
  err.status = response.status
  err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
  throw err
}

async function callOpenAiStep({ settings, thread, toolDefs, signal, stream = false, onDelta }) {
  const endpoint = openAiEndpoint.validate(settings[openAiEndpoint.field])
  const [model] = openAiModels.resolve(settings)
  const effort = sanitizeEffort(settings.effort)
  const { messages } = thread.request()

  const body = {
    model,
    temperature: 0.3,
    messages,
    ...(effort && { reasoning_effort: effort }),
    ...(stream && { stream: true, stream_options: { include_usage: true } }),
    ...(toolDefs.length && {
      tools: toolDefs.map((def) => ({
        type: "function",
        function: { name: def.name, description: def.description, parameters: def.parameters },
      })),
      tool_choice: "auto",
    }),
  }

  const response = await callProvider({
    provider: "openai",
    endpoint,
    payload: body,
    key: settings.apiKey,
    stream,
    signal,
    timeoutMs: 120000,
  })
  if (!response.ok) {
    const err = new Error(`LLM trả lỗi ${response.status}. Kiểm tra Base URL, tên model và API key.`)
    err.status = response.status
    err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
    throw err
  }

  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase()
  const isSse = stream && contentType.includes("text/event-stream") && typeof response.body?.getReader === "function"

  if (isSse) {
    let rawText = ""
    let rawReasoning = ""
    let usage = null
    const toolMap = new Map()
    // OpenAI-compatible servers may omit `index` on streamed tool_call fragments (valid per
    // spec) or send `id` only on the first fragment. Alias both hints to a single slot so later
    // argument fragments keep accumulating instead of opening orphan slots that drop them.
    const toolAliases = new Map()
    let pendingKey = null
    const aliasKey = (hint, key) => {
      if (hint) toolAliases.set(hint, key)
    }
    const resolveToolKey = (item) => {
      const byId = item.id ? "id:" + item.id : ""
      const byIndex = Number.isInteger(item.index) ? "i:" + item.index : ""
      const idKey = byId ? toolAliases.get(byId) : ""
      const indexKey = byIndex ? toolAliases.get(byIndex) : ""
      // A hint already bound to a slot is authoritative: parallel calls interleave by index.
      if (idKey) return idKey
      if (indexKey) return indexKey
      const pending = pendingKey ? toolMap.get(pendingKey) : null
      const startsCall = Boolean(item.function?.name)
      // Servers can split one call's identity across fragments: "id" on the first, "index" only on
      // the argument fragments. Attach an unknown hint to the open slot while that slot is still
      // missing the same identity, instead of opening an orphan slot that the final filter drops.
      // A fragment that starts a call by naming the function is always a new slot.
      if (pending && !startsCall) {
        if (byId && !pending.id) return pendingKey
        if (byIndex && pending.index === undefined) return pendingKey
      }
      return byId || byIndex || pendingKey || "tc:" + toolMap.size
    }
    await readSseEvents(response.body, (raw) => {
      let chunk
      try {
        chunk = JSON.parse(raw)
      } catch {
        return
      }
      if (chunk?.usage && (chunk.usage.prompt_tokens || chunk.usage.total_tokens)) {
        usage = {
          promptTokens: Number(chunk.usage.prompt_tokens || 0),
          outputTokens: Number(chunk.usage.completion_tokens || 0),
          cachedTokens: Number(chunk.usage.prompt_tokens_details?.cached_tokens || 0),
          totalTokens: Number(chunk.usage.total_tokens || 0),
        }
      }
      const delta = chunk?.choices?.[0]?.delta
      if (!delta) return
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        rawReasoning += delta.reasoning_content
        onDelta?.({ text: "", thought: delta.reasoning_content })
      }
      if (typeof delta.content === "string" && delta.content) {
        rawText += delta.content
        onDelta?.({ text: delta.content, thought: "" })
      }
      if (Array.isArray(delta.tool_calls)) {
        const seen = new Set()
        for (const item of delta.tool_calls) {
          let key = resolveToolKey(item)
          // Two hint-less fragments inside one delta are separate calls, never one continuation.
          if (!item.id && !Number.isInteger(item.index) && seen.has(key)) key = "tc:" + toolMap.size
          seen.add(key)
          aliasKey(item.id ? "id:" + item.id : "", key)
          aliasKey(Number.isInteger(item.index) ? "i:" + item.index : "", key)
          const prev = toolMap.get(key) ?? { order: toolMap.size, id: "", index: undefined, name: "", argumentsText: "" }
          if (item.id) prev.id = item.id
          if (Number.isInteger(item.index)) prev.index = item.index
          if (item.function?.name) prev.name += item.function.name
          if (typeof item.function?.arguments === "string") prev.argumentsText += item.function.arguments
          toolMap.set(key, prev)
          pendingKey = key
        }
      }
    })
    let toolCalls = [...toolMap.values()]
      .sort((a, b) => a.order - b.order)
      .map((item, index) => {
        let args = {}
        try {
          args = JSON.parse(item.argumentsText || "{}")
        } catch {
          args = {}
        }
        return { id: item.id || "call_" + (index + 1), name: item.name, args }
      })
      .filter((tc) => tc.name)
    if (!toolCalls.length && rawText.includes("<tool_call>")) {
      toolCalls = parseTextToolCalls(rawText)
    }
    return {
      rawMessage: { role: "assistant", content: rawText },
      text: rawText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim(),
      thought: rawReasoning.trim(),
      toolCalls,
      usage,
    }
  }

  const payload = await response.json()
  const usage = payload?.usage && (payload.usage.prompt_tokens || payload.usage.total_tokens)
    ? {
      promptTokens: Number(payload.usage.prompt_tokens || 0),
      outputTokens: Number(payload.usage.completion_tokens || 0),
      cachedTokens: Number(payload.usage.prompt_tokens_details?.cached_tokens || 0),
      totalTokens: Number(payload.usage.total_tokens || 0),
    }
    : null
  const message = payload.choices?.[0]?.message ?? {}
  const rawText = Array.isArray(message.content)
    ? message.content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n")
    : String(message.content ?? "")
  const rawReasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : ""

  let toolCalls = []
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    toolCalls = message.tool_calls.map((tc, index) => {
      let args = {}
      try {
        args = typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : (tc.function?.arguments ?? {})
      } catch {
        args = {}
      }
      return {
        id: tc.id || "call_" + (index + 1),
        name: tc.function?.name || "",
        args,
      }
    }).filter((tc) => tc.name)
  } else if (rawText.includes("<tool_call>")) {
    toolCalls = parseTextToolCalls(rawText)
  }

  return {
    rawMessage: message,
    text: rawText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim(),
    thought: rawReasoning,
    toolCalls,
    usage,
  }
}

function geminiToolResponse(entry) {
  if (!entry.ok) return { ok: false, error: entry.error, ...(entry.code && { code: entry.code }) }
  if (entry.modelText || entry.retained?.truncated) {
    return { ok: true, summary: entry.summary, content: entry.retained?.text ?? "" }
  }
  return { ok: true, summary: entry.summary, data: entry.data }
}

// Gemini keeps the system prompt outside `contents`, and answers tool calls with functionResponse
// parts plus inline image data inside one user turn.
function createGeminiThread({ history, systemPrompt, userText }) {
  const contents = history.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.text }],
  }))
  contents.push({ role: "user", parts: [{ text: userText }] })
  return {
    messages: contents,
    request() {
      return { systemPrompt, contents }
    },
    fallbackChars() {
      // The system instruction travels outside contents, so it is counted separately.
      return JSON.stringify(contents).length + systemPrompt.length
    },
    appendAssistant(reply) {
      contents.push(reply.rawModelContent)
    },
    appendToolResults({ entries, reminders }) {
      const parts = []
      for (const entry of entries) {
        parts.push({ functionResponse: { name: entry.name, response: geminiToolResponse(entry) } })
        if (geminiCapabilities.vision && entry.ok && entry.attachment?.base64) {
          parts.push({
            inlineData: {
              mimeType: entry.attachment.mimeType || "image/jpeg",
              data: entry.attachment.base64,
            },
          })
        }
      }
      for (const reminder of reminders) parts.push({ text: reminder })
      contents.push({ role: "user", parts })
    },
  }
}

// OpenAI-compatible servers take the system prompt as messages[0] and answer each tool call with its
// own `tool` message; images arrive as a follow-up user turn.
function createOpenAiThread({ history, systemPrompt, userText }) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((msg) => ({ role: msg.role, content: msg.text })),
    { role: "user", content: userText },
  ]
  return {
    messages,
    request() {
      return { messages }
    },
    fallbackChars() {
      // The system prompt is already messages[0].
      return JSON.stringify(messages).length
    },
    appendAssistant(reply) {
      messages.push({
        role: "assistant",
        content: reply.text || null,
        tool_calls: reply.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      })
    },
    appendToolResults({ entries, reminders }) {
      const attachments = []
      for (const entry of entries) {
        messages.push({ role: "tool", tool_call_id: entry.id, content: entry.retained?.text ?? "" })
        if (openAiCapabilities.vision && entry.ok && entry.attachment?.base64) {
          attachments.push({
            summary: entry.summary,
            mimeType: entry.attachment.mimeType || "image/jpeg",
            base64: entry.attachment.base64,
          })
        }
      }
      for (const att of attachments) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[Ảnh đính kèm từ inspect_page_image: ${att.summary}]` },
            { type: "image_url", image_url: { url: `data:${att.mimeType};base64,${att.base64}` } },
          ],
        })
      }
      for (const reminder of reminders) {
        messages.push({ role: "user", content: reminder })
      }
    },
  }
}

function prepareGeminiCredential(settings, { vaultKeys, readField }) {
  if (vaultKeys) return settings
  const key = readField(geminiCredential.field)
  if (!key) throw new Error("Hãy nhập khóa API Gemini.")
  return { ...settings, key }
}

function prepareOpenAiCredential(settings, { vaultKeys, readField }) {
  openAiEndpoint.validate(settings[openAiEndpoint.field])
  if (!settings.llmModel) throw new Error("Hãy nhập tên Model LLM.")
  return vaultKeys ? settings : { ...settings, apiKey: readField(openAiCredential.field) }
}

const geminiProvider = {
  id: "gemini",
  label: "Gemini",
  shape: "gemini",
  endpoint: geminiEndpoint,
  credential: geminiCredential,
  models: {
    resolve(settings = {}) {
      return geminiModels[settings.model] ?? geminiModels.auto
    },
  },
  capabilities: geminiCapabilities,
  labels: geminiMarks,
  prepareCredential: prepareGeminiCredential,
  callStep: callGeminiStep,
  conversation: { pruneShape: "gemini", createThread: createGeminiThread },
}

const openAiProvider = {
  id: "openai",
  label: "OpenAI/Local",
  shape: "openai",
  endpoint: openAiEndpoint,
  credential: openAiCredential,
  models: openAiModels,
  capabilities: openAiCapabilities,
  labels: openAiLabels,
  prepareCredential: prepareOpenAiCredential,
  callStep: callOpenAiStep,
  conversation: { pruneShape: "openai", createThread: createOpenAiThread },
}

export const providerRegistry = createProviderRegistry([geminiProvider, openAiProvider], { fallbackId: "gemini" })

export function resolveProvider(settingsOrId) {
  return providerRegistry.resolve(settingsOrId)
}

export function providerModels(providerId, settings) {
  return providerRegistry.models(providerId, settings)
}

export function providerLabel(settingsOrId, variant = "agent") {
  return providerRegistry.label(settingsOrId, variant)
}
