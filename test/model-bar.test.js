import assert from "node:assert/strict"
import test from "node:test"
import { setupModelBar } from "../src/controllers/model-bar.js"
import { chatEffortStorageKey, llmProfilesStorageKey } from "../src/llm-profiles.js"

// The bar writes into the sidebar fields and fires their change handlers. These fakes keep that
// contract: dispatching `change` runs the element's onchange, as the translation controller wires it.

function element(id, extra = {}) {
  const node = {
    id,
    value: "",
    hidden: false,
    options: [],
    textContent: "",
    onchange: null,
    onclick: null,
    onsubmit: null,
    focus() {},
    replaceChildren(...children) { node.children = children },
    dispatchEvent() { node.onchange?.({ type: "change" }) },
    click() { node.onclick?.({ type: "click" }) },
    ...extra,
  }
  return node
}

function fakeDocument(elements) {
  const byId = (id) => {
    if (!elements.has(id)) throw new Error(`missing #${id}`)
    return elements.get(id)
  }
  return byId
}

function setup({ stored = {}, sidebar = {} } = {}) {
  const storage = new Map(Object.entries(stored))
  const storageApi = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  }
  const elements = new Map()
  const add = (id, extra) => elements.set(id, element(id, extra))
  add("translation-provider", { value: sidebar.provider ?? "gemini" })
  add("llm-base-url", { value: sidebar.baseUrl ?? "" })
  add("llm-model", { value: sidebar.llmModel ?? "" })
  add("gemini-model", { value: "auto", options: [{ value: "auto", cloneNode() { return { value: "auto" } } }, { value: "gemini-3.5-flash-lite", cloneNode() { return { value: "gemini-3.5-flash-lite" } } }] })
  add("llm-key", { value: "" })
  add("llm-key-actions", { hidden: true })
  add("llm-key-save", {})
  for (const id of ["chat-provider", "chat-model-gemini", "chat-model-llm", "chat-effort", "chat-profile-add", "chat-profile-edit", "chat-profile-form", "chat-profile-title", "chat-profile-name", "chat-profile-url", "chat-profile-model", "chat-profile-key", "chat-profile-error", "chat-profile-delete", "chat-profile-cancel"]) add(id)
  elements.get("chat-profile-form").hidden = true
  elements.get("chat-profile-error").hidden = true

  const previous = { document: globalThis.document, Option: globalThis.Option }
  globalThis.document = { createElement: () => element("option", { value: "" }), activeElement: null }
  globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value } }
  let changes = 0
  const bar = setupModelBar({
    byId: fakeDocument(elements),
    t: (key) => key,
    onSettingsChange: () => { changes += 1 },
    storage: storageApi,
  })
  const restore = () => {
    globalThis.document = previous.document
    globalThis.Option = previous.Option
  }
  return { bar, elements, storage, restore, changes: () => changes }
}

test("the bar shows the Gemini model list and hides the custom model field while Gemini is active", () => {
  const { elements, restore } = setup({ sidebar: { provider: "gemini" } })
  try {
    assert.equal(elements.get("chat-provider").value, "gemini")
    assert.equal(elements.get("chat-model-gemini").hidden, false)
    assert.equal(elements.get("chat-model-llm").hidden, true)
    assert.equal(elements.get("chat-profile-edit").hidden, true)
  } finally {
    restore()
  }
})

