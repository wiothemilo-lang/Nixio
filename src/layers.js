// The ordered layer stack of a page. Every effect the editor stacks over the scan is a named layer,
// and a retouch layer owns the strokes painted into it, so hiding, reordering or deleting one layer
// never touches another. A project that predates layers opens as the default stack — one implicit
// layer per effect — so nothing has to migrate before the first paint.

export const layerKinds = ["cleanup", "retouch", "text"]

export const layerKindNames = {
  cleanup: "Nền đã xoá chữ",
  retouch: "Cọ vẽ tay",
  text: "Lớp chữ",
}

export const strokeModeNames = { paint: "Cọ vẽ", clone: "Sao chép nền", inpaint: "Inpaint", erase: "Tẩy nét" }

export const layerLimit = 24
export const layerNameLimit = 80

const layerIdPattern = /^layer-(?:cleanup|retouch|text)(?:-[a-z0-9]{1,32})?$/
const isKind = (kind) => layerKinds.includes(kind)
const clampOpacity = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1)

// An id names the kind it draws, so a stack cannot claim a cleanup layer under a stroke layer's id.
export function isLayerId(value) {
  return typeof value === "string" && layerIdPattern.test(value)
}

function newLayerId(kind) {
  const suffix = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? String(Math.random()).slice(2, 10)
  return `layer-${kind}-${suffix}`
}

export function makeLayer(kind, { id, name, visible = true, opacity = 1 } = {}) {
  if (!isKind(kind)) throw new Error("Loại lớp không hợp lệ.")
  const trimmed = typeof name === "string" ? name.trim().slice(0, layerNameLimit) : ""
  return {
    id: isLayerId(id) ? id : newLayerId(kind),
    kind,
    name: trimmed || layerKindNames[kind],
    visible: visible !== false,
    opacity: clampOpacity(opacity),
  }
}

// The ids are fixed so a page that never touched the stack resolves the same layers on every load,
// and so a stroke saved without a layer id can name the layer it belongs to.
export function defaultLayers() {
  return layerKinds.map((kind) => makeLayer(kind, { id: `layer-${kind}` }))
}

const implicitStacks = new WeakMap()

export function pageLayers(page) {
  if (Array.isArray(page?.layers) && page.layers.length) return page.layers
  if (!page || typeof page !== "object") return defaultLayers()
  let layers = implicitStacks.get(page)
  if (!layers) {
    layers = defaultLayers()
    implicitStacks.set(page, layers)
  }
  return layers
}

// Any edit materialises the implicit stack first, so the page carries its own copy from then on —
// the same objects the panel already holds and the stroke ownership checks resolve against.
export function ensurePageLayers(page) {
  if (!page) return []
  if (!Array.isArray(page.layers) || !page.layers.length) page.layers = pageLayers(page)
  return page.layers
}

export const layerVisible = (layer) => layer?.visible !== false
export const layerOpacity = (layer) => (layer ? clampOpacity(layer.opacity) : 1)
export const strokeVisible = (stroke) => stroke?.hidden !== true

export function hasVisibleLayer(page, kind) {
  return pageLayers(page).some((layer) => layer.kind === kind && layerVisible(layer))
}

function primaryRetouchLayer(page) {
  return pageLayers(page).find((layer) => layer.kind === "retouch") ?? null
}

// A stroke belongs to the retouch layer named on it, or to the first retouch layer for the strokes
// a version 2/3 project saved before layers existed.
export function strokeLayer(page, stroke) {
  const layers = pageLayers(page)
  return layers.find((layer) => layer.kind === "retouch" && layer.id === stroke?.layerId) ?? primaryRetouchLayer(page)
}

export function layerStrokes(page, layer) {
  if (layer?.kind !== "retouch") return []
  return (page?.retouchStrokes ?? []).filter((stroke) => strokeLayer(page, stroke) === layer)
}

