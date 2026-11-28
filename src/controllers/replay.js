// Transcript replay panel for the chat sidebar (Nixio #66).
//
// A turn is recorded as a bounded, redacted transcript while it runs. This panel lists those
// transcripts and replays one: every decision is read back from the record, the provider is never
// called and no tool runs, so approving a write once cannot write twice just because someone pressed
// "replay".

import { exportTurnRecord, replayTurnRecord } from "../agent-replay.js"
import {
  clearProjectTurnRecords,
  findProjectTurnRecord,
  loadProjectTurnRecords,
  saveProjectTurnRecord,
} from "../chat-storage.js"
import { saveFile } from "../io.js"
import { translate } from "../i18n.js"
import { formatTokens, formatUsd } from "../token-accounting.js"

export const REPLAY_STATUS_COPY = Object.freeze({
  running: "Đang chạy",
  completed: "Hoàn tất",
  stopped: "Đã dừng",
  failed: "Thất bại",
  budget: "Dừng vì hạn mức",
  capped: "Chạm giới hạn bước",
})

export const REPLAY_APPROVAL_COPY = Object.freeze({
  "not-required": "không cần duyệt",
  approved: "đã duyệt",
  rejected: "bị từ chối",
  unavailable: "thiếu hộp duyệt",
  blocked: "bị chặn",
})

const DIFFERENCE_COPY = {
  chain: "chuỗi công cụ",
  args: "tham số",
  outcome: "kết quả",
  decision: "quyết định duyệt",
  count: "số lần gọi",
}

