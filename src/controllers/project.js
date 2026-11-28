import { dateLocale, DEFAULT_LOCALE } from "../i18n.js"
import { readProject, writeProject, projectExtension } from "../project.js"
import { defaultLayers } from "../layers.js"
import { filenameStem, saveFile } from "../io.js"
import { loadGlobalPresets, mergePresets, saveGlobalPresets } from "../presets.js"
import {
  loadProjectTemplates,
  mergeTemplates,
  overwriteTemplate,
  parseProjectTemplatesJson,
  removeTemplate,
  renameTemplate,
  saveProjectTemplates,
  serializeProjectTemplatesJson,
  TEMPLATE_SETTING_IDS,
  templateByName,
  upsertTemplate,
} from "../templates.js"
import {
  desktop,
  nativeCapabilities,
  saveDesktopProject,
  openDesktopProject,
} from "../native.js"
import {
  clearWebSnapshot,
  listWebSnapshots,
  loadWebSnapshot,
  onWebSnapshotsChanged,
  saveWebSnapshot,
  webSnapshotAvailable,
  webStorageState,
} from "../web-storage.js"

export function setupProjects({
  state,
  byId,
  projectSettings,
  defaultProjectSettings,
  history,
  openImage,
  selectPage,
  selectedIndex,
  updateFitLabel,
  releaseUnusedImages,
  renderPages,
  render,
  checkpoint,
  status,
  projectBusy,
  hasGesture,
  onCapabilities,
  commitLiveForm,
  registerFontName,
  renderFontOptions,
  notify,
  onProjectSwitch,
  translationMemory,
  qaReview,
  locale = () => DEFAULT_LOCALE,
}) {
  const projectFile = byId("project-file")
  let projectName
  let nativeReady = false
  let revision = 0
  let savedRevision = 0
  // Which write produced `savedRevision`: a browser snapshot only proves
  // durability while its exact record is still in IndexedDB.
  let savedKind = null
  let savedWebId = null
  let downloadedRevision = -1
  let diskRevision = 0
  // Bumped whenever the editing session is replaced (open or new project) so a
  // write that finishes late can never mark the next session as saved.
  let generation = 0
  let lastSaveReminderAt = 0
  let lastSaveReminderRev = 0
  let notifiedWebRecovery = false
  state.projectId = crypto.randomUUID()
  let autosaving = false
  let manualSave = null
  let closing = false
  let webAutosaving = false
  let webRetryQueued = false
  let webStorageNote = ""
  let lastWebSnapshot = null
  const isCurrentSession = (snapshot) =>
    snapshot.projectId === state.projectId && snapshot.generation === generation
  // A download only hands the blob to the browser: the save dialog can still be
  // cancelled, so inside the desktop shell it never counts as a saved state.
  const downloadSaved = () => !desktop && revision === downloadedRevision
  const currentSaved = () =>
    revision === diskRevision ||
    downloadSaved() ||
    (savedKind !== null && revision === savedRevision)
  // The close decision cannot use `currentSaved()` alone: a browser record may
  // have been cleared by another tab, and a marker from an older page instance
  // must not cover this one.
  async function savedDurably() {
    if (revision === diskRevision) return true
    if (savedKind === null || revision !== savedRevision) return false
    if (savedKind !== "web") return true
    const marker = lastWebSnapshot
    if (!marker || marker.id !== savedWebId || !isCurrentSession(marker) || marker.revision !== revision) return false
    return await webSnapshotAvailable(marker.id, marker) &&
      lastWebSnapshot === marker && isCurrentSession(marker) && marker.revision === revision
  }
  function projectBlob() {
    const settings = Object.fromEntries(
      projectSettings.map(({ id, value }) => [id, value]),
    )
    return writeProject({
      projectId: state.projectId,
      pages: state.pages,
      presets: state.presets,
      queue: state.queue,
      settings,
      currentPage: selectedIndex(),
      fit: state.fit,
      templateId: state.templateId ?? undefined,
      // The font a template installed is part of the project, so a reopen keeps typesetting the
      // same way instead of falling back to Arial while still claiming the template.
      defaultFont: state.defaultFont,
      // The pairs travel with the project: a reopened file can reuse them without the provider.
      translationMemory: translationMemory?.snapshot?.(),
      styleGuide: state.styleGuide,
      // Same for the triage decisions: a reopened board shows what was reviewed, and the
      // linter's next run only expires what is really gone.
      qaReview: qaReview?.snapshot?.(),
    })
  }

  async function saveProjectFile() {
    if (projectBusy()) return false
    commitLiveForm?.()
    try {
      const file = projectBlob()
      const snapshotRevision = revision
      const name =
        projectName ?? filenameStem(state.pages[0]?.name ?? "nixio")
      if (nativeReady) {
        state.savingProject = true
        renderPages()
        if (
          !(await saveDesktopProject(
            file,
            "project",
            name + projectExtension,
            state.projectId,
          ))
        ) {
          status("Đã hủy lưu dự án.", true)
          return false
        }
        status("Đã lưu dự án vào máy.")
        diskRevision = snapshotRevision
        lastSaveReminderRev = snapshotRevision
        refreshDirty()
        // Recovery records of other tabs stay untouched: a manual save of this
        // session says nothing about a diverging snapshot elsewhere.
        await refreshWebRecovery()
        notify?.({
          kind: "success",
          title: "Đã lưu dự án",
          message: `${name}${projectExtension} đã được lưu an toàn.`,
          key: "project-save",
        })
        return true
      }
      saveFile(file, name + projectExtension)
      status("Đã tạo tệp dự án.")
      downloadedRevision = snapshotRevision
      lastSaveReminderRev = snapshotRevision
      refreshDirty()
      notify?.({
        kind: "success",
        title: "Đã tạo tệp dự án",
        message: `Đã tạo ${name}${projectExtension} để tải xuống. Bản tự lưu trên trình duyệt vẫn được giữ để phục hồi.`,
        key: "project-save",
      })
      return true
    } catch (error) {
      status("Không lưu được dự án. " + error.message, true)
      return false
    } finally {
      state.savingProject = false
      renderPages()
    }
  }

  byId("save-project").onclick = () => {
    if (manualSave) return manualSave
    manualSave = saveProjectFile().finally(() => {
      manualSave = null
    })
    return manualSave
  }

  byId("open-project").onclick = () => {
    if (projectBusy()) return
    if (nativeReady) openNativeProject("dialog")
    else projectFile.click()
  }

  projectFile.onchange = async () => {
    const file = projectFile.files[0]
    projectFile.value = ""
    await loadProject(file)
  }

  async function loadProject(file) {
    if (!file || projectBusy()) return
    const loaded = []
    state.openingProject = true
    renderPages()
    status("Đang mở dự án…")
    try {
      const project = await readProject(file)
      for (const field of projectSettings) {
        if (
          field.options &&
          ![...field.options].some(
            ({ value }) => value === project.settings[field.id],
          )
        ) {
          throw new Error("Tệp dự án chứa thiết lập chưa được hỗ trợ.")
        }
      }
      for (const saved of project.pages) {
        let page
        try {
          page = await openImage(saved.file)
        } catch {
          throw new Error("Không đọc được ảnh trong dự án: " + saved.file.name)
        }
        page.boxes = saved.boxes.map((box) => {
          registerFontName?.(box.font)
          return {
            ...box,
            id: crypto.randomUUID(),
          }
        })
        page.unplaced = saved.unplaced
        page.retouchStrokes = saved.retouchStrokes ?? []
        // A project saved before layers opens as the implicit stack: one layer per effect.
        page.layers = saved.layers ?? defaultLayers()
        page.translationContext = saved.translationContext
        page.translationJob = saved.translationJob
        loaded.push(page)
      }
      for (const preset of project.presets) registerFontName?.(preset.style.font)
      renderFontOptions?.()
      const hasContent =
        state.pages.length ||
        revision !== diskRevision ||
        state.queue.length ||
        state.styleGuide ||
        state.templateId ||
        // Pairs and triage decisions outlive their pages: deleting every page still leaves data
        // that replacing the session would throw away, so they count as content too.
        qaReview?.size ||
        translationMemory?.size ||
        projectSettings.some(
          ({ value }, index) => value !== defaultProjectSettings[index],
        )
      if (
        hasContent &&
        !window.confirm(
          "Mở dự án này sẽ thay thế phiên biên tập hiện tại. Tiếp tục?",
        )
      ) {
        status("Đã hủy mở dự án.")
        return
      }
      const projectId =
        project.projectId ?? file.projectId ?? crypto.randomUUID()
      if (nativeReady)
        await desktop.projectActivate(projectId, file.nativeOpenId)
      commitLiveForm?.()
      generation++
      lastWebSnapshot = null
      savedKind = null
      savedWebId = null
      downloadedRevision = -1
      revision++
      history.clear()
      state.projectId = projectId
      diskRevision = file.recovery ? -1 : revision
      savedRevision = -1
      state.pages = loaded
      state.queue = project.queue
      state.presets = mergePresets(loadGlobalPresets(), project.presets)
      state.fit = project.fit
      state.templateId = project.templateId ?? null
      state.defaultFont = project.defaultFont ?? "Arial"
      // A file that predates the memory carries no pairs, so the store is replaced with whatever
      // this project has: never with the previous project's pairs. The triage decisions follow the
      // same rule.
      translationMemory?.replace?.(project.translationMemory)
      state.styleGuide = project.styleGuide ?? null
      qaReview?.replace?.(project.qaReview)
      state.zoom = null
      state.selectedBoxIds?.clear()
      updateFitLabel()
      projectSettings.forEach((field) => {
        field.value = project.settings[field.id]
      })
      // A restored snapshot is named after its timestamp, so the title the shell read from the
      // catalogue wins over the file name; autosave would otherwise rename the project to a UUID.
      projectName = file.projectTitle || filenameStem(file.name)
      selectPage(loaded[project.currentPage])
      onProjectSwitch?.()
      status(`Đã mở dự án với ${loaded.length} trang.`)
    } catch (error) {
      status("Không mở được dự án. " + error.message, true)
    } finally {
      if (file.nativeOpenId) await desktop.projectDiscardOpen(file.nativeOpenId)
      releaseUnusedImages()
      state.openingProject = false
      renderPages()
    }
  }

  async function openNativeProject(mode) {
    if (projectBusy()) return status("Hãy chờ tác vụ hiện tại hoàn tất.", true)
    state.openingProject = true
    renderPages()
    let file
    try {
      file = await openDesktopProject(mode)
    } catch (error) {
      status("Không mở được dự án. " + error.message, true)
    } finally {
      state.openingProject = false
      renderPages()
    }
    if (file) await loadProject(file)
  }
  byId("recover-project").onclick = async () => {
    const info = await desktop.projectStatus()
    if (info.projects) showLibrary()
    else openNativeProject("recovery")
  }
  byId("recover-backup").onclick = () => openNativeProject("backup")

  function displayName() {
    return projectName ?? filenameStem(state.pages[0]?.name ?? "Dự án mới")
  }

  function refreshDirty() {
    // The label tracks the file the user asked for, not the autosave: a browser
    // snapshot never turns it into "saved", and a download only does outside the
    // desktop shell where no save dialog can cancel it.
    byId("project-dirty").textContent =
      displayName() +
      " · " +
      (revision === diskRevision || downloadSaved()
        ? "Đã lưu"
        : "Còn thay đổi chưa lưu")
  }

  async function showLibrary() {
    if (projectBusy()) return status("Hãy chờ tác vụ hiện tại hoàn tất.", true)
    try {
      const projects = await desktop.projectList()
      const busy = projectBusy()
      const busyReason = "Đang có tác vụ chạy; hãy chờ hoàn tất trước khi mở hoặc khôi phục."
      const busyNote = byId("project-library-busy")
      busyNote.textContent = busy ? busyReason : ""
      busyNote.hidden = !busy
      const destination = byId("recent-projects")
      destination.replaceChildren()
      for (const project of projects) {
        const section = document.createElement("section")
        const heading = document.createElement("h3")
        heading.textContent = project.title
        section.append(heading)
        if (project.saved) {
          const open = document.createElement("button")
          open.className = "button"
          open.textContent = "Mở tệp đã lưu"
          open.disabled = busy
          if (busy) open.title = busyReason
          open.onclick = () => {
            byId("project-library").close()
            openNativeProject({ projectId: project.id })
          }
          section.append(open)
        }
        for (const snapshot of project.snapshots) {
          const restore = document.createElement("button")
          restore.className = "button"
          restore.disabled = busy
          if (busy) restore.title = busyReason
          restore.textContent =
            "Khôi phục " + new Date(snapshot.updatedAt).toLocaleString(dateLocale(locale()))
          // The label is a locale time, which is ambiguous within a second; the id names the exact
          // revision the button opens, for the recovery smoke test and for assistive tooling.
          restore.dataset.snapshotId = snapshot.id
          restore.onclick = () => {
            byId("project-library").close()
            openNativeProject({
              projectId: project.id,
              snapshotId: snapshot.id,
            })
          }
          section.append(restore)
        }
        destination.append(section)
      }
      const legacy = await desktop.projectStatus()
      const legacyButton = byId("legacy-recovery")
      legacyButton.hidden = !legacy.recovery
      legacyButton.disabled = busy
      legacyButton.title = busy ? busyReason : ""
      byId("project-library-empty").hidden =
        Boolean(projects.length) || legacy.recovery
      byId("project-library").showModal()
    } catch (error) {
      status(error.message, true)
    }
  }
  byId("legacy-recovery").onclick = () => {
    byId("project-library").close()
    openNativeProject("recovery")
  }
  byId("recent-projects-button").onclick = showLibrary

  let projectTemplates = loadProjectTemplates()

  function currentTemplateDraft(name) {
    const settings = {}
    for (const field of projectSettings) {
      if (TEMPLATE_SETTING_IDS.includes(field.id)) settings[field.id] = field.value
    }
    const format = byId("zip-format")?.value
    return {
      name,
      settings,
      presets: state.presets,
      fit: state.fit,
      font: state.defaultFont,
      ...(format ? { exportProfile: { format } } : {}),
    }
  }

  // A template only rewrites settings, presets, view defaults and the export
  // pick: pages, their files and the queue stay exactly as they are, and the
  // whole change lands as one named history entry.
  function applyTemplate(template) {
    if (!template || projectBusy() || hasGesture?.()) return false
    commitLiveForm?.()
    if (checkpoint) checkpoint(undefined, { label: `Áp dụng mẫu dự án "${template.name}"`, kind: "template" })
    for (const field of projectSettings) {
      const value = template.settings?.[field.id]
      if (value === undefined) continue
      if (field.options && ![...field.options].some((option) => option.value === value)) continue
      field.value = value
    }
    if (template.presets?.length) {
      state.presets = saveGlobalPresets(mergePresets(state.presets, template.presets))
      for (const preset of template.presets) registerFontName?.(preset.style.font)
    }
    if (typeof template.fit === "boolean") {
      state.fit = template.fit
      updateFitLabel?.()
    }
    if (template.font) {
      state.defaultFont = template.font
      registerFontName?.(template.font)
    }
    const zipFormat = byId("zip-format")
    const format = template.exportProfile?.format
    if (
      format && zipFormat &&
      (!zipFormat.options || [...zipFormat.options].some((option) => option.value === format))
    ) {
      zipFormat.value = format
    }
    state.templateId = template.id ?? null
    ;(render ?? renderPages)?.()
    onProjectSwitch?.()
    status(`Đã áp dụng mẫu dự án "${template.name}".`)
    return true
  }

  async function startNewProject(template = null) {
    if (projectBusy()) return
    commitLiveForm?.()
    if (
      (state.pages.length || revision !== diskRevision) &&
      !window.confirm("Tạo dự án mới và thay phiên hiện tại?")
    )
      return
    history.clear()
    state.pages = []
    state.queue = []
    state.presets = loadGlobalPresets()
    state.zoom = null
    state.selectedBoxIds?.clear()
    state.projectId = crypto.randomUUID()
    projectName = undefined
    translationMemory?.clear?.()
    state.styleGuide = null
    qaReview?.clear?.()
    state.templateId = null
    state.defaultFont = "Arial"
    generation++
    lastWebSnapshot = null
    savedKind = null
    savedWebId = null
    downloadedRevision = -1
    revision = savedRevision = diskRevision = 0
    projectSettings.forEach((field, index) => {
      field.value = defaultProjectSettings[index]
    })
    if (nativeReady) await desktop.projectActivate(state.projectId)
    selectPage()
    releaseUnusedImages()
    refreshDirty()
    onProjectSwitch?.()
    if (template) applyTemplate(template)
  }
  byId("new-project").onclick = () => startNewProject()

  const templateDialog = byId("template-dialog")
  const templateSelect = byId("template-select")
  const templateNameInput = byId("template-name")

  function selectedTemplate() {
    return templateByName(projectTemplates, templateSelect.value) ?? null
  }

  function syncTemplateNameField() {
    const template = selectedTemplate()
    if (templateNameInput) templateNameInput.value = template?.name ?? ""
    const locked = Boolean(template?.builtin) || projectBusy()
    for (const id of ["rename-template", "overwrite-template", "delete-template"]) {
      const button = byId(id)
      if (button) button.disabled = locked
    }
    const save = byId("save-template")
    if (save) save.disabled = projectBusy()
  }

  function refreshTemplateDialog() {
    const selected = templateSelect.value
    templateSelect.replaceChildren(
      ...projectTemplates.map((template) =>
        new Option(template.name + (template.builtin ? " · dựng sẵn" : ""), template.name)),
    )
    templateSelect.value = projectTemplates.some((template) => template.name === selected)
      ? selected
      : projectTemplates[0]?.name ?? ""
    syncTemplateNameField()
  }

  byId("open-templates").onclick = () => {
    refreshTemplateDialog()
    templateDialog.showModal()
  }
  if (templateSelect) templateSelect.onchange = syncTemplateNameField

  byId("apply-template").onclick = () => {
    const template = selectedTemplate()
    if (!template) return status("Hãy chọn một mẫu dự án.", true)
    applyTemplate(template)
  }
  byId("new-project-template").onclick = () => {
    const template = selectedTemplate()
    if (!template) return status("Hãy chọn một mẫu dự án.", true)
    templateDialog.close()
    startNewProject(template)
  }

  function persistTemplates(next, selectName) {
    projectTemplates = saveProjectTemplates(next)
    refreshTemplateDialog()
    if (projectTemplates.some((item) => item.name === selectName)) {
      templateSelect.value = selectName
    }
    return projectTemplates
  }

  byId("save-template").onclick = () => {
    if (projectBusy()) return status("Hãy chờ tác vụ hiện tại hoàn tất.", true)
    const name = templateNameInput?.value.trim() ?? ""
    if (!name) return status("Nhập tên cho mẫu dự án.", true)
    try {
      persistTemplates(upsertTemplate(projectTemplates, currentTemplateDraft(name)), name)
      status(`Đã lưu mẫu dự án "${name}".`)
    } catch (error) {
      status(error.message, true)
    }
  }

  byId("rename-template").onclick = () => {
    if (projectBusy()) return
    try {
      persistTemplates(renameTemplate(projectTemplates, templateSelect.value, templateNameInput?.value ?? ""), templateNameInput?.value.trim())
      status("Đã đổi tên mẫu dự án.")
    } catch (error) {
      status(error.message, true)
    }
  }

  byId("overwrite-template").onclick = () => {
    if (projectBusy()) return
    const name = templateSelect.value
    try {
      persistTemplates(overwriteTemplate(projectTemplates, name, currentTemplateDraft(name)), name)
      status(`Đã ghi đè mẫu dự án "${name}".`)
    } catch (error) {
      status(error.message, true)
    }
  }

  byId("delete-template").onclick = () => {
    if (projectBusy()) return
    const name = templateSelect.value
    if (!window.confirm(`Xóa mẫu dự án "${name}"?`)) return
    try {
      persistTemplates(removeTemplate(projectTemplates, name))
      status(`Đã xóa mẫu dự án "${name}".`)
    } catch (error) {
      status(error.message, true)
    }
  }

  byId("export-templates").onclick = () => {
    const json = serializeProjectTemplatesJson(projectTemplates)
    saveFile(new Blob([json], { type: "application/json;charset=utf-8" }), "nixio-templates.json")
    status("Đã xuất danh sách mẫu dự án ra tệp JSON.")
  }

  byId("import-templates").onclick = () => {
    if (!projectBusy()) byId("templates-file")?.click()
  }
  byId("templates-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || projectBusy()) return
    try {
      const imported = parseProjectTemplatesJson(await file.text())
      projectTemplates = saveProjectTemplates(mergeTemplates(projectTemplates, imported))
      refreshTemplateDialog()
      status(`Đã nhập ${imported.length} mẫu dự án (tổng ${projectTemplates.filter((item) => !item.builtin).length} mẫu của bạn).`)
    } catch (error) {
      status("Không nhập được tệp mẫu dự án. " + error.message, true)
    }
  })

  async function refreshRecovery() {
    const info = await desktop.projectStatus()
    byId("recover-project").hidden = !info.recovery && !info.projects
    byId("recover-backup").hidden = !info.backup
  }

  async function autosave() {
    if (
      !nativeReady ||
      autosaving ||
      projectBusy() ||
      hasGesture() ||
      currentSaved()
    )
      return false
    autosaving = true
    const snapshot = { revision, projectId: state.projectId, generation }
    try {
      const saved = await saveDesktopProject(
        projectBlob(),
        "autosave",
        displayName() + projectExtension,
        state.projectId,
      )
      if (!saved) return false
      // A different project or a reloaded session must not inherit this marker.
      if (!isCurrentSession(snapshot)) {
        await refreshRecovery()
        return false
      }
      savedRevision = snapshot.revision
      savedKind = "native"
      savedWebId = null
      byId("autosave-status").textContent =
        "Đã tự lưu lúc " + new Date().toLocaleTimeString(dateLocale(locale()))
      await refreshRecovery()
      return true
    } catch (error) {
      byId("autosave-status").textContent = "Tự lưu thất bại. " + error.message
      return false
    } finally {
      autosaving = false
    }
  }
  if (desktop?.native) {
    byId("local-processing").hidden = false
    // Nixio #107: the line changes once the worker answers, so it is a live region; an OCR error
    // becomes an alert because the reader must hear it without moving focus back here.
    const setNativeStatus = (text, error = false) => {
      const element = byId("native-status")
      element.setAttribute("role", error ? "alert" : "status")
      element.setAttribute("aria-live", error ? "assertive" : "polite")
      element.textContent = text
    }
    setNativeStatus("Đang kiểm tra worker C#…")
    nativeCapabilities()
      .then(async (capabilities) => {
        nativeReady = Boolean(capabilities)
        const nativeLanguages = capabilities?.languages ?? []
        onCapabilities(nativeReady, nativeLanguages)
        setNativeStatus(
          capabilities
            ? (capabilities.ocrError ?? "OCR cục bộ sẵn sàng.")
            : "Chạy npm run desktop:native để bật xử lý C#.",
          Boolean(capabilities?.ocrError),
        )
        byId("local-ocr-language").replaceChildren(
          ...nativeLanguages.map((language) => new Option(language, language)),
        )
        byId("native-mask-control").hidden = !nativeReady
        byId("desktop-recovery").hidden = !nativeReady
        if (nativeReady) {
          // The C# worker owns autosave again, so a stale browser note is noise.
          webStorageNote = ""
          await desktop.projectActivate(state.projectId)
          await refreshRecovery()
          byId("autosave-status").textContent =
            "Tự lưu mỗi 20 giây và khi đóng app."
        }
        await refreshWebRecovery()
        renderPages()
      })
      .catch((error) => status(error.message, true))
  }

  function webStorageMessage(reason) {
    if (reason === "blocked")
      return "Tab khác đang giữ kho lưu trên trình duyệt. Đóng tab đó rồi thử lại."
    if (reason === "unsupported") return "Trình duyệt này không lưu được bản tạm."
    if (reason === "unavailable") return "Không mở được kho lưu trên trình duyệt."
    if (reason === "project-capacity")
      return "Dự án này đã có 3 bản tự lưu trên trình duyệt. Bỏ bớt một bản trong danh sách bản tự lưu rồi lưu lại."
    if (reason === "capacity")
      return "Kho lưu trên trình duyệt đã đầy 8 bản. Bỏ bớt một bản trong danh sách bản tự lưu rồi lưu lại."
    return "Không ghi được bản tạm trên trình duyệt."
  }

  function snapshotLabel(snapshot) {
    return [
      snapshot.name,
      `${snapshot.pageCount} trang`,
      new Date(snapshot.savedAt).toLocaleString(dateLocale(locale())),
      snapshot.legacy ? "bản cũ" : null,
      snapshot.mine ? null : "phiên khác",
    ]
      .filter(Boolean)
      .join(" · ")
  }

  const webSnapshotDue = () =>
    !(
      lastWebSnapshot &&
      lastWebSnapshot.projectId === state.projectId &&
      lastWebSnapshot.generation === generation &&
      lastWebSnapshot.revision === revision
    )

  async function refreshWebRecovery() {
    const statusLine = byId("web-autosave-status")
    if (!statusLine) return
    const snapshots = await listWebSnapshots()
    const storage = webStorageState()
    const hint = webStorageNote || (storage.blocked ? webStorageMessage("blocked") : "")
    const panel = byId("web-recovery")
    if (panel) panel.hidden = !snapshots.length && !hint
    const actions = byId("web-recovery-actions")
    if (actions) actions.hidden = !snapshots.length
    const select = byId("web-recovery-select")
    if (select) {
      const previous = typeof select.value === "string" ? select.value : ""
      select.replaceChildren(
        ...snapshots.map((snapshot) => new Option(snapshotLabel(snapshot), snapshot.id)),
      )
      const keep = snapshots.some((snapshot) => snapshot.id === previous)
        ? previous
        : (snapshots[0]?.id ?? "")
      select.value = keep
    }
    const recover = byId("recover-web")
    if (recover) recover.disabled = !snapshots.length
    const clear = byId("clear-web-recovery")
    if (clear) clear.disabled = !snapshots.length
    if (hint) {
      statusLine.textContent = hint
      return
    }
    if (!snapshots.length) {
      statusLine.textContent = ""
      return
    }
    const newest = snapshots[0]
    const time = new Date(newest.savedAt).toLocaleTimeString(dateLocale(locale()))
    statusLine.textContent =
      snapshots.length === 1
        ? `Bản tự lưu trên trình duyệt (${newest.pageCount} trang) lúc ${time}.`
        : `Có ${snapshots.length} bản tự lưu trên trình duyệt; mới nhất ${time}.`
    if (!notifiedWebRecovery && !state.pages.length) {
      notifiedWebRecovery = true
      notify?.({
        kind: "info",
        title: "Có bản tự lưu trên trình duyệt",
        message: `Tìm thấy ${snapshots.length} bản tự lưu; mới nhất ${newest.pageCount} trang lúc ${time}.`,
        key: "web-recovery",
        silentToast: true,
        actions: [
          {
            label: "Khôi phục",
            primary: true,
            onClick: () => byId("recover-web")?.click(),
          },
        ],
      })
    }
  }

  function flushQueuedWebAutosave() {
    if (!webRetryQueued) return
    webRetryQueued = false
    setTimeout(() => {
      webAutosave()
    }, 0)
  }

  function queueWebAutosave() {
    webRetryQueued = true
    // A running write owns the flag until its own finally, otherwise the retry
    // would be skipped and the new generation would wait for the next timer.
    if (!webAutosaving) flushQueuedWebAutosave()
  }

  async function webAutosave({ fallback = false } = {}) {
    if (nativeReady && !fallback) return false
    if (
      webAutosaving ||
      projectBusy() ||
      hasGesture() ||
      (!state.pages.length && !fallback) ||
      !webSnapshotDue()
    )
      return false
    return Boolean(await writeWebSnapshot())
  }

  // Writes the form state that is on screen right now and only claims the
  // revision that was actually written.
  async function writeWebSnapshot() {
    if (webAutosaving) return null
    webAutosaving = true
    const snapshot = { revision, projectId: state.projectId, generation }
    try {
      const result = await saveWebSnapshot(projectBlob(), {
        name: displayName() + projectExtension,
        pageCount: state.pages.length,
        projectId: snapshot.projectId,
        revision: snapshot.revision,
        generation: snapshot.generation,
      })
      if (!result.ok) {
        webStorageNote = webStorageMessage(result.reason)
        await refreshWebRecovery()
        return null
      }
      webStorageNote = ""
      if (!isCurrentSession(snapshot)) {
        // The session changed during the write. Keep the snapshot visible, but do
        // not mark the new generation as saved and save it right away instead of
        // waiting for the next timer or a pagehide that may never come.
        await refreshWebRecovery()
        queueWebAutosave()
        return null
      }
      lastWebSnapshot = { ...snapshot, id: result.id }
      savedRevision = snapshot.revision
      savedKind = "web"
      savedWebId = result.id
      await refreshWebRecovery()
      return result
    } catch {
      webStorageNote = webStorageMessage("error")
      await refreshWebRecovery()
      return null
    } finally {
      webAutosaving = false
      flushQueuedWebAutosave()
    }
  }

  // Another tab may clear or replace the record this session counted as saved.
  // The notification is best effort, so the marker is re-checked against the
  // store rather than taken at face value.
  async function refreshSavedMarker() {
    if (savedKind !== "web" || !savedWebId) return
    const marker = lastWebSnapshot
    if (!marker || marker.id !== savedWebId) return
    const available = await webSnapshotAvailable(marker.id, marker)
    if (available || lastWebSnapshot !== marker) return
    savedKind = null
    savedWebId = null
    lastWebSnapshot = null
    refreshDirty()
  }

  refreshWebRecovery()
  onWebSnapshotsChanged(() => {
    refreshWebRecovery()
    refreshSavedMarker()
  })
  const heartbeat = setInterval(() => {
    autosave()
    webAutosave()
  }, 20000)
  // Keep the timer from holding a non-browser host (tests, tooling) open.
  heartbeat?.unref?.()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") webAutosave()
    else {
      refreshWebRecovery()
      refreshSavedMarker()
    }
  })
  window.addEventListener("pagehide", () => {
    webAutosave()
  })

  const recoverWebBtn = byId("recover-web")
  if (recoverWebBtn) {
    recoverWebBtn.onclick = async () => {
      if (projectBusy()) return
      const file = await loadWebSnapshot(byId("web-recovery-select")?.value || undefined)
      if (!file) return status("Không còn bản lưu tạm trên trình duyệt.", true)
      await loadProject(file)
    }
  }
  const clearWebBtn = byId("clear-web-recovery")
  if (clearWebBtn) {
    clearWebBtn.onclick = async () => {
      const id = byId("web-recovery-select")?.value
      if (!id) return
      const cleared = await clearWebSnapshot(id)
      // The deleted snapshot is no longer durable, so the next flush has to write
      // a fresh one instead of trusting the old marker.
      lastWebSnapshot = null
      if (savedKind === "web") {
        savedKind = null
        savedWebId = null
      }
      await refreshWebRecovery()
      refreshDirty()
      status(
        cleared
          ? "Đã xóa bản tự lưu trên trình duyệt."
          : "Không xóa được bản tự lưu trên trình duyệt.",
        !cleared,
      )
    }
  }

  const waitForWrites = async (timeout = 5000) => {
    const deadline = Date.now() + timeout
    const pending = () => autosaving || webAutosaving || Boolean(manualSave)
    while (pending() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    return !pending()
  }

  async function flushForClose() {
    // The script text area and the setting fields are only copied into `state`
    // here; without this the close could store an older draft than the screen.
    commitLiveForm?.()
    await waitForWrites()
    // A manual save still running after the bounded wait must not be awaited
    // again: the decision moves on to the explicit discard question instead of
    // hanging on the worker.
    if (await savedDurably()) return "saved"
    if (manualSave) return "unsaved"
    if (projectBusy()) return "busy"
    if (nativeReady && (await autosave()) && (await savedDurably())) return "saved"
    // Native autosave is unavailable, pending or failed: keep a durable browser
    // snapshot so closing the window cannot silently drop the edits.
    if (await flushWebForClose()) return "saved"
    return (await savedDurably()) ? "saved" : "unsaved"
  }

  // Writes the state that is on screen and refuses to report success until that
  // exact revision is readable in the store. Edits that land during the write are
  // flushed again instead of being covered by the older snapshot.
  async function flushWebForClose() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (webAutosaving) {
        await waitForWrites(2000)
        if (webAutosaving) return false
      }
      commitLiveForm?.()
      if (projectBusy() || hasGesture()) return false
      if (!(await writeWebSnapshot())) return false
      if (await savedDurably()) return true
    }
    return false
  }

  async function requestClose() {
    if (closing) return
    closing = true
    try {
      const outcome = await flushForClose()
      if (outcome === "busy") {
        status("Hãy chờ tác vụ hiện tại hoàn tất trước khi đóng app.", true)
        closing = false
        return
      }
      if (
        (outcome !== "saved" || !currentSaved()) &&
        !window.confirm(
          "Chưa lưu được thay đổi vào máy hay trình duyệt. Vẫn đóng app và bỏ các thay đổi chưa lưu?",
        )
      ) {
        status("Đã hủy đóng app; các thay đổi vẫn còn trên màn hình.")
        closing = false
        return
      }
      await desktop.closeWindow()
    } catch (error) {
      closing = false
      status("Không đóng được app. " + error.message, true)
    }
  }

  desktop?.onClose?.(() => {
    requestClose()
  })

  return {
    changed() {
      revision++
      refreshDirty()
      const unsavedEdits = revision - diskRevision
      const sinceLast = revision - lastSaveReminderRev
      const now = Date.now()
      if (
        state.pages.length &&
        unsavedEdits >= 15 &&
        sinceLast >= 15 &&
        now - lastSaveReminderAt >= 3 * 60 * 1000
      ) {
        lastSaveReminderAt = now
        lastSaveReminderRev = revision
        notify?.({
          kind: "info",
          title: "Nhắc lưu dự án",
          message: `Bạn có ${unsavedEdits} thay đổi chưa lưu ra tệp ${projectExtension}.`,
          key: "unsaved-reminder",
          actions: [
            { label: "Lưu dự án", primary: true, onClick: () => byId("save-project")?.click() },
          ],
        })
      }
    },
    refreshDirty,
    get ready() {
      return nativeReady
    },
  }
}
