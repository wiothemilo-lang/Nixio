const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const { randomUUID } = require("node:crypto")
const { resolvePublicAddress } = require("./web-search.cjs")
const { resolveCredentialScope } = require("./credential-ipc.cjs")
const { CREDENTIAL_CODES, CredentialStoreError } = require("./credential-store.cjs")

// Main-process transport for the two selected provider shapes the renderer used to call itself.
// The renderer names a provider, an operation and a request body; main decides the origin, the path,
// the headers and the credential. No channel accepts a URL, a method, a header or a handle, so there
// is no generic privileged proxy to misdirect.

const CHANNEL_PREFIX = "khung-thoai:"
// `event` is the only push channel; it carries stream frames for a ticket main just issued.
// `activate` is the acknowledgement that closes the gap between the reply that carries a ticket and
// the first frame: main holds frames until the renderer says it is listening, so the order of an IPC
// reply and a push frame never has to be assumed.
const PROVIDER_CHANNELS = Object.freeze({
  request: CHANNEL_PREFIX + "provider-request",
  stream: CHANNEL_PREFIX + "provider-stream",
  activate: CHANNEL_PREFIX + "provider-activate",
  cancel: CHANNEL_PREFIX + "provider-cancel",
  event: CHANNEL_PREFIX + "provider-event",
})

const GEMINI_HOST = "generativelanguage.googleapis.com"
const GEMINI_ORIGIN = "https://" + GEMINI_HOST
// `streamGenerateContent` needs ?alt=sse to answer with text/event-stream. The suffix is a property of
// the operation, never of the caller's request.
const GEMINI_OPERATIONS = new Map([
  ["generateContent", { suffix: ":generateContent", sse: false }],
  ["streamGenerateContent", { suffix: ":streamGenerateContent?alt=sse", sse: true }],
])
// A Gemini model is a single path segment between two main-built pieces of the path, so it is checked
// against a lowercase segment grammar that cannot carry a slash, a colon, a percent escape, a query
// delimiter or a dot-dot traversal.
const GEMINI_MODEL_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,7}$/
const MAX_MODEL_LENGTH = 64

const OPENAI_SCOPE_PREFIX = "openai:"
const OPENAI_CHAT_PATH = "/chat/completions"

const PROVIDER_NAMES = new Set(["gemini", "openai"])
const GEMINI_REQUEST_OPERATION = "generateContent"
const GEMINI_STREAM_OPERATION = "streamGenerateContent"
const OPENAI_OPERATION = "chat.completions"

// Loopback names are mapped to fixed literals instead of the resolver, so the local inference path
// keeps working on the address the user configured while DNS cannot re-point it anywhere else.
const LOOPBACK_ADDRESSES = new Map([
  ["localhost", "127.0.0.1"],
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "::1"],
])

const MAX_REQUEST_BYTES = 20 * 1024 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_STREAM_CHUNKS = 20000
const MAX_RETRY_AFTER_MS = 15000
// Base of the rolling hash the redactor uses to test a held-back suffix against a secret prefix.
const REDACTOR_HASH_BASE = 0x01000193
const REQUEST_TIMEOUT_MS = 120000
const STREAM_IDLE_TIMEOUT_MS = 120000
const STREAM_TOTAL_TIMEOUT_MS = 600000
// A caller may ask for its own whole-exchange deadline (the renderer passes the per-call timeout it
// would apply to a browser fetch). It can only shorten the lifetime inside these bounds; anything else
// is refused rather than silently replaced.
const MIN_REQUEST_TIMEOUT_MS = 1000
const MAX_REQUEST_TIMEOUT_MS = STREAM_TOTAL_TIMEOUT_MS
// The renderer may name the exchange it is starting, which is what makes a cancel reach work that has
// not produced a ticket yet (a vault read, a DNS answer, a header block). The grammar keeps a name a
// short opaque token so it can never carry a URL, a secret or a path.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,96}$/
// Frames a stream may buffer before the renderer acknowledges its ticket. A document that never
// acknowledges cannot make main hold an unbounded body; the exchange is closed with a limit error.
const MAX_EARLY_FRAMES = 64
const MAX_EARLY_BYTES = 512 * 1024
// A ticket that ended before its acknowledgement keeps one terminal frame, so a renderer that
// acknowledges late still learns why. The table is FIFO and small, so it cannot grow with traffic.
const MAX_FINISHED_TICKETS = 16
const REDACTED = "[redacted]"
const USER_AGENT = "Nixio/1.0 (Manga Editor Provider Transport)"

const PROVIDER_CODES = Object.freeze({
  UNTRUSTED: "ERR_PROVIDER_UNTRUSTED",
  REQUEST: "ERR_PROVIDER_REQUEST",
  OPERATION: "ERR_PROVIDER_OPERATION",
  MODEL: "ERR_PROVIDER_MODEL",
  ENDPOINT: "ERR_PROVIDER_ENDPOINT",
  SCOPE: "ERR_PROVIDER_SCOPE",
  // Kept distinct from SCOPE so a settings screen can say "enter a key" instead of "bad URL".
  CREDENTIAL: "ERR_PROVIDER_CREDENTIAL",
  POLICY: "ERR_PROVIDER_POLICY",
  REDIRECT: "ERR_PROVIDER_REDIRECT",
  STATUS: "ERR_PROVIDER_STATUS",
  LIMIT: "ERR_PROVIDER_LIMIT",
  TIMEOUT: "ERR_PROVIDER_TIMEOUT",
  NETWORK: "ERR_PROVIDER_NETWORK",
  CANCELLED: "ERR_PROVIDER_CANCELLED",
})

