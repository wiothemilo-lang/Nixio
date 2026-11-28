import { executeToolBatch } from "./agent-pipeline.js"
import {
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  buildLayeredSystemPrompt,
  buildRuntimeContextReminder,
  compactChatHistory,
  computeContextBudget,
  pruneOldToolResults,
  retainHeadTailText,
} from "./agent-context.js"
import { RepeatToolGuard } from "./agent-guards.js"
import { withLlmRetry } from "./llm-retry.js"
import { providerRegistry } from "./provider-registry.js"
import { countCall, emptyTotals, estimatePromptChars, normalizeUsage } from "./token-accounting.js"

// The wire encodings live with their provider now, and these stay exported here because this module
// was already the public name for them.
export { parseTextToolCalls, readSseEvents } from "./provider-registry.js"

export function buildSystemPrompt({
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  sourceLanguage = "Japanese",
  targetLanguage = "Vietnamese",
  direction = "rtl",
  skillPrompt = "",
} = {}) {
  return buildLayeredSystemPrompt({
    allowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage,
    targetLanguage,
    direction,
    skillPrompt,
  })
}

export function stripReasoning(raw) {
  const text = String(raw || "")
  const thoughts = []
  const cleaned = text
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
      if (inner.trim()) thoughts.push(inner.trim())
      return ""
    })
    .trim()
  return { thought: thoughts.join("\n\n"), answer: cleaned }
}

// The thread owns which shape carries the prompt, so it also owns the estimated size: Gemini keeps the
// system instruction outside `contents`, while OpenAI already carries it as the first message. The
// estimate never sees the image bytes.
function threadPromptChars(thread) {
  const request = thread.request()
  return estimatePromptChars(request.contents ?? request.messages ?? "") + (request.systemPrompt?.length ?? 0)
}

