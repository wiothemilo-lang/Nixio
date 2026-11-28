import assert from "node:assert/strict"
import test from "node:test"
import {
  addLayer, addStroke, canPaint, compositedLayers, defaultLayers, duplicateLayer, hasVisibleLayer,
  layerKindNames, layerLimit, layerStrokes, layersEqualDefault, layersNativeFriendly, moveLayer,
  pageLayers, removeLayer, removeStroke, renameLayer, retargetStroke, serializeLayers,
  setLayerHidden, setLayerOpacity, setStrokeHidden, strokeLabel, strokeLayer, strokeTarget, validateLayers,
} from "../src/layers.js"

const paintStroke = (overrides = {}) => ({
  mode: "paint", size: .04, color: "#ffffff", points: [{ x: .1, y: .1 }, { x: .2, y: .2 }], ...overrides,
})

test("a page without layers opens as one implicit layer per effect, with the same stack every time", () => {
  const page = { boxes: [], retouchStrokes: [] }
  const layers = pageLayers(page)
  assert.deepEqual(layers.map(({ kind }) => kind), ["cleanup", "retouch", "text"])
  assert.deepEqual(layers.map(({ name }) => name), [layerKindNames.cleanup, layerKindNames.retouch, layerKindNames.text])
  assert.deepEqual(layers.map(({ id }) => id), ["layer-cleanup", "layer-retouch", "layer-text"])
  assert.deepEqual(layers.map(({ visible }) => visible), [true, true, true])
  assert.deepEqual(layers.map(({ opacity }) => opacity), [1, 1, 1])
  // The implicit stack is stable per page, so the renderer does not rebuild it on every frame.
  assert.equal(pageLayers(page), layers)
  assert.deepEqual(page.layers, undefined, "reading the stack must not write it onto the page")
})

test("strokes saved before layers belong to the implicit retouch layer and new strokes name theirs", () => {
  const legacy = paintStroke()
  const page = { retouchStrokes: [legacy] }
  const retouch = pageLayers(page).find(({ kind }) => kind === "retouch")
  assert.equal(strokeLayer(page, legacy), retouch)
  assert.deepEqual(layerStrokes(page, retouch), [legacy])
  assert.deepEqual(layerStrokes(page, pageLayers(page)[0]), [], "a cleanup layer owns no strokes")

  const stroke = paintStroke()
  addStroke(page, stroke)
  assert.equal(stroke.layerId, retouch.id)
  assert.equal(addStroke(page, paintStroke(), "layer-text").layerId, retouch.id, "a text layer never receives a stroke")

  const second = addLayer(page, "retouch")
  const moved = paintStroke()
  addStroke(page, moved, second.id)
  assert.equal(strokeLayer(page, moved), second)
  assert.deepEqual(layerStrokes(page, second), [moved])
})

test("painting after the last retouch layer was deleted restores a layer instead of losing the stroke", () => {
  const page = { retouchStrokes: [] }
  const retouch = pageLayers(page).find(({ kind }) => kind === "retouch")
  assert.equal(removeLayer(page, retouch.id), true)
  assert.deepEqual(page.layers.map(({ kind }) => kind), ["cleanup", "text"])

  const stroke = paintStroke()
  assert.equal(addStroke(page, stroke), stroke)
  const restored = strokeLayer(page, stroke)
  assert.equal(restored?.kind, "retouch")
  assert.equal(stroke.layerId, restored.id)
  assert.equal(page.layers.indexOf(restored), 1, "the restored brush layer sits below the text layer")
  assert.deepEqual(compositedLayers(page).find(({ layer }) => layer === restored).strokes, [stroke])
})

test("a full stack without a brush layer refuses a stroke instead of storing an invisible one", () => {
  const page = { retouchStrokes: [] }
  const retouch = pageLayers(page).find(({ kind }) => kind === "retouch")
  assert.equal(removeLayer(page, retouch.id), true)
  while (page.layers.length < layerLimit) addLayer(page, "cleanup")
  assert.equal(strokeTarget(page), null)
  assert.equal(canPaint(page), false)

  const stroke = paintStroke()
  assert.equal(addStroke(page, stroke), null)
  assert.deepEqual(page.retouchStrokes, [], "a refused stroke is not stored")
  assert.equal(Object.hasOwn(stroke, "layerId"), false)
})