// Fixed strings only: nothing here interpolates a key, an endpoint, a socket error or a header, so a
// message is safe to hand to the renderer, to a log and to an error toast.
const PROVIDER_MESSAGES = Object.freeze({
  [PROVIDER_CODES.UNTRUSTED]: "Untrusted desktop frame.",
  [PROVIDER_CODES.REQUEST]: "Invalid provider request.",
  [PROVIDER_CODES.OPERATION]: "This provider operation is not supported.",
  [PROVIDER_CODES.MODEL]: "Invalid provider model name.",
  [PROVIDER_CODES.ENDPOINT]: "Invalid provider endpoint.",
  [PROVIDER_CODES.SCOPE]: "Invalid provider credential scope.",
  [PROVIDER_CODES.CREDENTIAL]: "No usable API key is stored for this provider and endpoint.",
  [PROVIDER_CODES.POLICY]: "The provider endpoint is not an allowed destination.",
  [PROVIDER_CODES.REDIRECT]: "The provider answered with a redirect, which is never followed.",
  [PROVIDER_CODES.STATUS]: "The provider returned an error status.",
  [PROVIDER_CODES.LIMIT]: "The provider exchange exceeded its size or frame limit.",
  [PROVIDER_CODES.TIMEOUT]: "The provider did not answer in time.",
  [PROVIDER_CODES.NETWORK]: "The provider request failed.",
  [PROVIDER_CODES.CANCELLED]: "The provider request was cancelled.",
})

class ProviderTransportError extends Error {
  constructor(code, { status, retryAfterMs } = {}) {
    super(PROVIDER_MESSAGES[code] ?? PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK])
    this.name = "ProviderTransportError"
    this.code = code
    if (Number.isInteger(status)) this.status = status
    if (Number.isInteger(retryAfterMs)) this.retryAfterMs = retryAfterMs
  }
}

const providerError = (code, options) => new ProviderTransportError(code, options)

function loopbackAddress(hostname) {
  const clean = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "")
  return LOOPBACK_ADDRESSES.get(clean) ?? null
}

// Mirrors `parseRetryAfterMs` in src/llm-retry.js. src is an ES module bundled for the browser and
// cannot be required from a CommonJS main process, so the bounded parser is kept here as well.
function parseRetryAfterMs(value, maxMs = MAX_RETRY_AFTER_MS) {
  if (!value) return null
  const text = String(value).trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.min(maxMs, Math.max(0, Math.round(Number(text) * 1000)))
  const date = Date.parse(text)
  if (Number.isFinite(date)) return Math.min(maxMs, Math.max(0, date - Date.now()))
  return null
}

function describeContentType(rawHeader) {
  const value = String(rawHeader ?? "").toLowerCase()
  if (value.includes("text/event-stream")) return "sse"
  if (value.includes("json")) return "json"
  return "text"
}

const isRedirectStatus = (status) => status >= 300 && status < 400
const isSuccessStatus = (status) => status >= 200 && status < 300

/**
 * Redacts a secret from a response body, including when the secret is split across two chunks.
 *
 * A frame only ever emits text that cannot be the start of a secret: everything after the last
 * position that could still grow into one is held back and re-examined with the next frame, so a key
 * reflected across a chunk boundary never crosses the IPC.
 *
 * The same scan covers the encodings a reflected header plausibly takes (base64 of the key and of the
 * `Bearer <key>` value, URL-encoded forms), because a debug or misconfigured gateway echoes the header
 * encoded far more often than literally. The hold-back window therefore spans the longest form.
 */
function encodedSecretForms(secret) {
  if (!secret) return []
  const forms = new Set()
  for (const value of [secret, "Bearer " + secret]) {
    forms.add(Buffer.from(value, "utf8").toString("base64"))
    forms.add(Buffer.from(value, "utf8").toString("base64url"))
    forms.add(encodeURIComponent(value))
  }
  forms.delete(secret)
  return [...forms].filter((form) => form.length >= 8)
}

// Prefix hashes of one form, oriented with the first character carrying the highest power. A suffix of
// the frame is hashed the same way, so testing "is this suffix a prefix of that form" is one array
// comparison per length instead of a substring comparison per candidate.
function prefixHashes(form) {
  const hashes = new Uint32Array(form.length + 1)
  let hash = 0
  for (let index = 0; index < form.length; index++) {
    hash = (Math.imul(hash, REDACTOR_HASH_BASE) + form.charCodeAt(index)) >>> 0
    hashes[index + 1] = hash
  }
  return hashes
}

