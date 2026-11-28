// The chat's model bar: provider, model, reasoning effort and saved custom endpoints.
//
// The sidebar translation fields stay the single source of truth for the provider settings. This bar
// only writes into them and fires their existing `change` handlers, so the scope binding, the stored
// config and the key status all update through the code paths the sidebar already uses.

import {
  buildLlmProfile,
  chatEffortStorageKey,
  llmProfilesStorageKey,
  matchLlmProfile,
  reasoningEfforts,
  sanitizeEffort,
  sanitizeLlmProfiles,
} from "../llm-profiles.js"

const manualOption = "manual"
const profilePrefix = "profile:"

export function setupModelBar({ byId, t, onSettingsChange, storage = globalThis.localStorage }) {
  let profiles = readProfiles()
  let editingId = null
  let optionSignature = ""

  const providerSelect = byId("chat-provider")
  const geminiModelSelect = byId("chat-model-gemini")
  const llmModelInput = byId("chat-model-llm")
  const effortSelect = byId("chat-effort")
  const form = byId("chat-profile-form")

  // Copy the Gemini model list once: the sidebar select owns the options, the bar only mirrors them.
  geminiModelSelect.replaceChildren(...Array.from(byId("gemini-model").options, (option) => option.cloneNode(true)))

  effortSelect.replaceChildren(...reasoningEfforts.map((value) => {
    const option = document.createElement("option")
    option.value = value
    option.textContent = t(value ? `model.effort.${value}` : "model.effort.default")
    return option
  }))
  effortSelect.value = sanitizeEffort(readStorage(chatEffortStorageKey))

  function readStorage(key) {
    try {
      return storage?.getItem(key) ?? ""
    } catch {
      return ""
    }
  }

  function readProfiles() {
    try {
      return sanitizeLlmProfiles(JSON.parse(readStorage(llmProfilesStorageKey) || "[]"))
    } catch {
      return []
    }
  }

  function writeProfiles() {
    try {
      storage?.setItem(llmProfilesStorageKey, JSON.stringify(profiles))
    } catch {
      // A browser with storage disabled keeps the profiles for this session only.
    }
  }

  function currentSettings() {
    return {
      provider: byId("translation-provider").value === "openai" ? "openai" : "gemini",
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
      geminiModel: byId("gemini-model").value,
    }
  }

  // A sidebar field changed through script: dispatching `change` runs the handler the user would trigger.
  function commit(id, value) {
    const element = byId(id)
    if (element.value === value) return
    element.value = value
    element.dispatchEvent(new Event("change"))
  }

  function applyTarget({ provider, baseUrl, model }) {
    commit("translation-provider", provider)
    if (provider !== "openai") return
    commit("llm-base-url", baseUrl)
    commit("llm-model", model)
  }

  function rebuildProviderOptions(current) {
    const signature = JSON.stringify(profiles.map((profile) => [profile.id, profile.name]))
    const matched = current.provider === "openai" ? matchLlmProfile(profiles, current) : null
    const showManual = current.provider === "openai" && !matched
    const key = signature + (showManual ? "|manual" : "")
    if (key === optionSignature) return
    optionSignature = key
    const options = [new Option(t("model.provider.gemini"), "gemini")]
    for (const profile of profiles) options.push(new Option(profile.name, profilePrefix + profile.id))
    if (showManual) options.push(new Option(t("model.provider.manual"), manualOption))
    providerSelect.replaceChildren(...options)
  }

  // Keeps the bar in step with the sidebar. Called after every settings change, from either side.
  function refresh() {
    const current = currentSettings()
    rebuildProviderOptions(current)
    const matched = current.provider === "openai" ? matchLlmProfile(profiles, current) : null
    providerSelect.value = current.provider === "gemini"
      ? "gemini"
      : matched ? profilePrefix + matched.id : manualOption
    const isGemini = current.provider === "gemini"
    geminiModelSelect.hidden = !isGemini
    llmModelInput.hidden = isGemini
    if (isGemini) geminiModelSelect.value = current.geminiModel
    else if (document.activeElement !== llmModelInput) llmModelInput.value = current.llmModel
    byId("chat-profile-edit").hidden = !matched
    effortSelect.value = sanitizeEffort(readStorage(chatEffortStorageKey))
  }

  function profileById(id) {
    return profiles.find((profile) => profile.id === id) ?? null
  }

  providerSelect.onchange = () => {
    const value = providerSelect.value
    if (value === "gemini") applyTarget({ provider: "gemini" })
    else if (value.startsWith(profilePrefix)) {
      const profile = profileById(value.slice(profilePrefix.length))
      if (profile) applyTarget({ provider: "openai", baseUrl: profile.baseUrl, model: profile.model })
    }
    onSettingsChange?.()
    refresh()
  }

  geminiModelSelect.onchange = () => {
    commit("gemini-model", geminiModelSelect.value)
    onSettingsChange?.()
  }

  llmModelInput.onchange = () => {
    const model = llmModelInput.value.trim()
    if (!model) {
      refresh()
      return
    }
    commit("llm-model", model)
    onSettingsChange?.()
    refresh()
  }

  effortSelect.onchange = () => {
    try {
      storage?.setItem(chatEffortStorageKey, sanitizeEffort(effortSelect.value))
    } catch {
      // The effort still applies to this session; it is only not remembered after a restart.
    }
    onSettingsChange?.()
  }

  // --- Custom endpoint form ----------------------------------------------------------------------
  // The form covers add and edit. Its key goes to the same field the sidebar uses, so the vault save
  // (or the in-memory value in a browser) follows the sidebar path and the key never sits in storage here.

  function openForm(profile = null) {
    editingId = profile?.id ?? null
    byId("chat-profile-title").textContent = t(profile ? "model.profile.titleEdit" : "model.profile.titleNew")
    byId("chat-profile-name").value = profile?.name ?? ""
    byId("chat-profile-url").value = profile?.baseUrl ?? "http://localhost:11434/v1"
    byId("chat-profile-model").value = profile?.model ?? ""
    byId("chat-profile-key").value = ""
    byId("chat-profile-delete").hidden = !profile
    setError("")
    form.hidden = false
    byId("chat-profile-name").focus()
  }

  function closeForm() {
    form.hidden = true
    byId("chat-profile-key").value = ""
    editingId = null
  }

  function setError(message) {
    const element = byId("chat-profile-error")
    element.textContent = message
    element.hidden = !message
  }

  byId("chat-profile-add").onclick = () => openForm(null)
  byId("chat-profile-edit").onclick = () => {
    const matched = matchLlmProfile(profiles, currentSettings())
    if (matched) openForm(matched)
  }
  byId("chat-profile-cancel").onclick = closeForm

  byId("chat-profile-delete").onclick = () => {
    if (!editingId) return
    profiles = profiles.filter((profile) => profile.id !== editingId)
    writeProfiles()
    // Deleting the active endpoint leaves the sidebar on its last values; the key stays in the vault.
    closeForm()
    refresh()
  }

  form.onsubmit = (event) => {
    event.preventDefault()
    let profile
    try {
      profile = buildLlmProfile({
        id: editingId,
        name: byId("chat-profile-name").value,
        baseUrl: byId("chat-profile-url").value,
        model: byId("chat-profile-model").value,
      }, profiles)
    } catch (error) {
      setError(error.message)
      return
    }
    profiles = editingId
      ? profiles.map((existing) => (existing.id === editingId ? profile : existing))
      : [...profiles, profile]
    writeProfiles()
    applyTarget({ provider: "openai", baseUrl: profile.baseUrl, model: profile.model })
    const key = byId("chat-profile-key").value
    if (key) saveKey(key)
    closeForm()
    onSettingsChange?.()
    refresh()
  }

  // The key goes through the sidebar's own save button when the vault is in use. In a browser the
  // sidebar input keeps it in memory, which is where the agent reads it from.
  function saveKey(key) {
    byId("llm-key").value = key
    if (!byId("llm-key-actions").hidden) byId("llm-key-save").click()
  }

  refresh()

  return {
    refresh,
    effort: () => sanitizeEffort(readStorage(chatEffortStorageKey)),
    profiles: () => [...profiles],
  }
}
