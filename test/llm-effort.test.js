import assert from "node:assert/strict"
import test from "node:test"
import { providerRegistry } from "../src/provider-registry.js"

// The effort the chat picks must reach the request body of each API, and the default must send nothing,
// so a model that rejects the field keeps working until the user opts in.

function thread() {
  return {
    request: () => ({ messages: [{ role: "user", content: "hi" }], systemPrompt: "s", contents: [] }),
  }
}

async function captureBody(settings) {
  const original = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const provider = providerRegistry.resolve(settings)
    await provider.callStep({ settings, thread: thread(), toolDefs: [], signal: undefined, stream: false, onDelta: () => {} })
  } finally {
    globalThis.fetch = original
  }
  return bodies[0]
}

const openAi = { provider: "openai", baseUrl: "http://localhost:11434/v1", llmModel: "qwen2.5:7b" }

test("an OpenAI-compatible request carries the chosen reasoning effort", async () => {
  const body = await captureBody({ ...openAi, effort: "high" })
  assert.equal(body.reasoning_effort, "high")
})

test("the default effort sends no reasoning field to the OpenAI-compatible endpoint", async () => {
  const body = await captureBody({ ...openAi, effort: "" })
  assert.equal("reasoning_effort" in body, false)
})

test("an unknown effort value from storage is ignored instead of forwarded", async () => {
  const body = await captureBody({ ...openAi, effort: "ultra" })
  assert.equal("reasoning_effort" in body, false)
})

test("a Gemini request maps the chosen effort onto thinkingLevel and omits it by default", async () => {
  const original = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const provider = providerRegistry.resolve({ provider: "gemini", key: "test-key", model: "auto", effort: "medium" })
    await provider.callStep({ settings: { provider: "gemini", key: "test-key", model: "auto", effort: "medium" }, thread: thread(), toolDefs: [], stream: false, onDelta: () => {} })
    const settings = { provider: "gemini", key: "test-key", model: "auto", effort: "" }
    await providerRegistry.resolve(settings).callStep({ settings, thread: thread(), toolDefs: [], stream: false, onDelta: () => {} })
  } finally {
    globalThis.fetch = original
  }
  assert.equal(bodies[0].generationConfig.thinkingConfig.thinkingLevel, "medium")
  assert.equal("generationConfig" in bodies[1], false)
})
