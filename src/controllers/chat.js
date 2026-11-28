import { runAgentTurn, summarizeHistoryWithLlm } from "../agent-harness.js"
import { compactChatHistory } from "../agent-context.js"
import {
  applyAcceptedChanges,
  clearRejections,
  createReviewSession,
  describeChange,
  explainNoChanges,
  recordRejections,
  reviewActionLabel,
} from "../agent-review.js"
import { parseSlashCommand } from "../agent-commands.js"
import { createTurnRecorder } from "../agent-replay.js"
import { BUILTIN_SKILLS, getSkill, loadSkillPrefs, resolveSkillPrompt, saveSkillPrefs } from "../agent-skills.js"
import { createAgentTools } from "../agent-tools.js"
import {
  clearProjectChatSession,
  loadProjectChatSession,
  loadProjectRejections,
  saveProjectChatSession,
  saveProjectRejections,
} from "../chat-storage.js"
import { PROVIDER_BRIDGE_CODES, providerCredentialsInMain } from "../provider-bridge.js"
import { providerLabel, resolveProvider } from "../provider-registry.js"
import { formatTokens, formatUsd } from "../token-accounting.js"
import { translate } from "../i18n.js"

const searchStorageKey = "khung-thoai-search-config"
const planExecutionPrompt =
  "Kế hoạch đã được duyệt. Hãy chuyển sang thực thi từng bước theo kế hoạch trên, cập nhật tiến độ bằng todo_write và báo kết quả sau khi hoàn tất."
const planReadOnlyMessage =
  "Kế hoạch cần quyền sửa để thi hành. Hãy bật \"Cho phép sửa khung & thuật ngữ\" rồi bấm lại, hoặc nhờ AI điều chỉnh kế hoạch ở chế độ chỉ đọc."
const planStateLabels = {
  pending: "Chờ duyệt",
  running: "Đang thực thi",
  done: "Hoàn tất",
  cancelled: "Đã dừng",
  error: "Thất bại",
}

function appendSafeTextWithLinks(container, text) {
  const lines = String(text || "").split("\n")
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) container.append(document.createElement("br"))
    const urlPattern = /https:\/\/[^\s<>()]+/g
    let lastIndex = 0
    let match
    while ((match = urlPattern.exec(line)) !== null) {
      if (match.index > lastIndex) {
        container.append(document.createTextNode(line.slice(lastIndex, match.index)))
      }
      const rawUrl = match[0].replace(/[.,;:!?)\]]+$/, "")
      const trailing = match[0].slice(rawUrl.length)
      const link = document.createElement("a")
      link.href = rawUrl
      link.target = "_blank"
      link.rel = "noopener noreferrer"
      link.textContent = rawUrl
      container.append(link)
      if (trailing) container.append(document.createTextNode(trailing))
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < line.length) {
      container.append(document.createTextNode(line.slice(lastIndex)))
    }
  })
}

