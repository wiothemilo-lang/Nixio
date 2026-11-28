// Saved OpenAI-compatible endpoints ("custom providers") and the reasoning effort picked in the chat.
//
// A profile holds only what is safe to keep in plain storage: a display name, a base URL and a model
// name. The API key stays in the OS vault, which binds it to the base URL, so deleting a profile never
// touches a key and two profiles on the same URL share one key by design.

import { validateEndpointUrl } from "./provider-bridge.js"

export const llmProfilesStorageKey = "khung-thoai-llm-profiles"
export const chatEffortStorageKey = "khung-thoai-chat-effort"

// Bounded so the chat dropdown stays usable and the stored record cannot grow without limit.
export const llmProfileLimit = 12
const NAME_MAX_LENGTH = 48
const MODEL_MAX_LENGTH = 128

// `""` means the provider default: no effort field is sent, so models that reject the field keep working.
export const reasoningEfforts = Object.freeze(["", "low", "medium", "high"])

export function sanitizeEffort(value) {
  return reasoningEfforts.includes(value) ? value : ""
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength)
}

// Reads the stored record defensively: a corrupted entry is dropped rather than failing the whole list.
export function sanitizeLlmProfiles(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const profiles = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const id = cleanText(entry.id, 64)
    const name = cleanText(entry.name, NAME_MAX_LENGTH)
    const model = cleanText(entry.model, MODEL_MAX_LENGTH)
    let baseUrl
    try {
      baseUrl = validateEndpointUrl(entry.baseUrl)
    } catch {
      continue
    }
    if (!id || !name || !model || seen.has(id)) continue
    seen.add(id)
    profiles.push(Object.freeze({ id, name, baseUrl, model }))
    if (profiles.length === llmProfileLimit) break
  }
  return profiles
}

// Validates user input for a new or edited profile. Throws a Vietnamese message the form can show.
export function buildLlmProfile({ id, name, baseUrl, model }, existing = []) {
  const cleanName = cleanText(name, NAME_MAX_LENGTH)
  if (!cleanName) throw new Error("Nhập tên nhà cung cấp.")
  const cleanModel = cleanText(model, MODEL_MAX_LENGTH)
  if (!cleanModel) throw new Error("Nhập tên model.")
  const cleanUrl = validateEndpointUrl(baseUrl)
  const duplicate = existing.some((profile) => profile.id !== id && profile.name.toLowerCase() === cleanName.toLowerCase())
  if (duplicate) throw new Error("Đã có nhà cung cấp cùng tên.")
  if (!id && existing.length >= llmProfileLimit) {
    throw new Error(`Tối đa ${llmProfileLimit} nhà cung cấp đã lưu.`)
  }
  return Object.freeze({
    id: id || newProfileId(),
    name: cleanName,
    baseUrl: cleanUrl,
    model: cleanModel,
  })
}

function newProfileId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

// The profile whose endpoint and model match the current sidebar settings, or null for a hand-typed setup.
export function matchLlmProfile(profiles, { baseUrl, llmModel } = {}) {
  return profiles.find((profile) => profile.baseUrl === baseUrl && profile.model === llmModel) ?? null
}