class SecretRedactor {
  constructor(secret) {
    this.secret = typeof secret === "string" && secret ? secret : null
    this.forms = [this.secret, ...encodedSecretForms(this.secret)].filter(Boolean)
    this.window = this.forms.reduce((longest, form) => Math.max(longest, form.length), 0)
    this.prefixes = this.forms.map(prefixHashes)
    this.tail = ""
  }

  redact(text) {
    // split/join replaces every occurrence without interpreting the secret as a pattern.
    return this.forms.reduce((result, form) => result.split(form).join(REDACTED), text)
  }

  // Longest suffix of `text` that is a proper prefix of the secret or of one of its encodings, so it is
  // held back until it can be shown not to complete one. The hash only shortlists a length; the
  // `endsWith` check keeps a collision from holding back the wrong suffix, and a secret of any length
  // costs one pass instead of a quadratic scan.
  holdback(text) {
    const limit = Math.min(text.length, this.window - 1)
    if (limit <= 0) return 0
    let longest = 0
    let hash = 0
    let power = 1
    for (let size = 1; size <= limit; size++) {
      hash = (hash + Math.imul(text.charCodeAt(text.length - size), power)) >>> 0
      power = Math.imul(power, REDACTOR_HASH_BASE) >>> 0
      const shortlisted = this.prefixes.some((prefixes) => prefixes[size] === hash)
      if (shortlisted && this.forms.some((form) => text.endsWith(form.slice(0, size)))) longest = size
    }
    return longest
  }

  push(text) {
    const chunk = String(text ?? "")
    if (!this.secret) return chunk
    const buffer = this.redact(this.tail + chunk)
    const hold = this.holdback(buffer)
    this.tail = hold ? buffer.slice(buffer.length - hold) : ""
    return hold ? buffer.slice(0, buffer.length - hold) : buffer
  }

  flush() {
    const rest = this.tail
    this.tail = ""
    return rest
  }
}

function senderKeyOf(event) {
  const id = event?.sender?.id
  return Number.isInteger(id) && id > 0 ? "w" + id : null
}

// The optional whole-exchange deadline a caller carries. It is validated as a bounded integer so a
// renderer cannot ask main to hold a socket open forever, or turn the timer into a zero-delay abort.
function parseRequestTimeout(value) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < MIN_REQUEST_TIMEOUT_MS || value > MAX_REQUEST_TIMEOUT_MS) {
    throw providerError(PROVIDER_CODES.REQUEST)
  }
  return value
}

// The optional correlation token a caller uses to cancel an exchange before it has a ticket. It is
// validated as a token rather than used as a key on its own: ownership always comes from the frame's
// sender, so a shared table cannot be steered by a guessed name.
function parseRequestId(value) {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) throw providerError(PROVIDER_CODES.REQUEST)
  return value
}

// Request parsing. Only these fields are read; anything else the renderer includes is ignored, so no
// extra field can become authority over the destination or the credential.
function parseProviderRequest(raw, streaming) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw providerError(PROVIDER_CODES.REQUEST)
  const { provider, operation, model, payload } = raw
  const requestId = parseRequestId(raw.requestId)
  const timeoutMs = parseRequestTimeout(raw.timeoutMs)
  if (!PROVIDER_NAMES.has(provider)) throw providerError(PROVIDER_CODES.REQUEST)
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw providerError(PROVIDER_CODES.REQUEST)
  if (provider === "gemini") {
    const expected = streaming ? GEMINI_STREAM_OPERATION : GEMINI_REQUEST_OPERATION
    if (operation !== expected) throw providerError(PROVIDER_CODES.OPERATION)
    if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH || !GEMINI_MODEL_PATTERN.test(model)) {
      throw providerError(PROVIDER_CODES.MODEL)
    }
  } else {
    if (operation !== OPENAI_OPERATION) throw providerError(PROVIDER_CODES.OPERATION)
    // The stream flag is the only way the OpenAI-compatible shape selects streaming, so the two paths
    // cannot disagree about which one is running.
    if (streaming ? payload.stream !== true : payload.stream !== undefined && payload.stream !== false) {
      throw providerError(PROVIDER_CODES.REQUEST)
    }
  }
  let body
  try { body = JSON.stringify(payload) } catch { throw providerError(PROVIDER_CODES.REQUEST) }
  if (typeof body !== "string" || !body || Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    throw providerError(PROVIDER_CODES.REQUEST)
  }
  return { provider, operation, model, body, requestId, timeoutMs }
}

// The canonical provider+endpoint scope is the only identity a key has. It is resolved here, from the
// provider main built the destination for, so a request cannot name a scope it did not derive.
function credentialScopeFor(provider, endpoint) {
  try {
    return resolveCredentialScope(provider, endpoint)
  } catch (error) {
    if (error instanceof CredentialStoreError && error.code === CREDENTIAL_CODES.INVALID_PROVIDER) {
      throw providerError(PROVIDER_CODES.REQUEST)
    }
    if (error instanceof CredentialStoreError && error.code === CREDENTIAL_CODES.INVALID_ENDPOINT) {
      throw providerError(PROVIDER_CODES.ENDPOINT)
    }
    throw providerError(PROVIDER_CODES.SCOPE)
  }
}