test("saving a new endpoint writes it to storage and applies it to the sidebar fields", () => {
  const { bar, elements, storage, restore, changes } = setup()
  try {
    const form = elements.get("chat-profile-form")
    elements.get("chat-profile-add").onclick()
    assert.equal(form.hidden, false)
    elements.get("chat-profile-name").value = "Ollama local"
    elements.get("chat-profile-url").value = "http://localhost:11434/v1"
    elements.get("chat-profile-model").value = "qwen2.5:7b"
    elements.get("chat-profile-key").value = "sk-local-test"
    form.onsubmit({ preventDefault() {} })

    const stored = JSON.parse(storage.get(llmProfilesStorageKey))
    assert.equal(stored.length, 1)
    assert.equal(stored[0].name, "Ollama local")
    assert.equal("key" in stored[0] || JSON.stringify(stored).includes("sk-local-test"), false, "the key must never reach storage")
    assert.equal(elements.get("translation-provider").value, "openai")
    assert.equal(elements.get("llm-base-url").value, "http://localhost:11434/v1")
    assert.equal(elements.get("llm-model").value, "qwen2.5:7b")
    assert.equal(elements.get("llm-key").value, "sk-local-test", "the key goes to the sidebar field that the agent reads")
    assert.equal(form.hidden, true)
    assert.equal(elements.get("chat-provider").value, `profile:${stored[0].id}`)
    assert.equal(elements.get("chat-profile-edit").hidden, false)
    assert.ok(changes() > 0)
    assert.equal(bar.profiles().length, 1)
  } finally {
    restore()
  }
})

test("an invalid endpoint keeps the form open with the reason and writes nothing", () => {
  const { elements, storage, restore } = setup()
  try {
    elements.get("chat-profile-add").onclick()
    elements.get("chat-profile-name").value = "Broken"
    elements.get("chat-profile-url").value = "ftp://example.com/v1"
    elements.get("chat-profile-model").value = "m"
    elements.get("chat-profile-form").onsubmit({ preventDefault() {} })
    assert.equal(elements.get("chat-profile-form").hidden, false)
    assert.equal(elements.get("chat-profile-error").hidden, false)
    assert.ok(elements.get("chat-profile-error").textContent.length > 0)
    assert.equal(storage.has(llmProfilesStorageKey), false)
  } finally {
    restore()
  }
})

test("choosing a saved endpoint in the dropdown switches the sidebar to it", () => {
  const profile = { id: "p1", name: "LM Studio", baseUrl: "http://localhost:1234/v1", model: "gemma" }
  const { elements, restore } = setup({
    stored: { [llmProfilesStorageKey]: JSON.stringify([profile]) },
    sidebar: { provider: "gemini" },
  })
  try {
    const provider = elements.get("chat-provider")
    provider.value = "profile:p1"
    provider.onchange({ type: "change" })
    assert.equal(elements.get("translation-provider").value, "openai")
    assert.equal(elements.get("llm-base-url").value, profile.baseUrl)
    assert.equal(elements.get("llm-model").value, profile.model)
    assert.equal(elements.get("chat-model-llm").hidden, false)
  } finally {
    restore()
  }
})

test("the reasoning effort is remembered and passed to the next turn", () => {
  const { bar, elements, storage, restore, changes } = setup()
  try {
    const effort = elements.get("chat-effort")
    effort.value = "high"
    effort.onchange({ type: "change" })
    assert.equal(storage.get(chatEffortStorageKey), "high")
    assert.equal(bar.effort(), "high")
    assert.ok(changes() > 0)
    storage.set(chatEffortStorageKey, "not-a-level")
    assert.equal(bar.effort(), "")
  } finally {
    restore()
  }
})

test("deleting the endpoint being edited removes it but keeps the sidebar values", () => {
  const profile = { id: "p1", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" }
  const { bar, elements, storage, restore } = setup({
    stored: { [llmProfilesStorageKey]: JSON.stringify([profile]) },
    sidebar: { provider: "openai", baseUrl: profile.baseUrl, llmModel: profile.model },
  })
  try {
    elements.get("chat-profile-edit").onclick()
    assert.equal(elements.get("chat-profile-delete").hidden, false)
    elements.get("chat-profile-delete").onclick()
    assert.deepEqual(bar.profiles(), [])
    assert.equal(JSON.parse(storage.get(llmProfilesStorageKey)).length, 0)
    assert.equal(elements.get("llm-model").value, profile.model)
  } finally {
    restore()
  }
})
