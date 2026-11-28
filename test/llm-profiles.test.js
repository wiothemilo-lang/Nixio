import assert from "node:assert/strict"
import test from "node:test"
import {
  buildLlmProfile,
  llmProfileLimit,
  matchLlmProfile,
  sanitizeEffort,
  sanitizeLlmProfiles,
} from "../src/llm-profiles.js"

const local = { id: "p1", name: "Ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" }

test("only the three named efforts and the provider default are accepted", () => {
  assert.equal(sanitizeEffort("high"), "high")
  assert.equal(sanitizeEffort(""), "")
  assert.equal(sanitizeEffort("maximum"), "")
  assert.equal(sanitizeEffort(undefined), "")
})

test("a corrupted stored profile is dropped without losing the valid ones", () => {
  const stored = [
    local,
    null,
    "text",
    { id: "p2", name: "Bad", baseUrl: "ftp://example.com/v1", model: "m" },
    { id: "p3", name: "No model", baseUrl: "http://localhost:1/v1", model: "" },
    { id: "p1", name: "Duplicate id", baseUrl: "http://localhost:2/v1", model: "m" },
  ]
  assert.deepEqual(sanitizeLlmProfiles(stored), [local])
  assert.deepEqual(sanitizeLlmProfiles("not a list"), [])
})

test("stored profiles are capped so the chat dropdown and the record stay bounded", () => {
  const many = Array.from({ length: llmProfileLimit + 5 }, (_, index) => ({
    id: `p${index}`,
    name: `Endpoint ${index}`,
    baseUrl: "http://localhost:11434/v1",
    model: "m",
  }))
  assert.equal(sanitizeLlmProfiles(many).length, llmProfileLimit)
})

test("a new profile is validated and given an id, and an edit keeps its id", () => {
  const created = buildLlmProfile({ name: "  LM Studio ", baseUrl: "http://localhost:1234/v1/ ", model: " m " }, [])
  assert.equal(created.name, "LM Studio")
  assert.equal(created.model, "m")
  assert.ok(created.id.length > 0)
  assert.equal(Object.isFrozen(created), true)

  const edited = buildLlmProfile({ id: "p1", name: "Ollama 2", baseUrl: local.baseUrl, model: "llama3" }, [local])
  assert.equal(edited.id, "p1")
  assert.equal(edited.name, "Ollama 2")
})

test("a profile cannot be saved without a name, a model or a valid URL", () => {
  assert.throws(() => buildLlmProfile({ name: " ", baseUrl: local.baseUrl, model: "m" }), /Nhập tên/)
  assert.throws(() => buildLlmProfile({ name: "A", baseUrl: local.baseUrl, model: "" }), /Nhập tên model/)
  assert.throws(() => buildLlmProfile({ name: "A", baseUrl: "not a url", model: "m" }), /Base URL/)
})

test("names are unique regardless of case, but renaming a profile to its own name is allowed", () => {
  assert.throws(
    () => buildLlmProfile({ name: "ollama", baseUrl: local.baseUrl, model: "m" }, [local]),
    /cùng tên/,
  )
  assert.equal(buildLlmProfile({ id: "p1", name: "Ollama", baseUrl: local.baseUrl, model: "m" }, [local]).id, "p1")
})

test("adding beyond the profile limit is refused, editing at the limit is not", () => {
  const full = Array.from({ length: llmProfileLimit }, (_, index) => ({
    id: `p${index}`,
    name: `E${index}`,
    baseUrl: "http://localhost:11434/v1",
    model: "m",
  }))
  assert.throws(() => buildLlmProfile({ name: "Extra", baseUrl: local.baseUrl, model: "m" }, full), /Tối đa/)
  assert.equal(buildLlmProfile({ id: "p0", name: "E0", baseUrl: local.baseUrl, model: "m2" }, full).model, "m2")
})

test("the active profile is the one whose endpoint and model match the sidebar", () => {
  const profiles = [local]
  assert.equal(matchLlmProfile(profiles, { baseUrl: local.baseUrl, llmModel: "qwen2.5:7b" }), local)
  assert.equal(matchLlmProfile(profiles, { baseUrl: local.baseUrl, llmModel: "other" }), null)
  assert.equal(matchLlmProfile(profiles, {}), null)
})