// Gemini's origin, path prefix and query are constants; only a validated model and a whitelisted
// operation take part, and the assembled URL is parsed again to prove nothing else came along.
function geminiDestination(model, operation) {
  const spec = GEMINI_OPERATIONS.get(operation)
  if (!spec) throw providerError(PROVIDER_CODES.OPERATION)
  // Checked here as well as at the request boundary: the path invariant must not depend on a caller
  // having validated the model first.
  if (typeof model !== "string" || model.length > MAX_MODEL_LENGTH || !GEMINI_MODEL_PATTERN.test(model)) {
    throw providerError(PROVIDER_CODES.MODEL)
  }
  const url = new URL(GEMINI_ORIGIN + "/v1beta/models/" + model + spec.suffix)
  if (url.username || url.password || url.hash) throw providerError(PROVIDER_CODES.ENDPOINT)
  if (url.protocol !== "https:" || url.hostname !== GEMINI_HOST) throw providerError(PROVIDER_CODES.ENDPOINT)
  // `alt=sse` is the operation's own query, and it is the only query allowed to exist.
  if (url.search !== "" && !(spec.sse && url.search === "?alt=sse")) throw providerError(PROVIDER_CODES.ENDPOINT)
  const { scope, handle } = credentialScopeFor("gemini")
  return {
    provider: "gemini",
    url: GEMINI_ORIGIN + url.pathname + url.search,
    host: GEMINI_HOST,
    loopback: null,
    scope,
    handle,
  }
}

// The OpenAI-compatible base URL is user-configured, so it is not trusted as given: it goes through
// the credential scope's canonical form and the request URL is rebuilt from that same string. The URL
// the key was stored for is therefore the URL the key is sent to, byte for byte.
function openAiDestination(rawEndpoint) {
  const { scope, handle } = credentialScopeFor("openai", rawEndpoint)
  const base = scope.slice(OPENAI_SCOPE_PREFIX.length)
  if (!base) throw providerError(PROVIDER_CODES.ENDPOINT)
  let url
  try { url = new URL(base + OPENAI_CHAT_PATH) } catch { throw providerError(PROVIDER_CODES.ENDPOINT) }
  if (url.username || url.password || url.search || url.hash) throw providerError(PROVIDER_CODES.ENDPOINT)
  if (!url.pathname.endsWith(OPENAI_CHAT_PATH)) throw providerError(PROVIDER_CODES.ENDPOINT)
  const loopback = loopbackAddress(url.hostname)
  const secure = url.protocol === "https:"
  if (!secure && !(url.protocol === "http:" && loopback)) throw providerError(PROVIDER_CODES.ENDPOINT)
  const origin = url.protocol + "//" + url.host
  return {
    provider: "openai",
    url: origin + url.pathname,
    host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    loopback,
    scope,
    handle,
  }
}

function buildHeaders(destination, secret, streaming) {
  const accept = streaming ? "text/event-stream, application/json" : "application/json, text/event-stream"
  const headers = {
    "Content-Type": "application/json",
    Accept: accept,
    // An uncompressed body keeps the byte limit meaningful and needs no decoder in the path.
    "Accept-Encoding": "identity",
    "User-Agent": USER_AGENT,
  }
  if (!secret) return headers
  if (destination.provider === "gemini") headers["x-goog-api-key"] = secret
  else headers.Authorization = "Bearer " + secret
  return headers
}

/**
 * Single POST to the pinned address of an already-validated destination.
 *
 * The socket goes to the resolved or fixed literal address while the TLS name and Host header stay on
 * the real hostname, so certificate checks still apply. `agent: false` means no pooled connection is
 * shared between destinations, and the caller's signal is the only way out of a request.
 */
function openRequest({ url, address, headers, body, signal, timeoutMs, request = null }) {
  const target = new URL(url)
  const secure = target.protocol === "https:"
  const hostname = target.hostname.replace(/^\[|\]$/g, "")
  const literal = net.isIP(hostname) !== 0
  const transport = secure ? https : http
  const options = {
    method: "POST",
    host: address,
    port: target.port ? Number(target.port) : secure ? 443 : 80,
    path: target.pathname + target.search,
    headers: {
      Host: target.host,
      ...headers,
      "Content-Length": String(Buffer.byteLength(body)),
    },
    agent: false,
    signal,
    ...(secure && !literal ? { servername: target.hostname } : {}),
  }
  if (request) return request(options, url)

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = transport.request(options, (res) => {
      if (settled) {
        res.destroy()
        return
      }
      settled = true
      resolve({ status: res.statusCode ?? 0, headers: res.headers, response: res })
    })
    // A socket timeout is an inactivity timer: it covers a stalled connect, a stalled header block
    // and a body trickling in below any progress the deadline would notice.
    req.setTimeout(timeoutMs, () => {
      fail(providerError(PROVIDER_CODES.TIMEOUT))
      req.destroy()
    })
    req.on("error", (error) => {
      if (signal?.aborted) fail(providerError(PROVIDER_CODES.CANCELLED))
      else if (error?.name === "AbortError" || error?.code === "ABORT_ERR") fail(providerError(PROVIDER_CODES.CANCELLED))
      else fail(providerError(PROVIDER_CODES.NETWORK))
    })
    req.end(body)
  })
}