function clip(text, limit) {
  const value = String(text ?? "")
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function formatElapsed(ms) {
  const value = Number(ms) || 0
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(1)}s`
}

function describeValue(value) {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return clip(value, 80)
  try {
    return clip(JSON.stringify(value), 120)
  } catch {
    return "—"
  }
}

export function setupReplay({
  byId,
  projectId = () => "",
  notify = () => {},
  writeFile = saveFile,
  t = (key, params) => translate("vi", key, params),
} = {}) {
  const panelEl = byId?.("chat-replay")
  const listEl = byId?.("chat-replay-list")
  const emptyEl = byId?.("chat-replay-empty")
  const traceEl = byId?.("chat-replay-trace")
  const exportBtn = byId?.("chat-replay-export")
  const clearBtn = byId?.("chat-replay-clear")

  let selectedRecord = null

  function renderItem(record) {
    const item = document.createElement("li")
    item.className = "chat-replay-item"
    item.dataset.state = record.status
    const label = document.createElement("span")
    label.className = "chat-replay-label"
    const model = record.model.name || record.model.provider || "không rõ model"
    label.textContent = `${record.id} · ${model} · ${record.steps.length} bước · ${record.tools.length} công cụ · ${formatElapsed(record.timing.elapsedMs)} · ${REPLAY_STATUS_COPY[record.status] ?? record.status}`
    const play = document.createElement("button")
    play.type = "button"
    play.className = "button"
    play.textContent = "Phát lại"
    // A click that cannot replay anything has to say why, or the button looks broken.
    play.onclick = async () => {
      const result = await open(record.id)
      if (!result?.ok) {
        notify?.({
          kind: "error",
          title: "Không phát lại được lượt này",
          message: result?.message || "Bản ghi lượt không đọc được.",
        })
      }
    }
    item.append(label, play)
    return item
  }

  function refresh() {
    if (!listEl) return []
    const records = loadProjectTurnRecords(projectId())
    listEl.replaceChildren(...records.map(renderItem))
    if (emptyEl) emptyEl.hidden = records.length > 0
    if (exportBtn) exportBtn.disabled = !selectedRecord
    if (clearBtn) clearBtn.disabled = records.length === 0
    return records
  }

  function renderToolEntry(entry) {
    const row = document.createElement("div")
    row.className = "chat-replay-tool"
    row.dataset.kind = "tool"
    row.dataset.state = entry.state
    row.dataset.category = entry.category
    const title = document.createElement("strong")
    title.textContent = entry.name
    const args = document.createElement("code")
    args.textContent = clip(JSON.stringify(entry.args ?? {}), 200)
    const badge = document.createElement("span")
    badge.className = "chat-replay-badge"
    badge.textContent = REPLAY_APPROVAL_COPY[entry.approval] ?? entry.approval
    const outcome = document.createElement("p")
    outcome.className = "chat-replay-outcome"
    outcome.textContent = `${entry.ok ? "OK" : "Lỗi"} · ${clip(entry.outcome || "không có kết quả", 300)}`
    row.append(title, args, badge, outcome)
    return row
  }

  function renderUsage(usage) {
    const parts = []
    if (Number.isFinite(usage.promptTokens)) parts.push(t("replay.usage.prompt", { tokens: formatTokens(usage.promptTokens) }))
    if (Number.isFinite(usage.outputTokens)) parts.push(t("replay.usage.output", { tokens: formatTokens(usage.outputTokens) }))
    if (Number.isFinite(usage.cachedTokens) && usage.cachedTokens > 0) {
      parts.push(t("replay.usage.cached", { tokens: formatTokens(usage.cachedTokens) }))
    }
    if (!parts.length && Number.isFinite(usage.totalTokens)) parts.push(t("replay.usage.total", { tokens: formatTokens(usage.totalTokens) }))
    if (Number.isFinite(usage.costUsd)) parts.push(formatUsd(usage.costUsd))
    if (!parts.length) return null
    const line = document.createElement("p")
    line.className = "chat-replay-usage"
    line.textContent = t("replay.usage.label", { parts: parts.join(" · ") })
    return line
  }

  function renderStepEntry(entry) {
    const row = document.createElement("div")
    row.className = "chat-replay-step"
    row.dataset.kind = "step"
    const title = document.createElement("strong")
    title.textContent = `Bước ${entry.step} · ${entry.toolCallCount} công cụ`
    const body = document.createElement("p")
    body.textContent = clip(entry.text, 400) || "(model không trả lời bằng văn bản)"
    row.append(title, body)
    // Providers report per-step counts, but the turn total alone cannot say which step spent them.
    const usage = entry.usage ? renderUsage(entry.usage) : null
    if (usage) row.append(usage)
    if (entry.thought) {
      const details = document.createElement("details")
      details.className = "chat-thought"
      const summary = document.createElement("summary")
      summary.textContent = "Suy luận đã ghi"
      const pre = document.createElement("pre")
      pre.textContent = clip(entry.thought, 1200)
      details.append(summary, pre)
      row.append(details)
    }
    return row
  }

  function renderEntry(entry) {
    if (entry.kind === "step") return renderStepEntry(entry)
    if (entry.kind === "tool") return renderToolEntry(entry)
    if (entry.kind === "end") {
      const row = document.createElement("p")
      row.className = "chat-replay-end"
      row.dataset.kind = "end"
      row.dataset.state = entry.status
      const parts = [
        `Kết thúc: ${REPLAY_STATUS_COPY[entry.status] ?? entry.status}`,
        `${entry.mutationsPrevented} lệnh ghi và ${entry.networkPrevented} lệnh mạng đã đọc từ bản ghi thay vì chạy lại`,
      ]
      if (entry.reason) parts.push(clip(entry.reason, 240))
      row.textContent = parts.join(" · ")
      return row
    }
    const head = document.createElement("div")
    head.className = "chat-replay-turn"
    head.dataset.kind = "turn"
    head.textContent = `${entry.provider || "?"} · ${entry.model || "?"} · mã lời nhắc ${entry.promptHash || "—"}`
    return head
  }

  function renderTrace(record, replay) {
    if (!traceEl) return
    const nodes = []
    const head = document.createElement("p")
    head.className = "chat-replay-head"
    head.textContent = `${record.id} · ${REPLAY_STATUS_COPY[replay.status] ?? replay.status} · ${record.tools.length} công cụ · mã quyết định ${replay.digest}`
    nodes.push(head)
    const note = document.createElement("p")
    note.className = "muted"
    note.textContent = "Phát lại chỉ đọc bản ghi: không gọi nhà cung cấp và không chạy lại công cụ nào."
    nodes.push(note)
    for (const entry of replay.entries) nodes.push(renderEntry(entry))
    if (replay.differences.length) {
      const differences = document.createElement("ul")
      differences.className = "chat-replay-diff"
      differences.dataset.count = String(replay.differences.length)
      for (const difference of replay.differences) {
        const item = document.createElement("li")
        item.dataset.state = "diff"
        item.textContent = `${DIFFERENCE_COPY[difference.kind] ?? difference.kind} · ${difference.path}: ${describeValue(difference.expected)} → ${describeValue(difference.actual)}`
        differences.append(item)
      }
      nodes.push(differences)
    }
    if (replay.warnings?.length) {
      const warnings = document.createElement("p")
      warnings.className = "muted chat-replay-warning"
      warnings.textContent = replay.warnings.join(" ")
      nodes.push(warnings)
    }
    traceEl.replaceChildren(...nodes)
    traceEl.hidden = false
  }

  function summaryOf(record, replay) {
    if (!replay.ok) return `Không phát lại được bản ghi ${record.id}: ${replay.error}`
    if (replay.identical) {
      return `Đã phát lại ${record.id}: chuỗi ${replay.toolChain.length} công cụ khớp bản ghi (mã ${replay.digest}).`
    }
    return `Đã phát lại ${record.id}: ${replay.differences.length} khác biệt so với bản ghi — xem mục được đánh dấu trong bảng “Ghi & phát lại”.`
  }

  async function open(id = "latest") {
    const projectKey = projectId()
    if (!projectKey) return { ok: false, message: "Hãy mở hoặc lưu một dự án trước khi phát lại lượt đã ghi." }
    const record = findProjectTurnRecord(projectKey, id)
    if (!record) {
      return {
        ok: false,
        message: id === "latest"
          ? "Chưa có bản ghi lượt nào để phát lại."
          : `Không tìm thấy bản ghi “${id}” trong dự án này.`,
      }
    }
    const replay = await replayTurnRecord(record)
    selectedRecord = record
    renderTrace(record, replay)
    if (panelEl) panelEl.open = true
    if (exportBtn) exportBtn.disabled = false
    if (clearBtn) clearBtn.disabled = false
    return { ok: replay.ok, replay, message: summaryOf(record, replay) }
  }

  function save(record, projectKey = projectId()) {
    if (!projectKey || !record) return false
    const saved = saveProjectTurnRecord(projectKey, record)
    if (saved) refresh()
    return saved
  }

  function exportSelected() {
    if (!selectedRecord) return false
    try {
      const { filename, json } = exportTurnRecord(selectedRecord)
      writeFile(new Blob([json], { type: "application/json;charset=utf-8" }), filename)
      notify?.({ kind: "success", title: "Đã xuất bản ghi lượt", message: filename })
      return true
    } catch (error) {
      notify?.({ kind: "error", title: "Không xuất được bản ghi", message: error?.message || String(error) })
      return false
    }
  }

  function clearAll() {
    const projectKey = projectId()
    if (!projectKey) return false
    clearProjectTurnRecords(projectKey)
    selectedRecord = null
    if (traceEl) {
      traceEl.replaceChildren()
      traceEl.hidden = true
    }
    if (exportBtn) exportBtn.disabled = true
    refresh()
    return true
  }

  if (exportBtn) exportBtn.onclick = () => exportSelected()
  if (clearBtn) clearBtn.onclick = () => clearAll()

  return {
    refresh,
    save,
    open,
    exportSelected,
    clearAll,
    selectedRecord: () => selectedRecord,
  }
}