test("reordering the stack keeps every stroke in the layer it was painted into", () => {
  const page = { retouchStrokes: [] }
  const base = pageLayers(page).find(({ kind }) => kind === "retouch")
  const top = addLayer(page, "retouch")
  const lower = paintStroke()
  const upper = paintStroke()
  addStroke(page, lower, base.id)
  addStroke(page, upper, top.id)

  assert.equal(moveLayer(page, top.id, -1), true)
  assert.deepEqual(page.layers.map(({ id }) => id), ["layer-cleanup", base.id, top.id, "layer-text"], "the new layer moved above the text layer")
  assert.deepEqual(layerStrokes(page, base), [lower])
  assert.deepEqual(layerStrokes(page, top), [upper])
  assert.equal(moveLayer(page, top.id, -1), true)
  assert.deepEqual(page.layers.map(({ id }) => id), ["layer-cleanup", top.id, base.id, "layer-text"])
  assert.deepEqual(layerStrokes(page, base), [lower], "the strokes stay in the layer they were painted into")
  assert.deepEqual(layerStrokes(page, top), [upper])
  assert.equal(moveLayer(page, page.layers[0].id, -1), false, "the bottom layer cannot move down")
  assert.equal(moveLayer(page, page.layers.at(-1).id, 1), false, "the top layer cannot move up")
})

test("hidden layers and hidden strokes drop out of the painted stack without touching the others", () => {
  const page = { boxes: [], retouchStrokes: [] }
  const [cleanup, retouch, text] = pageLayers(page)
  const visible = paintStroke()
  const hidden = paintStroke()
  addStroke(page, visible, retouch.id)
  addStroke(page, hidden, retouch.id)
  setStrokeHidden(hidden, true)

  assert.deepEqual(compositedLayers(page).map(({ layer }) => layer.kind), ["cleanup", "retouch", "text"])
  const retouchGroup = compositedLayers(page).find(({ layer }) => layer.id === retouch.id)
  assert.deepEqual(retouchGroup.strokes, [visible])
  assert.deepEqual(retouchGroup.strokes, layerStrokes(page, retouch).filter((stroke) => stroke.hidden !== true))

  // Hiding the retouch layer leaves the cleanup and text layers in the stack, visible.
  assert.equal(setLayerHidden(retouch, true), true)
  assert.equal(setLayerHidden(retouch, true), false, "hiding a hidden layer changes nothing")
  assert.deepEqual(compositedLayers(page).map(({ layer }) => layer.kind), ["cleanup", "text"])
  assert.equal(hasVisibleLayer(page, "cleanup"), true)
  assert.equal(hasVisibleLayer(page, "text"), true)
  assert.equal(hasVisibleLayer(page, "retouch"), false)
  assert.equal(cleanup.kind, "cleanup")
  assert.equal(text.kind, "text")
})

test("duplicating a layer copies its strokes, deleting a layer deletes them, and one layer always stays", () => {
  const page = { retouchStrokes: [] }
  const retouch = pageLayers(page).find(({ kind }) => kind === "retouch")
  const stroke = paintStroke({ mode: "clone", offsetX: -.1, offsetY: .1 })
  addStroke(page, stroke, retouch.id)

  const copy = duplicateLayer(page, retouch.id)
  assert.equal(page.layers.indexOf(copy), page.layers.indexOf(retouch) + 1, "the copy sits directly above its source")
  assert.equal(copy.name, `${retouch.name} (bản sao)`)
  assert.deepEqual(layerStrokes(page, retouch), [stroke])
  const copied = layerStrokes(page, copy)
  assert.equal(copied.length, 1)
  assert.notEqual(copied[0], stroke)
  assert.equal(copied[0].layerId, copy.id)
  assert.deepEqual(copied[0].points, stroke.points)

  assert.equal(removeLayer(page, copy.id), true)
  assert.deepEqual(layerStrokes(page, copy), [])
  assert.deepEqual(page.retouchStrokes, [stroke], "deleting the duplicate leaves the original stroke")
  assert.equal(removeLayer(page, retouch.id), true)
  assert.deepEqual(page.retouchStrokes, [], "deleting a layer deletes the strokes it owns")
  assert.deepEqual(page.layers.map(({ kind }) => kind), ["cleanup", "text"])

  assert.equal(removeLayer(page, page.layers[0].id), true)
  assert.equal(removeLayer(page, page.layers[0].id), false, "the last layer cannot be deleted")
  assert.equal(page.layers.length, 1)
})

test("a stroke can be hidden, deleted and retargeted one at a time", () => {
  const page = { retouchStrokes: [] }
  const retouch = pageLayers(page).find(({ kind }) => kind === "retouch")
  const first = addStroke(page, paintStroke())
  const second = addStroke(page, paintStroke({ mode: "inpaint" }))
  const third = addStroke(page, paintStroke({ mode: "erase" }))
  assert.deepEqual(page.retouchStrokes, [first, second, third])

  assert.equal(removeStroke(page, second), true)
  assert.deepEqual(page.retouchStrokes, [first, third], "deleting a middle stroke keeps the ones around it")
  assert.equal(removeStroke(page, second), false)

  assert.equal(setStrokeHidden(third, true), true)
  assert.equal(compositedLayers(page).find(({ layer }) => layer.id === retouch.id).strokes.includes(third), false)

  const other = addLayer(page, "retouch")
  assert.equal(retargetStroke(page, third, other.id), true)
  assert.equal(strokeLayer(page, third), other)
  assert.equal(retargetStroke(page, third, other.id), false, "retargeting to the current layer changes nothing")
  assert.equal(retargetStroke(page, first, pageLayers(page)[0].id), false, "a cleanup layer cannot receive a stroke")

  assert.equal(strokeLabel(first, 0, 24), "#1 · Cọ vẽ · 24px")
  assert.equal(strokeLabel(second, 2, 0), "#3 · Inpaint")
})