function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let received = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const done = () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    }
    response.on("data", (chunk) => {
      if (settled) return
      received += chunk.length
      if (received > maxBytes) {
        fail(providerError(PROVIDER_CODES.LIMIT))
        response.destroy()
        return
      }
      chunks.push(chunk)
    })
    response.on("end", done)
    response.on("aborted", () => fail(providerError(PROVIDER_CODES.NETWORK)))
    response.on("error", (error) => {
      if (error instanceof ProviderTransportError) fail(error)
      else if (error?.name === "AbortError" || error?.code === "ABORT_ERR") fail(providerError(PROVIDER_CODES.CANCELLED))
      else fail(providerError(PROVIDER_CODES.NETWORK))
    })
  })
}

// The renderer only ever receives a closed shape: a status code, a content-type class and the body.
// Response headers are not forwarded, so a reflected credential in an echo header cannot travel.
function failureOf(error) {
  if (error instanceof ProviderTransportError && Object.hasOwn(PROVIDER_MESSAGES, error.code)) {
    const payload = { ok: false, code: error.code, message: PROVIDER_MESSAGES[error.code] }
    if (Number.isInteger(error.status)) payload.status = error.status
    if (Number.isInteger(error.retryAfterMs)) payload.retryAfterMs = error.retryAfterMs
    return payload
  }
  return { ok: false, code: PROVIDER_CODES.NETWORK, message: PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK] }
}

const streamFailureOf = (error) => ({ type: "error", ...failureOf(error) })

// Main-process facade for the provider channels. Main-process only: `credentials` is the credential
// store itself, read with a handle derived from the canonical scope, and the decrypted key never
// leaves this module except as a request header.
//
// Every exchange is registered before its first `await`, so its lifetime covers the vault read, the
// DNS answer, the header block and the body. Cancelling it ends a pending wait, aborts the socket and
// removes its ownership record, which is what keeps work from outliving the document that asked for
// it instead of merely hiding a result the renderer no longer wants.
class ProviderTransport {
  constructor({ credentials, emit, lookup, request, lifetimeMs, streamLifetimeMs, earlyFrames, earlyBytes } = {}) {
    if (!credentials || typeof credentials.read !== "function") {
      throw new TypeError("ProviderTransport needs a credential store.")
    }
    if (typeof emit !== "function") throw new TypeError("ProviderTransport needs an event sink.")
    this.credentials = credentials
    this.emit = emit
    // Test seams only: a resolver, a request function and shorter lifetimes let a fake transport
    // prove what main builds and how an exchange ends.
    this.lookup = lookup
    this.request = request ?? null
    // The lifetime starts with the ownership record, not with the socket, so the vault read, the DNS
    // answer, the header block and the body all share one bounded budget.
    this.lifetimeMs = Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : REQUEST_TIMEOUT_MS
    this.streamLifetimeMs = Number.isFinite(streamLifetimeMs) && streamLifetimeMs > 0
      ? streamLifetimeMs
      : STREAM_TOTAL_TIMEOUT_MS
    this.earlyFrames = Number.isInteger(earlyFrames) && earlyFrames > 0 ? earlyFrames : MAX_EARLY_FRAMES
    this.earlyBytes = Number.isInteger(earlyBytes) && earlyBytes > 0 ? earlyBytes : MAX_EARLY_BYTES
    // Live exchanges by ticket, so a cancel can only reach an exchange its own sender started.
    this.entries = new Map()
    // The same exchanges by the token their own sender named, for a cancel that arrives before a
    // ticket exists. Keyed with the sender, so two documents can never share a name by accident.
    this.requests = new Map()
    // Terminal frames of streams that ended before their acknowledgement.
    this.finished = new Map()
  }

  // Synchronous up to the ownership record: the envelope and the destination are validated before
  // anything is awaited, and the entry exists before the vault or the resolver is consulted.
  begin(senderKey, raw, streaming) {
    if (typeof senderKey !== "string" || !senderKey) throw providerError(PROVIDER_CODES.UNTRUSTED)
    const request = parseProviderRequest(raw, streaming)
    const destination = request.provider === "gemini"
      ? geminiDestination(request.model, request.operation)
      : openAiDestination(raw.endpoint)
    const entry = this.register(senderKey, request.requestId, streaming ? "stream" : "request", request.timeoutMs)
    entry.body = request.body
    return { entry, destination }
  }