// Bottom to top, hidden layers and hidden strokes already dropped: exactly what the renderer paints.
export function compositedLayers(page) {
  return pageLayers(page)
    .filter(layerVisible)
    .map((layer) => ({
      layer,
      opacity: layerOpacity(layer),
      strokes: layerStrokes(page, layer).filter(strokeVisible),
    }))
}

export function strokeTarget(page, layerId) {
  const layers = ensurePageLayers(page)
  return layers.find((layer) => layer.kind === "retouch" && layer.id === layerId) ??
    layers.find((layer) => layer.kind === "retouch") ?? null
}

// A brush gesture should not start when the page has neither a brush layer nor room for one: the
// stroke would be accepted but never painted. The layer panel enforces the same limit.
export function canPaint(page, layerId) {
  return Boolean(strokeTarget(page, layerId)) || pageLayers(page).length < layerLimit
}

export function addStroke(page, stroke, layerId) {
  if (!page || !stroke) return null
  let target = strokeTarget(page, layerId)
  if (!target) {
    // The panel can delete the last retouch layer. Without a layer a stroke is stored but never
    // painted or exported, so the next stroke restores a retouch layer below the text instead.
    const textIndex = page.layers.findIndex((layer) => layer.kind === "text")
    target = addLayer(page, "retouch", { index: textIndex < 0 ? undefined : textIndex })
  }
  // A full stack cannot take a brush layer. Refuse the stroke instead of storing one that would
  // never paint; the caller reports why so the rejection is not silent.
  if (!target) return null
  page.retouchStrokes ??= []
  // The id is always written: reordering the stack must never move a stroke to another layer.
  if (target) stroke.layerId = target.id
  else delete stroke.layerId
  page.retouchStrokes.push(stroke)
  return stroke
}

export function removeStroke(page, stroke) {
  const strokes = page?.retouchStrokes
  const index = strokes?.indexOf(stroke) ?? -1
  if (index < 0) return false
  strokes.splice(index, 1)
  return true
}

export function setStrokeHidden(stroke, hidden) {
  const next = Boolean(hidden)
  if (!stroke || (stroke.hidden === true) === next) return false
  if (next) stroke.hidden = true
  else delete stroke.hidden
  return true
}

export function retargetStroke(page, stroke, layerId) {
  const target = pageLayers(page).find((layer) => layer.kind === "retouch" && layer.id === layerId)
  if (!target || !stroke || stroke.layerId === target.id) return false
  stroke.layerId = target.id
  return true
}

export function strokeLabel(stroke, index, pixelSize) {
  const mode = strokeModeNames[stroke?.mode] ?? stroke?.mode ?? ""
  const size = Number.isFinite(pixelSize) && pixelSize > 0 ? `${Math.round(pixelSize)}px` : ""
  return [`#${index + 1}`, mode, size].filter(Boolean).join(" · ")
}

export function renameLayer(layer, name) {
  const next = typeof name === "string" ? name.trim().slice(0, layerNameLimit) : ""
  if (!layer || !next || next === layer.name) return false
  layer.name = next
  return true
}

export function setLayerHidden(layer, hidden) {
  const next = Boolean(hidden)
  if (!layer || layerVisible(layer) === !next) return false
  layer.visible = !next
  return true
}

export function setLayerOpacity(layer, value) {
  const next = clampOpacity(value)
  if (!layer || layer.opacity === next) return false
  layer.opacity = next
  return true
}

export function moveLayer(page, id, delta) {
  const layers = ensurePageLayers(page)
  const index = layers.findIndex((layer) => layer.id === id)
  const target = index + Math.sign(Number(delta) || 0)
  if (index < 0 || target === index || target < 0 || target >= layers.length) return false
  const [layer] = layers.splice(index, 1)
  layers.splice(target, 0, layer)
  return true
}

export function addLayer(page, kind, { name, id, index } = {}) {
  const layers = ensurePageLayers(page)
  if (layers.length >= layerLimit) return null
  const layer = makeLayer(kind, { name, id })
  const at = Number.isInteger(index) ? Math.min(Math.max(index, 0), layers.length) : layers.length
  layers.splice(at, 0, layer)
  return layer
}

