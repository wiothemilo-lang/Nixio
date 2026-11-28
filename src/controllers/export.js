import { copyEditor } from "../history.js"
import { layersNativeFriendly } from "../layers.js"
import { exportPage, nativePageLayers, textOverflows } from "../canvas.js"
import { filenameStem, saveFile } from "../io.js"
import { translationSignature } from "../translation.js"
import { exportDialogueScript } from "../tools.js"
import { lintChapter } from "../linter.js"
import {
  buildQaBoard,
  filterQaFindings,
  qaBlockingFindings,
  qaExportOverrideNote,
  qaFindingBox,
  qaReviewSeverityLabels,
  qaReviewStates,
  qaReviewStateLabels,
  qaReviewSummary,
} from "../qa-review.js"
import {
  describeExportProfile,
  exportManifest,
  exportManifestFileName,
  loadGlobalExportProfileId,
  planExportSlices,
  resolveExportProfile,
  serializeExportManifest,
  writeArchiveEntry,
} from "../export-presets.js"
import { renderExportSlices } from "../webtoon.js"
import { desktop } from "../native.js"

export function setupExports({
  state,
  byId,
  status,
  renderPages,
  selectedPage,
  selectPage,
  selectBox,
  listButton,
  projectBusy,
  readTranslationSettings,
  isNativeReady,
  commitLiveForm,
  checkpoint,
  render,
  changed,
  qaReview,
  notify,
}) {
  const exportButtons = [...document.querySelectorAll("[data-export]")]
  function extensionFor(format) {
    return format === "png" ? "png" : "psd"
  }

  const profileSelect = byId("export-profile")
  function activeProfile() {
    return resolveExportProfile(profileSelect?.value || loadGlobalExportProfileId())
  }
  function syncProfileSummary() {
    const summary = byId("export-profile-summary")
    if (!summary) return
    try {
      summary.textContent = describeExportProfile(activeProfile())
    } catch (error) {
      summary.textContent = error.message
    }
  }
  profileSelect?.addEventListener("change", syncProfileSummary)
  syncProfileSummary()

  // A composed page has to come back as an image before the profile can scale and cut it. The
  // message names the reason instead of failing on an undefined global.
  async function decodePageImage(blob) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("Trình duyệt này không giải mã được ảnh để chia mảnh theo hồ sơ.")
    }
    return createImageBitmap(blob)
  }

  async function exportProfileZip(pages, profile) {
    const { default: JSZip } = await import("jszip")
    const zip = new JSZip()
    const plans = []
    let order = 1
    for (const [index, page] of pages.entries()) {
      status(`Đang xuất trang ${index + 1}/${pages.length} theo hồ sơ ${profile.name}…`)
      const bitmap = await decodePageImage(await exportPage(page, "png"))
      try {
        const plan = planExportSlices(profile, {
          width: bitmap.width,
          height: bitmap.height,
          order,
          pageName: page.name,
        })
        const files = await renderExportSlices(bitmap, plan, {
          onSlice: ({ index: sliceIndex, total, fileName, width, height }) => {
            status(`Trang ${index + 1}/${pages.length} · mảnh ${sliceIndex}/${total}: ${fileName} (${width}×${height} px).`)
          },
        })
        for (const file of files) writeArchiveEntry(zip, file.name, file)
        plans.push({ pageName: page.name, plan })
        order += files.length
      } finally {
        bitmap.close?.()
      }
    }
    writeArchiveEntry(zip, exportManifestFileName, serializeExportManifest(exportManifest({ profile, plans })))
    saveFile(await zip.generateAsync({ type: "blob" }), `nixio-${profile.id}.zip`)
    return plans.reduce((total, { plan }) => total + plan.slices.length, 0)
  }

  async function performExport(action, summaryLabel) {
    if (state.exporting || state.openingProject) return
    state.exporting = true
    renderPages()
    try {
      const outcome = await action()
      if (outcome === false) return
      const label = typeof summaryLabel === "function" ? summaryLabel() : summaryLabel
      status("Đã tạo tệp xuất.")
      if (label) {
        notify?.({
          kind: "success",
          title: "Xuất tệp hoàn tất",
          message: label,
          key: "export-done",
        })
      }
    } catch (error) {
      status("Xuất thất bại. " + error.message, true)
      notify?.({
        kind: "error",
        title: "Xuất tệp thất bại",
        message: error.message,
        key: "export-done",
      })
    } finally {
      state.exporting = false
      renderPages()
    }
  }

  const preflightDialog = byId("preflight-dialog")
  let pendingExport
  // Everything an export needs that is not a linter finding: unplaced lines, translation jobs and
  // overflowing boxes. They carry no review state because the fix is an edit, not a decision.
  function collectPageIssues(pages) {
    const issues = []
    const settings = readTranslationSettings()
    const signature = translationSignature(settings)
    const context = document.createElement("canvas").getContext("2d")
    if (state.queue.length)
      issues.push({ text: `${state.queue.length} câu chưa đặt trong chương.` })
    for (const page of pages) {
      const prefix = page.name + " · "
      if (page.unplaced.length)
        issues.push({
          page,
          text: prefix + `${page.unplaced.length} câu chưa đặt.`,
        })
      if (page.translationJob?.state === "error")
        issues.push({
          page,
          text: prefix + "Lỗi dịch. " + page.translationJob.error,
        })
      if (page.translationJob?.state === "pending")
        issues.push({ page, text: prefix + "Chưa xử lý xong lượt dịch." })
      if (
        page.translationJob?.state === "done" &&
        page.translationJob.signature !== signature
      ) {
        issues.push({
          page,
          text: prefix + "Thiết lập dịch đã đổi sau lần xử lý gần nhất.",
        })
      }
      for (const box of page.boxes) {
        if (textOverflows(page, box, context))
          issues.push({
            page,
            box,
            text: prefix + "Chữ tràn khung · " + box.text.slice(0, 70),
          })
      }
    }
    return issues
  }

  function lintPages(pages) {
    const settings = readTranslationSettings()
    return lintChapter(pages, {
      glossaryText: settings.glossary ?? "",
      sourceLanguage: settings.source ?? "Japanese",
      targetLanguage: settings.target ?? "Vietnamese",
      maxIssues: 200,
    })
  }

  // --- QA triage board -------------------------------------------------------------------------
  // The board is the linter's output joined with the review decisions stored on the project. The
  // linter only runs when the box text can have changed; a decision re-renders the same run.
  const filters = { state: "all", severity: "all", page: "all", type: "all" }
  let boardLint = { total: 0, byType: {}, issues: [] }
  let board = buildQaBoard(boardLint)
  let boardPages = []
  let pageIssues = []

  function prepareBoard(pages) {
    commitLiveForm?.()
    const lint = lintPages(pages)
    // Re-running the linter is the only thing that expires a decision, and a capped run proves
    // nothing about the rows it did not list, so `reconcileQaReview` keeps them.
    qaReview?.reconcile?.(lint)
    return { lint, issues: collectPageIssues(pages), board: buildQaBoard(lint, qaReview?.review?.()) }
  }

  function preflightText() {
    if (pageIssues.length) return `Có ${pageIssues.length} mục cần kiểm tra ngoài QA.`
    if (board.counts.total) return "Không có lỗi trang, câu chưa đặt hay chữ tràn khung."
    return "Các trang đã sẵn sàng để xuất."
  }

  function paintBoard() {
    board = buildQaBoard(boardLint, qaReview?.review?.())
    renderFilters()
    renderRows()
    const continueButton = byId("continue-export")
    continueButton.hidden = !pendingExport
    continueButton.textContent = board.counts.blocking ? "Duyệt cảnh báo & xuất" : "Vẫn xuất"
  }

  function renderFilters() {
    const selects = [
      ["qa-filter-state", "state", "Mọi trạng thái", board.options.states],
      ["qa-filter-severity", "severity", "Mọi mức độ", board.options.severities],
      ["qa-filter-page", "page", "Mọi trang", board.options.pages],
      ["qa-filter-type", "type", "Mọi loại", board.options.types],
    ]
    for (const [id, key, allLabel, options] of selects) {
      const choices = [{ value: "all", label: allLabel }, ...options]
      const select = byId(id)
      select.replaceChildren(
        ...choices.map(({ value, label }) => {
          const option = document.createElement("option")
          option.value = String(value)
          option.textContent = label
          return option
        }),
      )
      // A filter whose value no longer exists in the chapter falls back to "all", so the board can
      // never be left showing nothing without a reason.
      if (!choices.some(({ value }) => String(value) === String(filters[key]))) filters[key] = "all"
      select.value = String(filters[key])
      select.onchange = () => {
        filters[key] = select.value
        renderRows()
      }
    }
  }

  function renderRows() {
    const visible = filterQaFindings(board.findings, filters)
    byId("preflight-summary").textContent = preflightText()
    byId("qa-summary").textContent = qaReviewSummary(board.counts, visible.length)
    byId("preflight-issues").replaceChildren(
      ...pageIssues.map(pageIssueRow),
      ...visible.map(qaFindingRow),
    )
  }

  function pageIssueRow(issue) {
    const li = document.createElement("li")
    li.append(
      listButton(issue.text, () => {
        preflightDialog.close()
        location.hash = "editor"
        if (issue.page) selectPage(issue.page)
        if (issue.box) selectBox(issue.box)
        if (!issue.page)
          byId("queue-section").scrollIntoView({ block: "nearest" })
        status(issue.text)
      }),
    )
    return li
  }

  function revealFinding(finding) {
    preflightDialog.close()
    location.hash = "editor"
    const page = boardPages[finding.pageIndex - 1]
    if (page) selectPage(page)
    const box = qaFindingBox(boardPages, finding)
    if (box) selectBox(box)
    status(finding.message)
  }

  function qaFindingRow(finding) {
    const row = document.createElement("li")
    row.className = "qa-finding"
    row.dataset.state = finding.state
    const severity = qaReviewSeverityLabels[finding.severity] ?? finding.severity
    row.append(
      listButton(
        `${finding.pageName ?? `Trang ${finding.pageIndex}`} · ${severity} — ${finding.message}`,
        () => revealFinding(finding),
      ),
    )
    const stateSelect = document.createElement("select")
    stateSelect.dataset.qaFinding = finding.id
    stateSelect.setAttribute("aria-label", `Trạng thái rà soát: ${finding.message}`)
    for (const state of qaReviewStates) {
      const option = document.createElement("option")
      option.value = state
      option.textContent = qaReviewStateLabels[state]
      stateSelect.append(option)
    }
    stateSelect.value = finding.state
    const noteInput = document.createElement("input")
    noteInput.type = "text"
    noteInput.value = finding.note
    noteInput.placeholder = "Lý do hoặc ghi chú…"
    noteInput.dataset.qaFinding = finding.id
    noteInput.setAttribute("aria-label", `Ghi chú rà soát: ${finding.message}`)
    const error = document.createElement("p")
    error.className = "qa-error"
    error.setAttribute("role", "alert")
    const save = () => {
      const result = qaReview?.set?.(finding.id, {
        state: stateSelect.value,
        note: noteInput.value,
        boxStamp: finding.boxStamp,
      })
      if (result?.error) {
        error.textContent = result.error
        return
      }
      error.textContent = ""
      row.dataset.state = stateSelect.value
      // A decision is project data like any other: without this the file never turns dirty, so
      // autosave and the close guard both skip it and the triage is lost.
      changed?.()
      // The board re-renders every row, so the control the user just used is put back under the
      // caret instead of dropping focus to the document.
      const tag = document.activeElement === stateSelect ? "select" : "input"
      paintBoard()
      const control = [...byId("preflight-issues").querySelectorAll(`[data-qa-finding="${finding.id}"]`)]
        .find((element) => element.tagName.toLowerCase() === tag)
      control?.focus()
    }
    stateSelect.onchange = save
    noteInput.onchange = save
    const controls = document.createElement("div")
    controls.className = "qa-finding-controls"
    controls.append(stateSelect, noteInput)
    if (finding.suggestion) {
      controls.append(
        listButton("Áp dụng & tiếp", () => applySuggestion(finding), `Áp dụng gợi ý: ${finding.message}`),
      )
    }
    row.append(controls, error)
    return row
  }

  function applySuggestion(finding) {
    if (projectBusy()) return status("Hãy chờ tác vụ hiện tại hoàn tất.", true)
    const box = qaFindingBox(boardPages, finding)
    if (!box || typeof finding.suggestion !== "string" || finding.suggestion === box.text) return
    commitLiveForm?.()
    checkpoint(undefined, { label: "Áp gợi ý QA", kind: "qa" })
    box.text = finding.suggestion
    qaReview?.set?.(finding.id, { state: "fixed", note: finding.note, boxStamp: finding.boxStamp })
    render()
    changed?.()
    // The box is fixed, so the next run no longer reports it: re-linting retires the row instead
    // of leaving a decision on screen for a finding that is gone.
    boardLint = lintPages(boardPages)
    qaReview?.reconcile?.(boardLint)
    paintBoard()
    status("Đã sửa khung và đánh dấu mục QA là đã xử lý.")
  }

  function showBoard(pages, prepared, action) {
    boardPages = pages
    pageIssues = prepared.issues
    boardLint = prepared.lint
    pendingExport = action ?? null
    paintBoard()
    preflightDialog.showModal()
  }

  function requestExport(pages, action) {
    if (projectBusy()) return
    const prepared = prepareBoard(pages)
    if (prepared.issues.length || prepared.board.blocking.length) showBoard(pages, prepared, action)
    else action()
  }
  byId("check-export").onclick = () => {
    showBoard(state.pages, prepareBoard(state.pages), null)
  }
  byId("close-preflight").onclick = () => preflightDialog.close()
  byId("continue-export").onclick = () => {
    const action = pendingExport
    // An export that goes ahead with open warnings records the decision on those rows, so the
    // override is a note on the board and not a dismissed dialog.
    let recorded = false
    for (const finding of qaBlockingFindings(board.findings)) {
      const result = qaReview?.set?.(finding.id, { state: "accepted", note: qaExportOverrideNote, boxStamp: finding.boxStamp })
      if (result && !result.error) recorded = true
    }
    // The override is project data: without this the file never turns dirty and the next autosave
    // skips the acceptances, so the next export blocks on warnings the user already approved.
    if (recorded) changed?.()
    preflightDialog.close()
    action?.()
  }
  preflightDialog.addEventListener("close", () => {
    pendingExport = null
  })

  for (const button of exportButtons) {
    button.onclick = () => {
      const page = selectedPage()
      const format = button.dataset.export
      if (!page) return
      requestExport([page], () =>
        performExport(async () => {
          status("Đang xuất trang…")
          const snapshot = copyEditor({ pages: [page] }).pages[0]
          saveFile(
            await exportPage(snapshot, format),
            filenameStem(page.name) + "." + extensionFor(format),
          )
        }),
      )
    }
  }

  const zipDialog = byId("zip-dialog")
  // The dialog snapshots its page list when it opens: the bulk bar's subset stays fixed even if
  // the selection changes while the user picks a format, and "Xuất tất cả" keeps meaning the whole
  // chapter at close time.
  let zipPages = null
  function openZipExport(pages = null) {
    zipPages = pages ? [...pages] : null
    byId("zip-name").value = ""
    byId("zip-dialog-title").textContent = pages?.length
      ? `Xuất ${pages.length} trang đã chọn`
      : "Xuất toàn bộ trang"
    zipDialog.returnValue = ""
    syncProfileSummary()
    zipDialog.showModal()
  }
  byId("export-all").onclick = () => openZipExport()
  zipDialog.addEventListener("close", () => {
    if (zipDialog.returnValue !== "export") {
      zipPages = null
      return
    }
    const format = byId("zip-format").value
    const pages = zipPages ?? state.pages
    zipPages = null
    const customName = byId("zip-name").value.trim()
    const zipName = `${customName ? filenameStem(customName) : "nixio"}-${format}.zip`
    let profile
    try {
      profile = activeProfile()
    } catch (error) {
      return status(error.message, true)
    }
    let sliceCount = 0
    const run = () =>
      performExport(
        async () => {
          const snapshot = copyEditor({ pages }).pages
          if (format === "profile") {
            sliceCount = await exportProfileZip(snapshot, profile)
            return
          }
          // The native path composites one fixed order, so a stack with a reordered or translucent
          // layer is exported by the renderer instead, exactly as the canvas shows it.
          if (format === "png" && isNativeReady() && snapshot.every(layersNativeFriendly)) {
            const transfer = await desktop.projectBegin(
              "zip",
              zipName,
            )
            if (!transfer) return false
            try {
              for (const [index, page] of snapshot.entries()) {
                status(`Đang xuất PNG bằng C# ${index + 1}/${snapshot.length}…`)
                const { options, data } = await nativePageLayers(page)
                const name =
                  String(index + 1).padStart(2, "0") +
                  "-" +
                  filenameStem(page.name) +
                  ".png"
                await desktop.projectWrite(
                  transfer.id,
                  "zipPage",
                  { ...options, name },
                  data,
                )
              }
              await desktop.projectWrite(transfer.id, "fileCommit")
            } catch (error) {
              await desktop
                .projectWrite(transfer.id, "fileCancel")
                .catch(() => {})
              throw error
            }
            return
          }
          const { default: JSZip } = await import("jszip")
          const zip = new JSZip()
          for (const [index, page] of snapshot.entries()) {
            status(`Đang xuất trang ${index + 1} / ${snapshot.length}…`)
            const name =
              String(index + 1).padStart(2, "0") + "-" + filenameStem(page.name)
            writeArchiveEntry(zip, name + "." + extensionFor(format), await exportPage(page, format))
          }
          saveFile(
            await zip.generateAsync({ type: "blob" }),
            zipName,
          )
        },
        () =>
          format === "profile"
            ? `Đã xuất ${sliceCount} mảnh theo hồ sơ ${profile.name}.`
            : `Đã xuất gói ZIP ${format.toUpperCase()} gồm ${pages.length} trang.`,
      )
    // The profile decides whether the preflight report runs before the archive is built.
    if (profile.preflight) requestExport(pages, run)
    else run()
  })

  const exportScriptBtn = byId("export-script")
  if (exportScriptBtn) {
    exportScriptBtn.onclick = () => {
      if (projectBusy() || !state.pages.length) return
      commitLiveForm?.()
      const format = byId("export-script-format").value
      const content = exportDialogueScript(state.pages, format)
      if (!content) return status("Chưa có lời thoại nào để xuất.", true)
      const mime =
        format === "json"
          ? "application/json;charset=utf-8"
          : format === "csv"
            ? "text/csv;charset=utf-8"
            : "text/plain;charset=utf-8"
      const stem = filenameStem(state.pages[0]?.name ?? "kich-ban")
      saveFile(new Blob([content], { type: mime }), `${stem}-kich-ban.${format}`)
      status(`Đã xuất kịch bản (${format.toUpperCase()}).`)
    }
  }

  return { openZipExport, syncProfileSummary }
}