  register(senderKey, requestId, kind, lifetimeMs = null) {
    const ticket = (kind === "stream" ? "s" : "r") + randomUUID().replace(/-/g, "")
    const entry = {
      ticket,
      kind,
      senderKey,
      requestId,
      body: "",
      controller: new AbortController(),
      response: null,
      cancelled: false,
      abortReason: null,
      active: false,
      queue: [],
      queuedBytes: 0,
      stopped: false,
      deadline: null,
      rejectAbort: null,
      abortPromise: null,
    }
    // A vault read and a DNS answer are ordinary promises, so cancellation wins a race against them
    // rather than being noticed only once they settle.
    entry.abortPromise = new Promise((_, reject) => { entry.rejectAbort = reject })
    entry.abortPromise.catch(() => {})
    this.entries.set(ticket, entry)
    if (requestId) this.requests.set(this.requestKey(senderKey, requestId), entry)
    entry.deadline = setTimeout(
      () => this.abortEntry(entry, providerError(PROVIDER_CODES.TIMEOUT)),
      // A caller deadline only ever shortens the transport default it was validated against.
      lifetimeMs ?? (kind === "stream" ? this.streamLifetimeMs : this.lifetimeMs),
    )
    // Keep the deadline referenced: a vault read or resolver promise alone does not keep the event
    // loop alive, so an unref'd timer lets an unanswered exchange hang forever instead of timing out.
    return entry
  }

  requestKey(senderKey, requestId) {
    return senderKey + "\n" + requestId
  }

  // A waiting step that cancellation must interrupt. The promise that loses the race keeps its own
  // rejection handled, so a late DNS failure cannot surface as an unhandled rejection.
  async race(entry, promise) {
    promise.catch(() => {})
    const value = await Promise.race([promise, entry.abortPromise])
    this.throwIfAborted(entry)
    return value
  }