test("renaming and opacity are validated, and a layer stack serialises only what differs", () => {
  const layers = defaultLayers()
  assert.equal(serializeLayers(layers), undefined, "the default stack is not written")
  assert.equal(layersEqualDefault(layers), true)

  const renamed = structuredClone(layers)
  assert.equal(renameLayer(renamed[2], "  Thoại phụ  "), true)
  assert.equal(renamed[2].name, "Thoại phụ")
  assert.equal(renameLayer(renamed[2], "   "), false)
  assert.equal(renameLayer(renamed[2], "Thoại phụ"), false)

  const hidden = structuredClone(layers)
  assert.equal(setLayerHidden(hidden[1], true), true)
  assert.equal(setLayerOpacity(hidden[0], .4), true)
  assert.equal(setLayerOpacity(hidden[0], 4), true)
  assert.equal(hidden[0].opacity, 1, "opacity is clamped")
  assert.equal(setLayerOpacity(hidden[0], .4), true)

  const stack = serializeLayers([renamed[2], hidden[0], hidden[1], hidden[2]])
  assert.deepEqual(stack.map(({ kind }) => kind), ["text", "cleanup", "retouch", "text"])
  assert.deepEqual(stack[0], { id: "layer-text", kind: "text", name: "Thoại phụ" })
  assert.deepEqual(stack[1], { id: "layer-cleanup", kind: "cleanup", opacity: .4 })
  assert.deepEqual(stack[2], { id: "layer-retouch", kind: "retouch", visible: false })
  assert.equal(layersEqualDefault(stack), false)
})

test("layer validation rejects malformed stacks and expands the defaults back", () => {
  assert.equal(validateLayers(undefined), undefined)
  const layers = defaultLayers()
  assert.deepEqual(validateLayers([
    { id: "layer-cleanup", kind: "cleanup" },
    { id: "layer-retouch", kind: "retouch", name: "  Cọ chính  ", opacity: .5 },
    { id: "layer-text", kind: "text", visible: false },
  ]).map(({ name, opacity, visible }) => [name, opacity, visible]), [
    ["Nền đã xoá chữ", 1, true],
    ["Cọ chính", .5, true],
    ["Lớp chữ", 1, false],
  ])
  assert.equal(validateLayers([]), null)
  assert.equal(validateLayers([{ id: "layer-cleanup", kind: "paint" }]), null)
  assert.equal(validateLayers([{ id: "nope", kind: "cleanup" }]), null)
  assert.equal(validateLayers([{ id: "layer-a", kind: "cleanup" }]), null, "the id must name its kind")
  assert.equal(validateLayers([{ id: "layer-cleanup", kind: "cleanup" }, { id: "layer-cleanup", kind: "cleanup" }]), null)
  assert.equal(validateLayers([{ id: "layer-cleanup", kind: "cleanup", opacity: 2 }]), null)
  assert.equal(validateLayers([{ id: "layer-cleanup", kind: "cleanup", visible: "yes" }]), null)
  assert.equal(validateLayers([{ id: "layer-cleanup", kind: "cleanup", name: "   " }]), null)
  assert.equal(validateLayers(Array.from({ length: layerLimit + 1 }, (_, index) => ({ id: `layer-cleanup-${index}`, kind: "cleanup" }))), null)
  assert.equal(validateLayers(layers).length, 3)
})

test("the native exporter only accepts an opaque stack with every text layer on top", () => {
  const page = { boxes: [], retouchStrokes: [] }
  assert.equal(layersNativeFriendly(page), true)

  const translucent = { ...page, layers: defaultLayers() }
  setLayerOpacity(translucent.layers[1], .5)
  assert.equal(layersNativeFriendly(translucent), false)

  const textBelow = { ...page, layers: defaultLayers() }
  moveLayer(textBelow, "layer-text", -1)
  assert.equal(layersNativeFriendly(textBelow), false)

  const textAboveOnly = { ...page, layers: defaultLayers() }
  moveLayer(textAboveOnly, "layer-text", 1)
  assert.equal(layersNativeFriendly(textAboveOnly), true, "the top layer cannot move up")

  const hiddenTranslation = { ...page, layers: defaultLayers() }
  setLayerHidden(hiddenTranslation.layers[1], true)
  assert.equal(layersNativeFriendly(hiddenTranslation), true, "a hidden layer is simply absent")
})