// A duplicate sits directly above its source and copies the strokes it owns, so the copy can be
// restyled or retargeted without touching the original.
export function duplicateLayer(page, id) {
  const layers = ensurePageLayers(page)
  const index = layers.findIndex((layer) => layer.id === id)
  if (index < 0 || layers.length >= layerLimit) return null
  const source = layers[index]
  const copy = makeLayer(source.kind, {
    name: `${source.name} (bản sao)`,
    visible: source.visible,
    opacity: source.opacity,
  })
  layers.splice(index + 1, 0, copy)
  const owned = layerStrokes(page, source)
  if (owned.length) {
    page.retouchStrokes ??= []
    for (const stroke of owned) {
      const clone = structuredClone(stroke)
      clone.layerId = copy.id
      page.retouchStrokes.push(clone)
    }
  }
  return copy
}

// Deleting a layer deletes the strokes it owns: the layer is the content, so the output has to lose
// it. The last layer stays, because a page always paints something.
export function removeLayer(page, id) {
  const layers = ensurePageLayers(page)
  const index = layers.findIndex((layer) => layer.id === id)
  if (index < 0 || layers.length <= 1) return false
  const layer = layers[index]
  // Owned strokes are collected before the layer leaves the stack, while it can still resolve them.
  const owned = new Set(layerStrokes(page, layer))
  layers.splice(index, 1)
  if (owned.size) page.retouchStrokes = page.retouchStrokes.filter((stroke) => !owned.has(stroke))
  return true
}

export function layersEqualDefault(layers) {
  if (!Array.isArray(layers) || layers.length !== layerKinds.length) return false
  return layers.every((layer, index) => {
    const kind = layerKinds[index]
    return layer?.kind === kind && layer.name === layerKindNames[kind] &&
      layerVisible(layer) && layerOpacity(layer) === 1
  })
}

// A stack that says nothing beyond the default is not written, so a project that never touched the
// layers keeps claiming the version every build can read.
export function serializeLayers(layers) {
  if (!Array.isArray(layers) || !layers.length || layersEqualDefault(layers)) return undefined
  return layers.map((layer) => ({
    id: layer.id,
    kind: layer.kind,
    ...(layer.name !== layerKindNames[layer.kind] && { name: layer.name }),
    ...(layer.visible === false && { visible: false }),
    ...(layerOpacity(layer) !== 1 && { opacity: layerOpacity(layer) }),
  }))
}

export function validateLayers(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.length || value.length > layerLimit) return null
  const ids = new Set()
  const layers = []
  for (const entry of value) {
    if (!isKind(entry?.kind) || !isLayerId(entry.id) || ids.has(entry.id)) return null
    if (entry.name !== undefined &&
        (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > layerNameLimit || /[\u0000-\u001f]/.test(entry.name))) {
      return null
    }
    if (entry.visible !== undefined && typeof entry.visible !== "boolean") return null
    if (entry.opacity !== undefined && !(Number.isFinite(entry.opacity) && entry.opacity >= 0 && entry.opacity <= 1)) return null
    ids.add(entry.id)
    layers.push(makeLayer(entry.kind, { id: entry.id, name: entry.name, visible: entry.visible !== false, opacity: entry.opacity }))
  }
  return layers
}

// The native PNG compositor stacks the scan, the painted patches and the text in one fixed order, so
// a stack it can reproduce exactly is opaque and keeps every text layer on top. Anything else is
// composited by the renderer, where order and opacity are exact.
export function layersNativeFriendly(page) {
  const layers = pageLayers(page).filter(layerVisible)
  if (layers.some((layer) => layerOpacity(layer) !== 1)) return false
  const firstText = layers.findIndex((layer) => layer.kind === "text")
  return firstText < 0 || layers.slice(firstText).every((layer) => layer.kind === "text")
}