  throwIfAborted(entry) {
    if (entry.cancelled) throw entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED)
  }

  // The credential is read and the pinned address resolved under the entry's lifetime, and both steps
  // stop being awaited as soon as the exchange is cancelled. `authorize` never dispatches a socket.
  async authorize(entry, destination, streaming) {
    const secret = await this.race(entry, this.readSecret(destination.handle))
    // A stored key that cannot be read is an error, not an invitation to try keyless: silently
    // dropping auth would turn "vault locked" into a confusing provider 401.
    if (!secret && !this.allowsKeyless(destination)) throw providerError(PROVIDER_CODES.CREDENTIAL)
    const address = await this.race(entry, this.resolveAddress(destination))
    this.throwIfAborted(entry)
    return {
      secret,
      transport: {
        url: destination.url,
        address,
        headers: buildHeaders(destination, secret, streaming),
        body: entry.body,
        request: this.request,
      },
    }
  }

  allowsKeyless(destination) {
    // The renderer used to send an OpenAI-compatible call with no Authorization header whenever its
    // key field was empty, so a public HTTPS endpoint that authenticates some other way kept working.
    // That compatibility is deliberate: the destination is still user-configured, still HTTPS (or a
    // loopback literal), still pinned by this module, and a keyless call therefore carries no
    // credential and reaches nobody but the endpoint the user named. Gemini keeps a key requirement,
    // because its key is the only thing that identifies the caller there.
    return destination.provider === "openai"
  }

  async readSecret(handle) {
    try {
      return await this.credentials.read(handle)
    } catch {
      // A native cryptography failure keeps its own fixed message in the credential layer; here it
      // becomes one provider message with no cause chain attached.
      throw providerError(PROVIDER_CODES.CREDENTIAL)
    }
  }

  async resolveAddress(destination) {
    if (destination.loopback) return destination.loopback
    try {
      return await resolvePublicAddress(destination.host, this.lookup ? { lookup: this.lookup } : undefined)
    } catch {
      throw providerError(PROVIDER_CODES.POLICY)
    }
  }

  async execute(senderKey, raw) {
    let begun
    try {
      begun = this.begin(senderKey, raw, false)
    } catch (error) {
      return failureOf(error)
    }
    const { entry, destination } = begun
    try {
      const { transport, secret } = await this.authorize(entry, destination, false)
      const opened = await openRequest({ ...transport, signal: entry.controller.signal, timeoutMs: REQUEST_TIMEOUT_MS })
      entry.response = opened.response
      // A cancel that landed while headers were in flight must not read a body or report a status.
      this.throwIfAborted(entry)
      const status = opened.status
      const contentType = describeContentType(opened.headers?.["content-type"])
      if (isRedirectStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.REDIRECT, { status })
      }
      if (!isSuccessStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.STATUS, {
          status,
          retryAfterMs: parseRetryAfterMs(opened.headers?.["retry-after"]),
        })
      }
      const body = await readBody(opened.response, MAX_RESPONSE_BYTES)
      this.throwIfAborted(entry)
      const redactor = new SecretRedactor(secret)
      const text = redactor.push(body.toString("utf8")) + redactor.flush()
      return { ok: true, status, contentType, body: text }
    } catch (error) {
      if (entry.cancelled) return failureOf(entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED))
      return failureOf(error)
    } finally {
      if (entry.response && !entry.response.destroyed) entry.response.destroy()
      this.releaseEntry(entry)
    }
  }

  async stream(senderKey, raw) {
    let begun
    try {
      begun = this.begin(senderKey, raw, true)
    } catch (error) {
      return failureOf(error)
    }
    const { entry, destination } = begun
    let pumping = false
    try {
      const { transport, secret } = await this.authorize(entry, destination, true)
      const opened = await openRequest({ ...transport, signal: entry.controller.signal, timeoutMs: STREAM_IDLE_TIMEOUT_MS })
      entry.response = opened.response
      this.throwIfAborted(entry)
      const status = opened.status
      const contentType = describeContentType(opened.headers?.["content-type"])
      if (isRedirectStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.REDIRECT, { status })
      }
      if (!isSuccessStatus(status)) {
        opened.response.destroy()
        throw providerError(PROVIDER_CODES.STATUS, {
          status,
          retryAfterMs: parseRetryAfterMs(opened.headers?.["retry-after"]),
        })
      }
      // Frames are held until the renderer acknowledges the ticket, so the order of this reply and the
      // first push frame is never assumed. `pump` starts here and queues rather than emitting.
      pumping = true
      const pump$ = this.pump(entry, secret)
      pump$.catch(() => {})
      return { ok: true, ticket: entry.ticket, status, contentType }
    } catch (error) {
      if (entry.cancelled) return failureOf(entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED))
      return failureOf(error)
    } finally {
      if (!pumping) {
        if (entry.response && !entry.response.destroyed) entry.response.destroy()
        this.releaseEntry(entry)
      }
    }
  }

  async pump(entry, secret) {
    const { response } = entry
    const redactor = new SecretRedactor(secret)
    const decoder = new TextDecoder("utf-8")
    let bytes = 0
    let chunks = 0
    // The inactivity timer is the socket's own, reset by every byte the provider sends.
    response.setTimeout?.(STREAM_IDLE_TIMEOUT_MS, () => {
      this.abortEntry(entry, providerError(PROVIDER_CODES.TIMEOUT))
    })
    try {
      for await (const chunk of response) {
        bytes += chunk.length
        chunks += 1
        if (bytes > MAX_STREAM_BYTES || chunks > MAX_STREAM_CHUNKS) throw providerError(PROVIDER_CODES.LIMIT)
        // stream: true keeps a multi-byte character split across two frames intact.
        const text = redactor.push(decoder.decode(chunk, { stream: true }))
        if (text) this.emitFrame(entry, { type: "chunk", text })
      }
      const tail = redactor.push(decoder.decode()) + redactor.flush()
      if (tail) this.emitFrame(entry, { type: "chunk", text: tail })
      this.finishEntry(entry, { type: "end" })
    } catch (error) {
      this.finishEntry(entry, streamFailureOf(
        entry.cancelled ? entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED) : error,
      ))
    } finally {
      this.releaseEntry(entry)
      if (!response.destroyed) response.destroy()
    }
  }

  // A frame reaches the renderer only after it acknowledged the ticket. Until then it is buffered
  // under a fixed frame and byte budget, so a document that never acknowledges cannot make main hold
  // an unbounded body and a document that acknowledges late still receives the frames in order.
  emitFrame(entry, payload) {
    if (entry.stopped) return
    if (entry.active) {
      this.send(entry.senderKey, { ticket: entry.ticket, ...payload })
      return
    }
    const text = typeof payload.text === "string" ? payload.text : ""
    const size = text.length + 32
    if (entry.queue.length >= this.earlyFrames || entry.queuedBytes + size > this.earlyBytes) {
      this.abortEntry(entry, providerError(PROVIDER_CODES.LIMIT))
      return
    }
    entry.queue.push(payload)
    entry.queuedBytes += size
  }

  // A stream that ends before its acknowledgement keeps everything it buffered plus its terminal
  // frame, in one bounded list, so a renderer that acknowledges late receives the same frames in the
  // same order instead of only learning that the exchange is over.
  finishEntry(entry, terminal) {
    if (entry.stopped) return
    entry.stopped = true
    const frames = [...entry.queue, terminal]
    entry.queue = []
    entry.queuedBytes = 0
    if (entry.active) this.send(entry.senderKey, { ticket: entry.ticket, ...terminal })
    else this.rememberFinished(entry, frames.map((payload) => ({ ticket: entry.ticket, ...payload })))
  }

  rememberFinished(entry, frames) {
    this.finished.set(entry.ticket, { senderKey: entry.senderKey, frames })
    while (this.finished.size > MAX_FINISHED_TICKETS) {
      this.finished.delete(this.finished.keys().next().value)
    }
  }

  // A frame that cannot be delivered (window gone, IPC closed) must not become a rejection in the
  // pump, which nothing awaits.
  send(senderKey, payload) {
    try { this.emit(senderKey, payload) } catch {}
  }

  // The acknowledgement that opens the frame tap: flush what was buffered, or hand over the single
  // terminal frame of a stream that ended before this arrived.
  activate(senderKey, ticket) {
    const entry = typeof senderKey === "string" && typeof ticket === "string" ? this.entries.get(ticket) : null
    if (entry && entry.senderKey === senderKey && entry.kind === "stream") {
      if (entry.stopped) return { ok: true, active: false }
      entry.active = true
      const queued = entry.queue
      entry.queue = []
      entry.queuedBytes = 0
      for (const payload of queued) this.send(senderKey, { ticket: entry.ticket, ...payload })
      return { ok: true, active: true }
    }
    const finished = typeof senderKey === "string" && typeof ticket === "string" ? this.finished.get(ticket) : null
    if (finished && finished.senderKey === senderKey) {
      this.finished.delete(ticket)
      for (const frame of finished.frames) this.send(senderKey, frame)
      return { ok: true, active: false, finished: true }
    }
    return { ok: true, active: false }
  }

  // Any abort is final for the exchange: it ends the lifetime, ends a pending wait, destroys the
  // socket, and drops ownership so a late dispatch has nothing left to run under.
  abortEntry(entry, reason) {
    if (entry.cancelled) return false
    entry.cancelled = true
    entry.abortReason = reason ?? null
    clearTimeout(entry.deadline)
    entry.deadline = null
    entry.rejectAbort?.(entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED))
    try { entry.controller.abort() } catch {}
    try { entry.response?.destroy?.() } catch {}
    if (entry.kind === "stream" && !entry.stopped) {
      // A cancelled stream keeps only its terminal frame: the bytes it had buffered are meaningless
      // once the exchange is over and are dropped rather than handed to a late acknowledgement.
      entry.queue = []
      entry.queuedBytes = 0
      this.finishEntry(entry, streamFailureOf(entry.abortReason ?? providerError(PROVIDER_CODES.CANCELLED)))
    } else {
      entry.stopped = true
      entry.queue = []
      entry.queuedBytes = 0
    }
    this.forget(entry)
    return true
  }

  forget(entry) {
    this.entries.delete(entry.ticket)
    if (entry.requestId) this.requests.delete(this.requestKey(entry.senderKey, entry.requestId))
  }

  releaseEntry(entry) {
    clearTimeout(entry.deadline)
    entry.deadline = null
    this.forget(entry)
  }

  // A ticket, or the token its own sender named, is only cancellable by that sender, so one document
  // cannot stop another document's exchange.
  cancel(senderKey, target) {
    const entry = this.resolveEntry(senderKey, target)
    if (!entry) return { ok: true, cancelled: false }
    return { ok: true, cancelled: this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED)) }
  }

  resolveEntry(senderKey, target) {
    if (typeof senderKey !== "string" || !senderKey) return null
    const byName = typeof target === "string" ? target : null
    const ticket = byName ?? (typeof target === "object" && target ? target.ticket : null)
    const requestId = byName ?? (typeof target === "object" && target ? target.requestId : null)
    if (typeof ticket === "string") {
      const entry = this.entries.get(ticket)
      if (entry && entry.senderKey === senderKey) return entry
    }
    if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) {
      return this.requests.get(this.requestKey(senderKey, requestId)) ?? null
    }
    return null
  }

  // Teardown for a navigation or a closed window: every exchange still open, whatever opened it, so
  // nothing keeps reading a body after its document is gone. Buffered terminal frames of that document
  // are dropped with it.
  cancelAll() {
    let cancelled = 0
    for (const entry of [...this.entries.values()]) {
      if (this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED))) cancelled += 1
    }
    this.finished.clear()
    return cancelled
  }

  cancelSender(senderKey) {
    let cancelled = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.senderKey !== senderKey) continue
      if (this.abortEntry(entry, providerError(PROVIDER_CODES.CANCELLED))) cancelled += 1
    }
    for (const [ticket, record] of [...this.finished]) {
      if (record.senderKey === senderKey) this.finished.delete(ticket)
    }
    return cancelled
  }
}