export function setupChat({
  state,
  byId,
  t = (key, params) => translate("vi", key, params),
  checkpoint,
  editorSnapshot,
  render,
  selectedPage,
  selectedIndex,
  selectPage,
  projectBusy,
  commitLiveForm,
  readTranslationSettings,
  readChatEffort = () => "",
  onSkillChange,
  registerFontName,
  renderFontOptions,
  notify,
  restoreHistory,
  usageLedger,
  replay = null,
}) {
  const panel = byId("chat-panel")
  const toggleBtn = byId("open-chat")
  const messagesEl = byId("chat-messages")
  const jumpBtn = byId("chat-jump")
  const form = byId("chat-form")
  const input = byId("chat-input")
  const sendBtn = byId("chat-send")
  const stopBtn = byId("chat-stop")
  const statusEl = byId("chat-status")
  const contextMeterEl = byId("chat-context-meter")
  const statsEl = byId("chat-stats")
  const todoBar = byId("chat-todo-bar")
  const todoCount = byId("chat-todo-count")
  const todoList = byId("chat-todo-list")
  const planModeInput = byId("chat-plan-mode")
  const allowEditsInput = byId("chat-allow-edits")
  const allowWebInput = byId("chat-allow-web")
  const confirmBulkInput = byId("chat-confirm-bulk")
  const reviewInput = byId("chat-review-changes")
  const compactBtn = byId("chat-compact")
  const skillSelect = byId("chat-skill")
  const skillCustomInput = byId("chat-skill-custom")
  const providerSelect = byId("chat-search-provider")
  const searchUrlInput = byId("chat-search-url")
  const searchKeyInput = byId("chat-search-key")
  const clearBtn = byId("chat-clear")
  const chipButtons = [...panel.querySelectorAll("[data-chat-prompt]")]

  let chatHistory = []
  let activeController = null
  let activeTurnEl = null
  // Changes the user refused in this project. Staged proposals are checked against it so an
  // identical change is flagged instead of being applied again behind their back.
  let rejectionLog = []

  // Trusted mode still records every change; it only skips the wait for a click.
  const reviewEveryChange = () => (reviewInput ? Boolean(reviewInput.checked) : true)

  function syncBusyControls() {
    const busy = Boolean(activeController)
    panel.setAttribute("aria-busy", busy ? "true" : "false")
    input.disabled = busy
    sendBtn.disabled = busy
    if (clearBtn) clearBtn.disabled = busy
    if (compactBtn) compactBtn.disabled = busy
    for (const chip of chipButtons) chip.disabled = busy
    stopBtn.disabled = false
    stopBtn.hidden = !busy
    stopBtn.setAttribute("aria-label", busy ? "Dừng tác vụ AI đang chạy" : "Dừng tác vụ AI")
  }

  function reportBusy() {
    statusEl.textContent = activeController
      ? "AI đang xử lý — hãy chờ hoặc bấm Dừng trước khi gửi yêu cầu mới."
      : "Hãy chờ tác vụ hiện tại hoàn tất."
  }

  function loadSearchConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(searchStorageKey) || "null")
      if (!saved || typeof saved !== "object") return
      if (["auto", "tavily", "searxng"].includes(saved.provider)) providerSelect.value = saved.provider
      if (typeof saved.searchUrl === "string") searchUrlInput.value = saved.searchUrl
    } catch {
      // Ignore storage access errors.
    }
  }

  function saveSearchConfig() {
    try {
      localStorage.setItem(
        searchStorageKey,
        JSON.stringify({
          provider: providerSelect.value,
          searchUrl: searchUrlInput.value.trim(),
        }),
      )
    } catch {
      // Ignore storage access errors.
    }
  }

  function syncSearchFields() {
    const mode = providerSelect.value
    byId("chat-search-url-field").hidden = mode !== "searxng"
    byId("chat-search-key-field").hidden = mode !== "tavily"
  }

  loadSearchConfig()
  syncSearchFields()
  providerSelect.onchange = () => {
    syncSearchFields()
    saveSearchConfig()
  }
  searchUrlInput.onchange = saveSearchConfig

  function persistSkill() {
    saveSkillPrefs({
      skillId: skillSelect.value,
      customInstructions: skillCustomInput?.value || "",
    })
    onSkillChange?.()
  }

  // Populate & persist genre Skills.
  if (skillSelect) {
    skillSelect.replaceChildren(...BUILTIN_SKILLS.map((skill) => new Option(skill.name, skill.id)))
    const savedSkill = loadSkillPrefs()
    skillSelect.value = savedSkill.skillId
    if (skillCustomInput) skillCustomInput.value = savedSkill.customInstructions
    skillSelect.onchange = persistSkill
    if (skillCustomInput) skillCustomInput.onchange = persistSkill
  }

  function readSkillPrompt() {
    return resolveSkillPrompt(skillSelect?.value || "default", skillCustomInput?.value || "")
  }

  function readSearchConfig() {
    return {
      provider: providerSelect.value,
      searchUrl: searchUrlInput.value.trim(),
      searchApiKey: searchKeyInput.value.trim(),
    }
  }

  function readAgentSettings() {
    const base = { ...readTranslationSettings(), effort: readChatEffort() }
    // The desktop keeps the keys in the OS vault and main attaches them, so the password fields are
    // never read into a request here. A browser has no vault and uses the value on screen, in memory
    // only, which is the same shape the harness already accepts.
    if (providerCredentialsInMain()) return base
    return {
      ...base,
      key: byId("gemini-key").value.trim(),
      apiKey: byId("llm-key").value.trim(),
    }
  }

  // Every paid call in this panel is booked against the project ledger, so the soft budget and the
  // per-project totals see agent steps and compaction calls alike.
  const accounting = usageLedger
    ? {
      record: (call) => usageLedger.record({ ...call, pageId: selectedPage()?.id }),
      gate: () => usageLedger.gate(),
    }
    : null

  // Main rejects a provider request whose vault entry is missing with a fixed code, so the chat keeps
  // a Vietnamese message instead of echoing main's own wording.
  function providerFailureText(error) {
    if (error?.code !== PROVIDER_BRIDGE_CODES.CREDENTIAL) return error?.message || String(error)
    return resolveProvider(readTranslationSettings()).credential.vaultMessage
  }

  function refreshModelBadge() {
    byId("chat-model-badge").textContent = providerLabel(readTranslationSettings(), "badge")
  }
  refreshModelBadge()

  function renderTodos(todos) {
    if (!todoBar || !todoList || !todoCount) return
    if (!Array.isArray(todos) || !todos.length) {
      todoBar.hidden = true
      todoList.replaceChildren()
      return
    }
    const done = todos.filter((t) => t.status === "completed").length
    todoCount.textContent = `${done}/${todos.length}`
    todoList.replaceChildren(
      ...todos.map((item) => {
        const li = document.createElement("li")
        li.className = "chat-todo-item"
        li.dataset.status = item.status
        const marker = document.createElement("span")
        marker.setAttribute("aria-hidden", "true")
        marker.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"
        const text = document.createElement("span")
        text.textContent = item.content
        li.append(marker, text)
        return li
      }),
    )
    todoBar.hidden = false
  }

  // Nixio #91: a long answer used to drag the transcript back to the end on every delta, so reading
  // earlier messages during a turn was impossible. The tail is followed only while the reader is
  // still at the bottom, and the jump control advertises what arrived while they read further up.
  const bottomSlackPx = 40
  let followingTail = true

  function atTail() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= bottomSlackPx
  }

  function syncJumpControl() {
    if (jumpBtn) jumpBtn.hidden = followingTail
  }

  // An explicit jump: the newest output was asked for, so the tail is pinned again.
  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
    followingTail = true
    syncJumpControl()
  }

  // Streamed output never moves a reader who scrolled away from the tail.
  function followTail() {
    if (followingTail) messagesEl.scrollTop = messagesEl.scrollHeight
  }

  // A jump reports a scroll as well, so the flag is recomputed from the real distance instead of
  // being assumed.
  messagesEl.addEventListener("scroll", () => {
    const tail = atTail()
    if (tail === followingTail) return
    followingTail = tail
    syncJumpControl()
  })

  if (jumpBtn) {
    jumpBtn.onclick = () => {
      scrollToBottom()
      input.focus()
    }
  }
  syncJumpControl()

  function renderSystemNotice(text) {
    const el = document.createElement("div")
    el.className = "chat-msg system"
    appendSafeTextWithLinks(el, text)
    messagesEl.append(el)
    scrollToBottom()
  }

  function renderPlanCard(plan, container) {
    if (!plan || !container) return
    const card = document.createElement("div")
    card.className = "chat-plan-card"

    const head = document.createElement("div")
    head.className = "chat-plan-head"
    const title = document.createElement("strong")
    title.textContent = `Kế hoạch: ${plan.title}`
    const badge = document.createElement("span")
    badge.className = "chat-badge"
    head.append(title, badge)

    const pre = document.createElement("pre")
    pre.className = "chat-plan-body"
    pre.textContent = plan.markdown

    const actions = document.createElement("div")
    actions.className = "form-actions"
    const execBtn = document.createElement("button")
    execBtn.type = "button"
    execBtn.className = "button primary"

    const setExecutionState = (state) => {
      badge.dataset.state = state
      badge.textContent = planStateLabels[state]
      execBtn.disabled = state === "running" || state === "done"
      execBtn.textContent = state === "error" || state === "cancelled"
        ? "Thử lại thực thi"
        : "Thực thi kế hoạch"
    }
    setExecutionState("pending")

    execBtn.onclick = () => {
      if (activeController) {
        reportBusy()
        return
      }
      if (projectBusy()) {
        statusEl.textContent = "Hãy chờ tác vụ hiện tại hoàn tất rồi thực thi kế hoạch."
        return
      }
      if (!allowEditsInput?.checked) {
        statusEl.textContent = planReadOnlyMessage
        return
      }
      const accepted = sendPrompt(planExecutionPrompt, {
        planMode: false,
        onTurnStart: () => setExecutionState("running"),
        onTurnEnd: ({ ok, cancelled }) => {
          setExecutionState(ok ? "done" : cancelled ? "cancelled" : "error")
        },
      })
      if (!accepted) {
        setExecutionState("pending")
        statusEl.textContent = "Chưa thể thực thi kế hoạch lúc này. Hãy thử lại sau khi tác vụ hiện tại xong."
        return
      }
      if (planModeInput) planModeInput.checked = false
    }
    actions.append(execBtn)

    card.append(head, pre, actions)
    container.append(card)
    followTail()
  }

  function promptInteractiveQuestion({ header, question, options = [], allowCustom = true, signal }) {
    return new Promise((resolve) => {
      const target = activeTurnEl || messagesEl
      const card = document.createElement("div")
      card.className = "chat-ask-card"

      const head = document.createElement("div")
      head.className = "chat-plan-head"
      const title = document.createElement("strong")
      title.textContent = header || "Cần bạn chọn"
      const badge = document.createElement("span")
      badge.className = "chat-badge"
      badge.textContent = "Đang chờ chọn"
      head.append(title, badge)

      const qText = document.createElement("p")
      qText.className = "chat-ask-question"
      qText.textContent = question
      card.append(head, qText)

      let settled = false
      const finish = (result, label) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        badge.textContent = label
        card.querySelectorAll("button, input").forEach((el) => { el.disabled = true })
        statusEl.textContent = "Đang tiếp tục xử lý…"
        resolve(result)
      }
      const onAbort = () => finish({ cancelled: true }, "Đã hủy")
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      if (options.length) {
        const list = document.createElement("div")
        list.className = "chat-ask-options"
        for (const opt of options) {
          const btn = document.createElement("button")
          btn.type = "button"
          btn.className = "button chat-ask-option"
          const strong = document.createElement("strong")
          strong.textContent = opt.label
          btn.append(strong)
          if (opt.description) {
            const small = document.createElement("small")
            small.textContent = opt.description
            btn.append(small)
          }
          btn.onclick = () => finish({ answer: opt.label, custom: false }, `Đã chọn: ${opt.label}`)
          list.append(btn)
        }
        card.append(list)
      }

      if (allowCustom) {
        const customRow = document.createElement("div")
        customRow.className = "chat-ask-custom"
        const customInput = document.createElement("input")
        customInput.type = "text"
        customInput.placeholder = "Hoặc nhập phương án khác…"
        const sendCustom = document.createElement("button")
        sendCustom.type = "button"
        sendCustom.className = "button primary"
        sendCustom.textContent = "Trả lời"
        const submitCustom = () => {
          const val = customInput.value.trim()
          if (!val) return
          finish({ answer: val, custom: true }, "Đã trả lời")
        }
        sendCustom.onclick = submitCustom
        customInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            submitCustom()
          }
        })
        customRow.append(customInput, sendCustom)
        card.append(customRow)
      }

      const cancelRow = document.createElement("div")
      cancelRow.className = "form-actions"
      const skipBtn = document.createElement("button")
      skipBtn.type = "button"
      skipBtn.className = "button"
      skipBtn.textContent = "Bỏ qua"
      skipBtn.onclick = () => finish({ cancelled: true }, "Đã bỏ qua")
      cancelRow.append(skipBtn)
      card.append(cancelRow)

      target.append(card)
      statusEl.textContent = "AI đang chờ bạn chọn phương án…"
      followTail()
    })
  }

  function promptToolApproval({ name, args, signal }) {
    return new Promise((resolve) => {
      const target = activeTurnEl || messagesEl
      const card = document.createElement("div")
      card.className = "chat-approval-card"

      const head = document.createElement("div")
      head.className = "chat-plan-head"
      const title = document.createElement("strong")
      title.textContent = `Xác nhận thao tác: ${name}`
      const badge = document.createElement("span")
      badge.className = "chat-badge"
      badge.textContent = "Chờ duyệt"
      head.append(title, badge)

      const pre = document.createElement("pre")
      pre.className = "chat-plan-body"
      pre.textContent = JSON.stringify(args ?? {}, null, 2)

      let settled = false
      const finish = (decision, label) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        badge.textContent = label
        card.querySelectorAll("button").forEach((b) => { b.disabled = true })
        statusEl.textContent = decision.approved ? `Đang chạy ${name}…` : "Đã từ chối thao tác."
        resolve(decision)
      }
      const onAbort = () => finish({ approved: false, reason: "Đã hủy" }, "Đã hủy")
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      const actions = document.createElement("div")
      actions.className = "form-actions"
      const approveBtn = document.createElement("button")
      approveBtn.type = "button"
      approveBtn.className = "button primary"
      approveBtn.textContent = "Chấp nhận"
      approveBtn.onclick = () => finish({ approved: true }, "Đã duyệt")

      const rejectBtn = document.createElement("button")
      rejectBtn.type = "button"
      rejectBtn.className = "button danger"
      rejectBtn.textContent = "Từ chối"
      rejectBtn.onclick = () => finish({ approved: false }, "Đã từ chối")

      actions.append(approveBtn, rejectBtn)
      card.append(head, pre, actions)
      target.append(card)
      statusEl.textContent = `Chờ duyệt thao tác ${name}…`
      followTail()
    })
  }

  let turnBeforeSnapshot = null
  let turnCheckpointRecorded = false
  // The project a running turn started in. A turn outlives a project switch, so its transcript has
  // to keep landing in the project it began in instead of the one the user just opened.
  let turnProjectId = null
  // Set when the editor opened another project while a turn was still running.
  let sessionSyncPending = false
  const turnProject = () => turnProjectId ?? state.projectId
  const saveTurnSession = (fields) => {
    const id = turnProject()
    if (id) saveProjectChatSession(id, fields)
  }
  // One AI turn is one named action: every tool edit inside the turn lands on the same entry, so
  // the timeline shows the turn instead of one anonymous row per tool call.
  const AI_TURN_META = { label: "Chỉnh sửa từ Trợ lý AI", kind: "ai" }

  function turnCheckpoint(snapshot) {
    if (turnBeforeSnapshot) {
      if (!turnCheckpointRecorded) {
        turnCheckpointRecorded = true
        checkpoint(turnBeforeSnapshot, AI_TURN_META)
      }
      return
    }
    checkpoint(snapshot, AI_TURN_META)
  }

  function updateContextMeter(budget) {
    if (!contextMeterEl) return
    if (!budget) {
      contextMeterEl.hidden = true
      return
    }
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    contextMeterEl.textContent = `${budget.estimated ? "~" : ""}${budget.percent}% (${fmt(budget.usedTokens)}/${fmt(budget.limitTokens)})`
    contextMeterEl.dataset.level = budget.level
    contextMeterEl.title = budget.estimated
      ? "Ước lượng mức sử dụng ngữ cảnh (gõ /compact nếu gần đầy)"
      : "Mức sử dụng ngữ cảnh thực tế từ API (gõ /compact nếu gần đầy)"
    contextMeterEl.hidden = false
  }

  // Applies the changes the user picked as ONE named history action, and remembers what was
  // refused so a later turn cannot quietly propose the same thing again.
  function applyReviewChanges(review, ids) {
    const before = editorSnapshot?.() ?? null
    const projectId = turnProject()
    const outcome = applyAcceptedChanges({
      pages: state.pages,
      session: review,
      ids,
      glossaryField: byId("translation-glossary"),
    })
    if (outcome.applied.length) {
      checkpoint(before, { label: reviewActionLabel(outcome.applied, outcome.rejected), kind: "ai" })
      render?.()
    }
    if (outcome.rejected.length) rejectionLog = recordRejections(rejectionLog, outcome.rejected)
    if (outcome.applied.length) rejectionLog = clearRejections(rejectionLog, outcome.applied)
    if (outcome.applied.length || outcome.rejected.length) {
      if (projectId) saveProjectRejections(projectId, rejectionLog)
    }
    return outcome
  }

  // The review surface: one row per proposed change, a checkbox each, accept-all / apply-picked /
  // reject-all. Nothing here mutates the project until a button is pressed.
  function renderReviewCard(review, container) {
    const counts = review.summary()
    if (!counts.total) return null
    const card = document.createElement("div")
    card.className = "chat-review-card"

    const head = document.createElement("div")
    head.className = "chat-plan-head"
    const title = document.createElement("strong")
    const badge = document.createElement("span")
    badge.className = "chat-badge"
    head.append(title, badge)

    const list = document.createElement("ul")
    list.className = "chat-review-list"
    const rows = new Map()
    for (const change of review.changes) {
      const row = document.createElement("li")
      row.className = "chat-review-item"
      row.dataset.status = change.status
      const checkbox = document.createElement("input")
      checkbox.type = "checkbox"
      checkbox.className = "chat-review-check"
      checkbox.checked = change.status !== "rejected" && !change.blocked
      checkbox.disabled = change.status === "applied"
      checkbox.setAttribute("aria-label", `Chấp nhận: ${describeChange(change)}`)
      const label = document.createElement("span")
      label.className = "chat-review-label"
      label.textContent = describeChange(change)
      row.append(checkbox, label)
      if (change.blocked) {
        const note = document.createElement("small")
        note.className = "chat-review-note"
        note.textContent = "Bạn đã từ chối thay đổi này trước đây"
        row.append(note)
      }
      rows.set(change.id, { row, checkbox })
      list.append(row)
    }

    const actions = document.createElement("div")
    actions.className = "form-actions"
    const acceptAllBtn = document.createElement("button")
    acceptAllBtn.type = "button"
    acceptAllBtn.className = "button primary"
    acceptAllBtn.textContent = "Chấp nhận tất cả"
    const applyBtn = document.createElement("button")
    applyBtn.type = "button"
    applyBtn.className = "button"
    applyBtn.textContent = "Áp dụng mục đã chọn"
    const rejectAllBtn = document.createElement("button")
    rejectAllBtn.type = "button"
    rejectAllBtn.className = "button danger"
    rejectAllBtn.textContent = "Từ chối tất cả"
    actions.append(acceptAllBtn, applyBtn, rejectAllBtn)

    const refresh = () => {
      const next = review.summary()
      title.textContent = `Thay đổi AI đề xuất (${next.total})`
      if (next.pending) badge.textContent = `${next.pending} chờ duyệt`
      else if (next.applied && !next.rejected) badge.textContent = `Đã áp dụng ${next.applied}`
      else badge.textContent = `${next.applied} áp dụng · ${next.rejected} từ chối`
      card.dataset.state = next.applied && !next.pending ? "applied" : next.pending ? "pending" : "resolved"
      for (const [id, entry] of rows) {
        const change = review.changes.find((item) => item.id === id)
        entry.row.dataset.status = change?.status ?? "rejected"
        if (change?.status === "applied") entry.checkbox.disabled = true
      }
    }

    const settle = (ids) => {
      const outcome = applyReviewChanges(review, ids)
      for (const button of [acceptAllBtn, applyBtn, rejectAllBtn]) button.disabled = true
      for (const entry of rows.values()) entry.checkbox.disabled = true
      refresh()
      if (outcome.applied.length) {
        statusEl.textContent = `Đã áp dụng ${outcome.applied.length} thay đổi${outcome.rejected.length ? `, bỏ ${outcome.rejected.length}` : ""}.`
        notify?.({
          kind: "success",
          title: "Đã áp dụng chỉnh sửa AI",
          message: `Đã áp dụng ${outcome.applied.length} thay đổi${outcome.rejected.length ? `, bỏ ${outcome.rejected.length}` : ""} — gộp thành 1 mốc Hoàn tác.`,
          key: "ai-edits",
          actions: restoreHistory ? [{ label: "Hoàn tác", onClick: () => restoreHistory("undo") }] : [],
        })
      } else {
        statusEl.textContent = `Đã từ chối ${outcome.rejected.length} thay đổi; dự án giữ nguyên.`
      }
      return outcome
    }

    // Accept-all skips the rows the user already refused once: those need an explicit tick.
    acceptAllBtn.onclick = () => settle(review.changes.filter((change) => !change.blocked).map((change) => change.id))
    applyBtn.onclick = () => settle(
      review.changes.filter((change) => rows.get(change.id)?.checkbox.checked).map((change) => change.id),
    )
    rejectAllBtn.onclick = () => settle([])

    card.append(head, list, actions)
    container.append(card)
    refresh()
    return { card, settle }
  }

  function renderTurnNote(text, container) {
    if (!text) return
    const note = document.createElement("div")
    note.className = "chat-msg system"
    note.textContent = text
    container.append(note)
  }

  const tools = createAgentTools({
    state,
    byId,
    selectedPage,
    selectedIndex,
    selectPage,
    checkpoint: turnCheckpoint,
    render,
    commitLiveForm,
    readTranslationSettings,
    registerFontName,
    renderFontOptions,
    onTodosChange: (todos) => {
      renderTodos(todos)
      saveTurnSession({ history: chatHistory, todos })
    },
    onPlanSubmit: (plan) => renderPlanCard(plan, activeTurnEl),
    onAskUser: promptInteractiveQuestion,
    onApproveTool: promptToolApproval,
    searchConfig: readSearchConfig,
  })

  function renderWelcome() {
    messagesEl.replaceChildren()
    renderTodos([])
    if (statsEl) {
      statsEl.hidden = true
      statsEl.textContent = ""
    }
    const intro = document.createElement("div")
    intro.className = "chat-msg system"
    intro.textContent = t("chat.welcome")
    messagesEl.append(intro)
  }

  function renderPersistedSession() {
    renderWelcome()
    if (!chatHistory.length) return
    for (const msg of chatHistory) {
      const bubble = document.createElement("div")
      bubble.className = `chat-msg ${msg.compacted ? "system" : msg.role}`
      appendSafeTextWithLinks(bubble, msg.text)
      messagesEl.append(bubble)
    }
    scrollToBottom()
  }

  function syncProjectSession() {
    if (activeController) {
      // The turn that is running belongs to the project the user just left and keeps writing
      // there. Adopting the new transcript now would show one project's chat under another's name
      // and feed it into the next prompt, so the switch waits for the turn to flush.
      sessionSyncPending = true
      // The rows above belong to the project the turn started in. Saying so beats leaving this
      // project's header over another project's conversation until the turn flushes.
      renderSystemNotice(
        "Lượt AI đang chạy thuộc dự án vừa rời. Hội thoại của dự án này hiện ra khi lượt đó xong.",
      )
      return
    }
    sessionSyncPending = false
    const saved = loadProjectChatSession(state.projectId)
    chatHistory = saved.history
    rejectionLog = loadProjectRejections(state.projectId)
    renderPersistedSession()
    tools.setTodos?.(saved.todos)
    replay?.refresh()
    statusEl.textContent = chatHistory.length ? `Đã khôi phục ${chatHistory.length} tin nhắn của dự án.` : ""
  }

  syncProjectSession()

  // The panel only hands the caret back while it still owns it: a close or a finished turn that
  // lands while the user is typing in the editor must leave that field alone.
  function panelHasFocus() {
    const active = document.activeElement
    return !active || active === document.body || active === panel || Boolean(panel.contains?.(active))
  }

  function setOpen(open) {
    panel.hidden = !open
    toggleBtn.setAttribute("aria-pressed", String(open))
    if (open) {
      refreshModelBadge()
      input.focus()
    } else if (panelHasFocus()) {
      toggleBtn.focus()
    }
  }

  toggleBtn.onclick = () => setOpen(panel.hidden)
  byId("chat-close").onclick = () => setOpen(false)
  // Escape is the keyboard twin of the × button and belongs to the panel only while it is open,
  // and only while no dialog owns Escape.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden || event.defaultPrevented) return
    if (document.querySelector("dialog[open]")) return
    setOpen(false)
  })

  function clearSession() {
    if (activeController) {
      reportBusy()
      return
    }
    chatHistory = []
    tools.resetTurnState?.()
    if (state.projectId) clearProjectChatSession(state.projectId)
    statusEl.textContent = ""
    renderWelcome()
  }
  clearBtn.onclick = clearSession

  async function runCompact({ useLlm = false } = {}) {
    if (activeController) {
      reportBusy()
      return
    }
    // Summarising can outlive a project switch, so it writes to the project it started in.
    const compactProjectId = state.projectId
    if (!useLlm) {
      try {
        const res = compactChatHistory(chatHistory, { force: true })
        if (!res.compacted) {
          statusEl.textContent = "Lịch sử chat còn ngắn, chưa cần nén."
          return
        }
        chatHistory = res.history
        if (compactProjectId) saveProjectChatSession(compactProjectId, { history: chatHistory, todos: tools.getTodos?.() ?? [] })
        renderPersistedSession()
        statusEl.textContent = `Đã nén ${res.foldedMessages} tin nhắn cũ (tiết kiệm ~${res.charsSaved} ký tự).`
        notify?.({
          kind: "info",
          title: "Đã nén ngữ cảnh Trợ lý AI",
          message: `Đã gộp ${res.foldedMessages} tin nhắn cũ vào mốc tóm tắt, tiết kiệm ~${res.charsSaved} ký tự.`,
          key: "chat-compact",
        })
      } catch (error) {
        statusEl.textContent = "Không nén được lịch sử chat: " + (error?.message || String(error))
      }
      return
    }
    activeController = new AbortController()
    syncBusyControls()
    statusEl.textContent = "Đang dùng AI tóm tắt ngữ cảnh…"
    try {
      const res = await summarizeHistoryWithLlm({
        history: chatHistory,
        settings: readAgentSettings(),
        signal: activeController.signal,
        accounting,
      })
      if (!res.compacted) {
        statusEl.textContent = "Lịch sử chat còn ngắn, chưa cần nén."
        return
      }
      if (res.budgetBlocked) {
        statusEl.textContent = res.message
        return
      }
      chatHistory = res.history
      if (compactProjectId) saveProjectChatSession(compactProjectId, { history: chatHistory, todos: tools.getTodos?.() ?? [] })
      renderPersistedSession()
      statusEl.textContent = `Đã tóm tắt ${res.foldedMessages} tin nhắn cũ bằng AI (-${res.charsSaved} ký tự).`
      notify?.({
        kind: "info",
        title: "Đã tóm tắt ngữ cảnh bằng AI",
        message: `Đã gộp ${res.foldedMessages} tin nhắn cũ, tiết kiệm ~${res.charsSaved} ký tự.`,
        key: "chat-compact",
      })
    } catch (error) {
      statusEl.textContent = activeController.signal.aborted
        ? "Đã dừng tóm tắt ngữ cảnh."
        : "Không tóm tắt được bằng AI: " + providerFailureText(error)
    } finally {
      const startedIn = compactProjectId
      activeController = null
      syncBusyControls()
      // A project switch during AI compaction defers exactly like one during a turn. The summary
      // was saved under the project it started in, so the panel must now adopt the open project's
      // transcript instead of keeping the old one for the next prompt.
      if (sessionSyncPending || (startedIn && startedIn !== state.projectId)) syncProjectSession()
    }
  }

  if (compactBtn) {
    compactBtn.onclick = () => runCompact({ useLlm: false })
  }

  function createToolTraceCard(event) {
    const card = document.createElement("details")
    card.className = "tool-trace"
    card.dataset.state = "running"
    const summary = document.createElement("summary")
    const icon = document.createElement("span")
    icon.className = "tool-icon"
    icon.textContent = "…"
    const name = document.createElement("code")
    name.textContent = event.name
    const label = document.createElement("span")
    label.className = "tool-summary"
    label.textContent = "Đang chạy…"
    const duration = document.createElement("span")
    duration.className = "tool-duration"
    summary.append(icon, name, label, duration)

    const body = document.createElement("div")
    body.className = "tool-body"
    const argsPre = document.createElement("pre")
    argsPre.textContent = "Tham số: " + JSON.stringify(event.args ?? {}, null, 2)
    const outPre = document.createElement("pre")
    outPre.className = "tool-output"
    body.append(argsPre, outPre)
    card.append(summary, body)
    return { card, icon, label, duration, outPre, body }
  }

  function sendPrompt(text, options = {}) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return false
    if (activeController) {
      reportBusy()
      return false
    }

    const cmd = parseSlashCommand(trimmed)
    if (cmd) {
      if (cmd.kind === "usage") {
        renderSystemNotice(cmd.text)
        return true
      }
      if (cmd.kind === "help") {
        renderSystemNotice(cmd.text)
        return true
      }
      if (cmd.kind === "clear") {
        clearSession()
        return true
      }
      if (cmd.kind === "compact") {
        runCompact({ useLlm: cmd.useLlm })
        return true
      }
      if (cmd.kind === "skill") {
        const target = BUILTIN_SKILLS.find((s) => s.id === cmd.skillId)
        if (!target) {
          renderSystemNotice(`Không có skill "${cmd.skillId}". Các skill sẵn có: ${BUILTIN_SKILLS.map((s) => s.id).join(", ")}.`)
          return true
        }
        if (skillSelect) {
          skillSelect.value = target.id
          persistSkill()
        }
        renderSystemNotice(`Đã chuyển hồ sơ biên tập sang: ${target.name} — ${target.description}`)
        return true
      }
      if (cmd.kind === "plan") {
        if (cmd.prompt && !sendPrompt(cmd.prompt, { planMode: cmd.enabled })) return false
        if (planModeInput) planModeInput.checked = cmd.enabled
        if (!cmd.prompt) {
          renderSystemNotice(cmd.enabled ? "Đã bật Chế độ Kế hoạch (Plan Mode)." : "Đã tắt Chế độ Kế hoạch.")
        }
        return true
      }
      if (cmd.kind === "prompt") {
        return sendPrompt(cmd.prompt)
      }
      if (cmd.kind === "replay") {
        // Replay is read-only, so it never takes the busy lock or asks the provider anything.
        replay?.open(cmd.id).then((result) => renderSystemNotice(result.message))
        return true
      }
      renderSystemNotice(`Lệnh không hợp lệ: /${cmd.name}. Gõ /help để xem danh sách lệnh.`)
      return true
    }

    if (projectBusy()) {
      statusEl.textContent = "Hãy chờ tác vụ hiện tại hoàn tất."
      return false
    }

    runTurn(trimmed, {
      planMode: options.planMode ?? Boolean(planModeInput?.checked),
      onTurnStart: options.onTurnStart,
      onTurnEnd: options.onTurnEnd,
    })
    return true
  }

  async function runTurn(promptText, { planMode = false, onTurnStart, onTurnEnd } = {}) {
    let settled = { ok: false, cancelled: false }
    // The turn keeps writing to the project it starts in, whatever the user opens meanwhile.
    turnProjectId = state.projectId

    const userBubble = document.createElement("div")
    userBubble.className = "chat-msg user"
    userBubble.textContent = promptText
    messagesEl.append(userBubble)

    const turnEl = document.createElement("div")
    turnEl.className = "chat-turn"
    messagesEl.append(turnEl)
    activeTurnEl = turnEl
    scrollToBottom()

    let streamBubble = null
    let streamText = ""
    let streamThoughtEl = null
    let streamThoughtPre = null
    let streamThought = ""
    // One transcript per turn. It lives outside the try so a stopped or failed turn still lands in
    // the replay panel with the steps that did run.
    const recorder = createTurnRecorder()
    const persistRecord = () => {
      const record = recorder.snapshot()
      if (record) replay?.save(record, turnProject())
      return record
    }

    const clearStreamPreview = () => {
      streamBubble?.remove()
      streamBubble = null
      streamText = ""
      streamThoughtEl?.remove()
      streamThoughtEl = null
      streamThoughtPre = null
      streamThought = ""
    }

    try {
      const traceCards = new Map()
      const confirmBulkEdits = Boolean(confirmBulkInput?.checked)
      const autoApply = !reviewEveryChange()
      const review = createReviewSession({ turnId: `turn_${Date.now()}` })
      commitLiveForm?.()
      turnBeforeSnapshot = editorSnapshot?.() ?? null
      turnCheckpointRecorded = false
      tools.beginReview?.(review, { rejections: rejectionLog })
      activeController = new AbortController()
      syncBusyControls()
      statusEl.textContent = planMode ? "Đang khảo sát & lập kế hoạch…" : "Đang suy nghĩ…"
      onTurnStart?.()

      const result = await runAgentTurn({
        history: chatHistory,
        userMessage: promptText,
        settings: readAgentSettings(),
        tools,
        allowEdits: allowEditsInput.checked,
        allowWebSearch: allowWebInput.checked,
        planMode,
        confirmBulkEdits,
        skillPrompt: readSkillPrompt(),
        maxSteps: 10,
        stream: true,
        signal: activeController.signal,
        accounting,
        recorder,
        onEvent(event) {
          if (event.type === "step") {
            clearStreamPreview()
            statusEl.textContent = `Bước ${event.step}/${event.maxSteps}…`
          } else if (event.type === "delta") {
            if (event.thought) {
              streamThought += event.thought
              if (!streamThoughtEl) {
                streamThoughtEl = document.createElement("details")
                streamThoughtEl.className = "chat-thought"
                const sum = document.createElement("summary")
                sum.textContent = "Đang suy luận…"
                streamThoughtPre = document.createElement("pre")
                streamThoughtEl.append(sum, streamThoughtPre)
                turnEl.append(streamThoughtEl)
              }
              streamThoughtPre.textContent = streamThought
              followTail()
            }
            if (event.text) {
              streamText += event.text
              const visible = streamText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "").trim()
              if (visible) {
                if (!streamBubble) {
                  streamBubble = document.createElement("div")
                  streamBubble.className = "chat-msg assistant streaming"
                  turnEl.append(streamBubble)
                }
                streamBubble.textContent = visible
                followTail()
              }
            }
          } else if (event.type === "usage") {
            updateContextMeter(event.budget)
          } else if (event.type === "budget") {
            statusEl.textContent = event.message
            notify?.({
              kind: "error",
              title: "Đã chặn lượt gọi AI",
              message: event.message,
              key: "usage-budget-stop",
            })
          } else if (event.type === "retry") {
            clearStreamPreview()
            statusEl.textContent = `Thử lại kết nối AI lần ${event.attempt}/${event.maxRetries} (${Math.round(event.delayMs / 100) / 10}s)…`
          } else if (event.type === "guard") {
            statusEl.textContent = `Phát hiện gọi lặp ${event.toolName} (${event.count}×), đang nhắc AI đổi hướng…`
          } else if (event.type === "compacted") {
            statusEl.textContent = `Đã tự nén ${event.foldedMessages} tin cũ…`
          } else if (event.type === "pruned") {
            statusEl.textContent = `Đang tối ưu ngữ cảnh (-${event.charsSaved} ký tự)…`
          } else if (event.type === "tool_start") {
            clearStreamPreview()
            statusEl.textContent = `Đang gọi công cụ ${event.name}…`
            const ref = createToolTraceCard(event)
            traceCards.set(event.id, ref)
            turnEl.append(ref.card)
            followTail()
          } else if (event.type === "tool_end") {
            const ref = traceCards.get(event.id)
            if (ref) {
              ref.card.dataset.state = event.ok ? "ok" : "error"
              ref.icon.textContent = event.ok ? "✓" : "✗"
              ref.label.textContent = event.summary || (event.ok ? "Hoàn tất" : "Lỗi")
              ref.duration.textContent = `${event.durationMs} ms`
              const previewText = event.ok
                ? JSON.stringify(event.data ?? {}, null, 2)
                : String(event.error || "Lỗi không xác định")
              ref.outPre.textContent = previewText.length > 2400 ? previewText.slice(0, 2400) + "\n…" : previewText
              if (event.ok && Array.isArray(event.data?.results) && event.data.results.length) {
                const linksList = document.createElement("ul")
                linksList.className = "tool-links"
                for (const item of event.data.results.slice(0, 5)) {
                  if (!item?.url?.startsWith("https://")) continue
                  const li = document.createElement("li")
                  const a = document.createElement("a")
                  a.href = item.url
                  a.target = "_blank"
                  a.rel = "noopener noreferrer"
                  a.textContent = item.title || item.url
                  li.append(a)
                  linksList.append(li)
                }
                if (linksList.childElementCount) ref.body.append(linksList)
              }
            }
            followTail()
          }
        },
      })

      clearStreamPreview()
      chatHistory = result.updatedHistory
      saveTurnSession({ history: chatHistory, todos: result.todos })
      persistRecord()
      if (result.contextBudget) updateContextMeter(result.contextBudget)
      if (result.thought) {
        const thoughtDetails = document.createElement("details")
        thoughtDetails.className = "chat-thought"
        const thoughtSummary = document.createElement("summary")
        thoughtSummary.textContent = "Suy luận của model"
        const thoughtPre = document.createElement("pre")
        thoughtPre.textContent = result.thought
        thoughtDetails.append(thoughtSummary, thoughtPre)
        turnEl.append(thoughtDetails)
      }
      const assistantBubble = document.createElement("div")
      assistantBubble.className = "chat-msg assistant"
      appendSafeTextWithLinks(assistantBubble, result.answer)
      turnEl.append(assistantBubble)

      // Proposed edits land here, not in the project: the user decides change by change, and a
      // trusted mode applies them without a click while still keeping the list on record.
      const reviewCounts = review.summary()
      if (reviewCounts.total) {
        const handle = renderReviewCard(review, turnEl)
        if (autoApply) {
          handle?.settle(review.changes.filter((change) => !change.blocked).map((change) => change.id))
        } else if (reviewCounts.pending) {
          notify?.({
            kind: "info",
            title: "AI đề xuất thay đổi",
            message: `${reviewCounts.pending} thay đổi đang chờ bạn duyệt trong khung chat.`,
            key: "ai-review",
          })
        }
      } else {
        // A turn that changes nothing still owes the reader a reason.
        renderTurnNote(explainNoChanges({
          planMode,
          allowEdits: Boolean(allowEditsInput.checked),
          budgetBlocked: Boolean(result.budgetBlocked),
          writeCalls: result.toolTrace.filter((entry) => entry.category === "write").length,
        }), turnEl)
      }

      statusEl.textContent = result.budgetBlocked
        ? "Đã dừng vì hạn mức chi phí AI."
        : result.toolTrace.length
          ? `Hoàn tất (${result.steps} bước · ${result.toolTrace.length} công cụ).`
          : "Hoàn tất."
      if (statsEl) {
        const parts = [`${(result.elapsedMs / 1000).toFixed(1)}s`]
        if (result.retriesUsed > 0) parts.push(`${result.retriesUsed} retry`)
        if (result.prunedChars > 0) parts.push(`-${result.prunedChars} kt`)
        const usage = result.usageTotals
        if (usage?.totalTokens) {
          parts.push(`${formatTokens(usage.totalTokens)} token`)
          if (usage.costUsd > 0) parts.push(formatUsd(usage.costUsd))
          else if (usage.unpricedCalls > 0) parts.push("chưa đặt giá")
        }
        statsEl.textContent = parts.join(" · ")
        statsEl.hidden = false
      }
      settled = { ok: true, cancelled: false }
    } catch (error) {
      clearStreamPreview()
      const stopped = activeController?.signal.aborted
      const errEl = document.createElement("div")
      errEl.className = "chat-msg error"
      errEl.textContent = stopped ? "Đã dừng lượt xử lý của AI." : "Lỗi: " + providerFailureText(error)
      turnEl.append(errEl)
      statusEl.textContent = stopped ? "Đã dừng." : "Gặp lỗi."
      // The transcript keeps the steps that did run, and says why the turn ended early.
      recorder.finish({
        status: stopped ? "stopped" : "failed",
        error: stopped ? "Người dùng đã dừng lượt này." : providerFailureText(error),
      })
      persistRecord()
      settled = { ok: false, cancelled: Boolean(stopped) }
    } finally {
      turnBeforeSnapshot = null
      turnCheckpointRecorded = false
      const startedIn = turnProjectId
      turnProjectId = null
      tools.endReview?.()
      activeController = null
      activeTurnEl = null
      syncBusyControls()
      // The user may have opened another project mid-turn. This turn's transcript is already saved
      // under the project it started in, so the panel can pick up the one they are looking at now
      // instead of handing it the previous project's history on the next prompt.
      if (sessionSyncPending || (startedIn && startedIn !== state.projectId)) syncProjectSession()
      followTail()
      if (!panel.hidden && panelHasFocus()) input.focus()
      onTurnEnd?.(settled)
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault()
    const submitted = input.value
    const text = submitted.trim()
    if (!text) return
    if (!sendPrompt(text)) {
      input.focus()
      return
    }
    if (input.value === submitted) input.value = ""
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      form.requestSubmit()
    }
  })

  stopBtn.onclick = () => {
    if (!activeController) return
    statusEl.textContent = "Đang dừng…"
    activeController.abort()
  }

  for (const button of chipButtons) {
    button.onclick = () => {
      if (activeController) {
        reportBusy()
        return
      }
      sendPrompt(button.dataset.chatPrompt)
    }
  }

  syncBusyControls()

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    refreshModelBadge,
    syncProjectSession,
    // The welcome card is the only chat copy on screen before a project has a transcript; redraw it
    // on a locale switch so a fresh session does not keep the previous language's introduction.
    refreshWelcome: () => { if (!chatHistory.length) renderWelcome() },
    getActiveSkill: () => getSkill(skillSelect?.value || "default"),
  }
}