export async function summarizeHistoryWithLlm({
  history = [],
  settings,
  keepRecentMessages = 4,
  signal,
  providers = providerRegistry,
  accounting = null,
} = {}) {
  const list = Array.isArray(history) ? history.filter((m) => m && typeof m.text === "string" && m.text.trim()) : []
  if (list.length <= keepRecentMessages + 1) {
    return compactChatHistory(list, { keepRecentMessages, force: true })
  }
  // A summary is a paid provider call too: the same pre-flight gate that guards every agent step
  // must guard it, otherwise `/compact ai` can spend past a budget that already blocked new turns.
  const gate = accounting?.gate?.()
  if (gate?.blocked) {
    return {
      ...compactChatHistory(list, { keepRecentMessages, force: true }),
      usage: null,
      budgetBlocked: true,
      message: gate.message,
    }
  }
  const totalChars = list.reduce((sum, m) => sum + m.text.length, 0)
  const older = list.slice(0, list.length - keepRecentMessages)
  const recent = list.slice(list.length - keepRecentMessages)
  const transcript = older
    .map((m) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.text.slice(0, 1000)}`)
    .join("\n\n")
  const directive = [
    "Hãy tóm tắt ngắn gọn bằng tiếng Việt đoạn hội thoại biên tập truyện tranh trên thành một mốc ngữ cảnh (checkpoint) để tiếp tục công việc không mất thông tin quan trọng.",
    "Giữ các mục ngắn dạng gạch đầu dòng: Mục tiêu chính, Tên nhân vật / Xưng hô & Thuật ngữ đã chốt, Các thay đổi đã làm, Việc còn dang dở.",
    "Chỉ xuất nội dung tóm tắt, không gọi công cụ.",
  ].join("\n")

  const provider = providers.resolve(settings)
  const thread = provider.conversation.createThread({
    history: [],
    systemPrompt: "Bạn là bộ nén ngữ cảnh cho trình biên tập truyện tranh Nixio.",
    userText: `${transcript}\n\n---\n${directive}`,
  })
  const reply = await withLlmRetry(
    () => provider.callStep({ settings, thread, toolDefs: [], signal }),
    { maxRetries: 1, signal },
  )

  const summary = stripReasoning(reply.text).answer.trim()
  // The compaction call is a paid call like any step, so it enters the same ledger.
  const usage = accounting?.record?.({
    provider: provider.id,
    model: provider.models.resolve(settings)[0],
    kind: "summary",
    tokens: normalizeUsage({
      usage: reply.usage,
      promptChars: threadPromptChars(thread),
      completionChars: reply.text.length,
    }),
  }) ?? null
  if (!summary) return { ...compactChatHistory(list, { keepRecentMessages, force: true }), usage }
  const checkpointMessage = {
    role: "assistant",
    compacted: true,
    text: `${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`,
  }
  const nextHistory = [checkpointMessage, ...recent]
  const nextChars = nextHistory.reduce((sum, m) => sum + m.text.length, 0)
  return {
    history: nextHistory,
    compacted: true,
    llmSummarized: true,
    foldedMessages: older.length,
    charsSaved: Math.max(0, totalChars - nextChars),
    usage,
  }
}

export async function runAgentTurn({
  history = [],
  userMessage,
  settings,
  tools,
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  confirmBulkEdits = true,
  skillPrompt = "",
  maxSteps = 10,
  maxRetries = 2,
  stream = false,
  signal,
  providers = providerRegistry,
  onEvent = () => {},
  // Injected by the editor: `record(call)` books a paid call in the project ledger and `gate()` reads
  // the soft budget. Absent in an offline run, where the turn still reports its own token totals.
  accounting = null,
  // A `createTurnRecorder()` from agent-replay. It receives the same events as the panel plus every
  // model decision and tool outcome, so the run can be exported and replayed without the provider.
  recorder = null,
}) {
  const promptText = String(userMessage || "").trim()
  if (!promptText) throw new Error("Hãy nhập câu hỏi hoặc yêu cầu cho Trợ lý AI.")

  const turnStart = performance.now()
  // Everything the UI sees also reaches the transcript, so a recorded turn and a live one never drift
  // apart in what they count as an event.
  const emit = recorder
    ? (event) => {
      recorder.event(event)
      onEvent(event)
    }
    : onEvent
  const effectiveAllowEdits = Boolean(allowEdits) && !planMode
  const compacted = compactChatHistory(history)
  const workingHistory = compacted.history
  if (compacted.compacted) {
    emit({
      type: "compacted",
      foldedMessages: compacted.foldedMessages,
      charsSaved: compacted.charsSaved,
    })
  }

  const systemPrompt = buildSystemPrompt({
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage: settings.source,
    targetLanguage: settings.target,
    direction: settings.direction,
    skillPrompt,
  })
  const provider = providers.resolve(settings)
  const providerLabel = provider.labels.agent(settings)
  const runtimeReminder = buildRuntimeContextReminder({
    snapshot: tools.getRuntimeSnapshot?.() ?? {},
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    providerLabel,
  })
  const toolDefs = provider.capabilities.tools
    ? tools.definitions({ allowEdits: effectiveAllowEdits, allowWebSearch, planMode })
    : []
  const streaming = stream && provider.capabilities.stream
  const toolTrace = []
  const thoughts = []
  const repeatGuard = new RepeatToolGuard()
  let totalPrunedChars = compacted.charsSaved
  let editsMade = 0
  let retriesUsed = 0
  // Set once this turn has pulled untrusted web content into the model context. From then on
  // every write is gated behind an explicit human approval, whatever confirmBulkEdits says.
  let webContentSeen = false

  // The provider owns the message shape; the harness only knows clean chat history
  // ({ role: "user"|"assistant", text }) and the text of this turn.
  const thread = provider.conversation.createThread({
    history: workingHistory,
    systemPrompt,
    userText: `${runtimeReminder}\n\n${promptText}`,
  })

  let finalAnswer = ""
  let stepsUsed = 0
  let latestUsage = null
  let contextBudget = null
  let turnUsage = emptyTotals()
  let budgetStopped = false
  let stepLimitHit = false

  // The transcript opens with what the model was actually asked: a hash of the whole prompt (so two
  // turns with the same prompt are recognisable) and the reminder text, which is the part that
  // changes with the project state and therefore the part worth replaying.
  recorder?.begin({
    provider: provider.id,
    model: provider.models.resolve(settings)[0],
    systemPrompt,
    runtimeReminder,
    userMessage: promptText,
    flags: { allowEdits: effectiveAllowEdits, allowWebSearch, planMode, confirmBulkEdits, maxSteps },
  })

  for (let step = 1; step <= maxSteps; step++) {
    signal?.throwIfAborted()

    // The soft budget is a pre-flight gate, checked before every call: a turn that has already spent
    // the project limit stops cleanly instead of paying for one more step.
    const gate = accounting?.gate?.()
    if (gate?.blocked) {
      budgetStopped = true
      finalAnswer = gate.message
      emit({ type: "budget", message: gate.message, ...gate.status })
      emit({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
      break
    }
    stepsUsed = step

    // Replay-safe old tool-result pruning between steps (inspired by DeepSeek Harness).
    if (step > 2) {
      const pruned = pruneOldToolResults(thread.messages, {
        provider: provider.conversation.pruneShape,
      })
      if (pruned.charsSaved > 0) {
        totalPrunedChars += pruned.charsSaved
        emit({ type: "pruned", prunedCount: pruned.prunedCount, charsSaved: pruned.charsSaved })
      }
    }

    emit({ type: "step", step, maxSteps })

    const onDelta = streaming
      ? (delta) => emit({ type: "delta", step, text: delta.text || "", thought: delta.thought || "" })
      : undefined
    let reply
    try {
      reply = await withLlmRetry(
        () => provider.callStep({ settings, thread, toolDefs, signal, stream: streaming, onDelta }),
        {
          maxRetries,
          signal,
          onRetry({ attempt, maxRetries: limit, delayMs }) {
            retriesUsed++
            emit({ type: "retry", attempt, maxRetries: limit, delayMs })
          },
        },
      )
    } catch (error) {
      // A failed step is part of the transcript: the replay has to show where the turn gave up.
      recorder?.error(error?.message || String(error))
      throw error
    }

    signal?.throwIfAborted()
    if (reply.usage) latestUsage = reply.usage
    // The thread owns which shape carries the system prompt, so it also owns the estimated size.
    contextBudget = computeContextBudget({
      promptTokens: latestUsage?.promptTokens || 0,
      fallbackChars: thread.fallbackChars(),
      provider: provider.id,
      model: provider.models.resolve(settings)[0],
    })
    // Tokens come from the provider answer when it reported them; only a missing count is estimated
    // from the text size.
    const call = accounting?.record?.({
      provider: provider.id,
      model: provider.models.resolve(settings)[0],
      kind: "chat",
      tokens: normalizeUsage({
        usage: reply.usage,
        promptChars: threadPromptChars(thread),
        completionChars: reply.text.length,
      }),
    }) ?? null
    if (call) turnUsage = countCall(turnUsage, call)
    emit({
      type: "usage",
      usage: latestUsage,
      budget: contextBudget,
      accounting: call ? { call, turn: turnUsage } : null,
    })

    const { thought, answer } = stripReasoning(reply.text)
    if (reply.thought) thoughts.push(reply.thought)
    if (thought) thoughts.push(thought)
    recorder?.step({
      step,
      text: answer,
      thought: reply.thought || thought,
      usage: latestUsage,
      toolCalls: reply.toolCalls,
    })

    if (!reply.toolCalls.length) {
      finalAnswer = answer || "Đã hoàn tất yêu cầu."
      emit({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
      break
    }

    thread.appendAssistant(reply)

    // A batch that itself reads the web must not be allowed to mutate in the same step.
    const batchReadsWeb = reply.toolCalls.some((call) => tools.categoryOf?.(call.name) === "web")
    const settled = await executeToolBatch(reply.toolCalls, {
      tools,
      allowEdits: effectiveAllowEdits,
      allowWebSearch,
      planMode,
      confirmBulkEdits,
      forceWriteApproval: webContentSeen || batchReadsWeb,
      maxParallel: 4,
      signal,
      onEvent: emit,
    })

    const guardReminders = []
    const resolved = []
    for (const entry of settled) {
      toolTrace.push(entry)
      // The outcome, its approval decision and its row in the file are recorded before the model is
      // even told about it, so a transcript cannot show a call it never actually made.
      recorder?.tool({ step, entry })
      if (entry.ok && entry.category === "web") webContentSeen = true
      if (entry.ok && entry.category === "write") editsMade++
      const guardHit = repeatGuard.observe(entry.name, entry.args)
      if (guardHit) {
        guardReminders.push(guardHit.reminder)
        emit({ type: "guard", toolName: guardHit.toolName, count: guardHit.count, level: guardHit.level })
      }

      const rawModelPayload = entry.ok
        ? (entry.modelText ?? JSON.stringify({ ok: true, summary: entry.summary, data: entry.data }))
        : JSON.stringify({ ok: false, error: entry.error, ...(entry.code && { code: entry.code }) })
      const retained = retainHeadTailText(rawModelPayload, {
        thresholdChars: 9000,
        headChars: 5400,
        tailChars: 2400,
      })
      if (retained.truncated) totalPrunedChars += retained.omittedChars
      resolved.push({ ...entry, retained })
    }
    thread.appendToolResults({ entries: resolved, reminders: guardReminders })

    if (step === maxSteps) {
      stepLimitHit = true
      finalAnswer = answer || `Đã thực hiện ${toolTrace.length} bước công cụ (đạt giới hạn ${maxSteps} bước). Bạn có thể nhắn tiếp để AI tiếp tục.`
      emit({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
    }
  }

  const updatedHistory = [
    ...workingHistory,
    { role: "user", text: promptText },
    { role: "assistant", text: finalAnswer },
  ].slice(-20)

  const elapsedMs = Math.round(performance.now() - turnStart)
  // A turn that ran out of steps is not the same as a finished one: the replay has to say which.
  const status = budgetStopped ? "budget" : (stepLimitHit ? "capped" : "completed")
  recorder?.usage(turnUsage)
  recorder?.finish({ status, elapsedMs })

  return {
    answer: finalAnswer,
    thought: thoughts.join("\n\n"),
    steps: stepsUsed,
    toolTrace,
    updatedHistory,
    editsMade,
    retriesUsed,
    prunedChars: totalPrunedChars,
    elapsedMs,
    usage: latestUsage,
    usageTotals: turnUsage,
    budgetBlocked: budgetStopped,
    contextBudget,
    todos: tools.getTodos?.() ?? [],
    plan: tools.getPlan?.() ?? null,
    turnRecord: recorder?.snapshot() ?? null,
  }
}