// Envelope for the provider channels. `trustedChannel` in credential-ipc.cjs deliberately drops the
// event, but ownership here is derived from it, so the validated event is passed to the action as a
// sender key the renderer never supplies.
function providerChannel(isTrusted, action, onError) {
  if (typeof isTrusted !== "function" || typeof action !== "function") {
    throw new TypeError("providerChannel needs an isTrusted check and an action.")
  }
  return async (event, ...args) => {
    let trusted = false
    try { trusted = isTrusted(event) === true } catch { trusted = false }
    const senderKey = trusted ? senderKeyOf(event) : null
    if (!senderKey) return { error: PROVIDER_MESSAGES[PROVIDER_CODES.UNTRUSTED] }
    try {
      return { value: await action(senderKey, ...args) }
    } catch (error) {
      return { error: onError ? onError(error) : PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK] }
    }
  }
}

// Fixed strings only, so an unexpected throw from anywhere in the path still reaches the renderer as
// one reviewed message rather than as a socket error carrying request context.
function sanitizeProviderError(error) {
  if (error instanceof ProviderTransportError && Object.hasOwn(PROVIDER_MESSAGES, error.code)) {
    return PROVIDER_MESSAGES[error.code]
  }
  return PROVIDER_MESSAGES[PROVIDER_CODES.NETWORK]
}

module.exports = {
  PROVIDER_CHANNELS,
  PROVIDER_CODES,
  PROVIDER_MESSAGES,
  ProviderTransport,
  ProviderTransportError,
  SecretRedactor,
  buildHeaders,
  describeContentType,
  failureOf,
  geminiDestination,
  loopbackAddress,
  openAiDestination,
  openRequest,
  parseProviderRequest,
  parseRetryAfterMs,
  providerChannel,
  providerError,
  sanitizeProviderError,
  senderKeyOf,
}
