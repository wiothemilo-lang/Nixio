import assert from "node:assert/strict"
import { webcrypto } from "node:crypto"
import test from "node:test"
import { autoFitBox, drawPage, makeBox, psdTextLayer, scanSourceImage, textOverflows } from "../src/canvas.js"
import { allFonts, psdFontName, registerFontName } from "../src/fonts.js"

globalThis.crypto ??= webcrypto

function installCanvasMock() {
  const originalDocument = globalThis.document
  const ops = []
  const images = []
  const makeContext = () => ({
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineJoin: "",
    miterLimit: 0,
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    clip() {},
    rect() {},
    moveTo() {},
    arcTo() {},
    ellipse(...args) { ops.push(["ellipse", ...args]) },
    fill() { ops.push(["fill", this.fillStyle]) },
    fillRect(...args) { ops.push(["fillRect", this.fillStyle, ...args]) },
    clearRect() {},
    drawImage(image) { images.push(image) },
    strokeText(text) { ops.push(["strokeText", text, this.strokeStyle, this.lineWidth, this.shadowBlur, this.shadowColor]) },
    fillText(text) { ops.push(["fillText", text, this.fillStyle, this.font, this.shadowBlur, this.shadowColor]) },
    measureText(text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 16)
      return { width: text.length * size * .6 }
    },
  })
  globalThis.document = {
    createElement() {
      return { width: 0, height: 0, getContext: makeContext }
    },
  }
  return { ops, images, restore: () => { globalThis.document = originalDocument } }
}

test("drawPage renders stroke, uppercase, ellipse shape and vertical text cleanly", (t) => {
  const { ops, restore } = installCanvasMock()
  t.after(restore)

  const canvas = document.createElement("canvas")
  const page = {
    image: { naturalWidth: 400, naturalHeight: 600 },
    boxes: [
      {
        ...makeBox({ image: { naturalWidth: 400, naturalHeight: 600 } }, { x: .1, y: .1, w: .4, h: .2 }, "xin chào"),
        bold: true, italic: true, uppercase: true, strokeWidth: 2, strokeColor: "#00ff00",
        fill: true, fillShape: "ellipse", fillColor: "#112233",
      },
      {
        ...makeBox({ image: { naturalWidth: 400, naturalHeight: 600 } }, { x: .6, y: .1, w: .2, h: .4 }, "縦書き"),
        vertical: true, fill: false,
      },
    ],
  }
  drawPage(canvas, page)
  assert.ok(ops.some(([op]) => op === "ellipse"))
  assert.ok(ops.some(([op, color]) => op === "fill" && color === "#112233"))
  assert.ok(ops.some(([op, text, color, width]) => op === "strokeText" && text === "XIN CHÀO" && color === "#00ff00" && width === 4))
  assert.ok(ops.some(([op, text, _color, font]) => op === "fillText" && text === "XIN CHÀO" && font.includes("italic bold")))
  assert.ok(ops.some(([op, text]) => op === "fillText" && text === "縦"))
  assert.ok(ops.some(([op, text]) => op === "fillText" && text === "書"))
  assert.ok(ops.some(([op, text]) => op === "fillText" && text === "き"))

  const beforeLen = ops.length
  drawPage(canvas, page, { showCleanup: false, showText: false })
  assert.equal(ops.length, beforeLen)
})

test("autoFitBox picks the largest non-overflowing font size for horizontal and vertical boxes", (t) => {
  const { restore } = installCanvasMock()
  t.after(restore)
  const page = { image: { naturalWidth: 500, naturalHeight: 500 } }
  const hBox = { ...makeBox(page, { x: .1, y: .1, w: .4, h: .15 }, "Một câu thoại vừa phải"), size: 120 }
  assert.equal(textOverflows(page, hBox), true)
  const fittedH = autoFitBox(page, hBox)
  assert.equal(textOverflows(page, { ...hBox, size: fittedH }), false)
  assert.equal(textOverflows(page, { ...hBox, size: fittedH + 1 }), true)

  const vBox = { ...makeBox(page, { x: .1, y: .1, w: .15, h: .4 }, "こんにちは世界"), vertical: true, size: 100 }
  const fittedV = autoFitBox(page, vBox)
  assert.equal(textOverflows(page, { ...vBox, size: fittedV }), false)
  assert.equal(textOverflows(page, { ...vBox, size: fittedV + 1 }), true)
})

test("hiding cleanup paints the original page without sampling cleanup regions", (t) => {
  const { images, restore } = installCanvasMock()
  t.after(restore)
  const canvas = document.createElement("canvas")
  const originalImage = { naturalWidth: 400, naturalHeight: 600 }
  const page = {
    image: { naturalWidth: 400, naturalHeight: 600 },
    originalImage,
    boxes: [{ cleanup: true, x: .1, y: .1, w: .3, h: .2 }],
  }
  // The fake Canvas intentionally has no getImageData method.
  assert.equal(drawPage(canvas, page, { showCleanup: false, showText: false }), null)
  assert.equal(images[0], originalImage, "compare mode must show the untouched scan")
})

test("scanSourceImage only uses the original scan when cleanup is hidden", () => {
  const layers = [
    { id: "layer-cleanup", kind: "cleanup", visible: true, opacity: 1 },
    { id: "layer-retouch", kind: "retouch", visible: true, opacity: 1 },
    { id: "layer-text", kind: "text", visible: true, opacity: 1 },
  ]
  const image = { naturalWidth: 10, naturalHeight: 10 }
  const originalImage = { naturalWidth: 10, naturalHeight: 10 }
  const page = { layers, image, originalImage }
  assert.equal(scanSourceImage(page), image)
  assert.equal(scanSourceImage(page, { showCleanup: false }), originalImage)
  layers[0].visible = false
  assert.equal(scanSourceImage(page), originalImage)
  assert.equal(scanSourceImage({ image, originalImage: null }, { showCleanup: false }), image)
})

test("fonts helper registers custom font names and maps PostScript font names safely", () => {
  assert.equal(psdFontName("Arial"), "ArialMT")
  assert.equal(registerFontName("Manga Comic!"), "Manga Comic!")
  assert.ok(allFonts().includes("Manga Comic!"))
  assert.equal(psdFontName("Manga Comic!"), "MangaComic")
  assert.equal(psdFontName("日本語"), "ArialMT")
})

test("drawPage renders text shadows and psdTextLayer serializes stroke and dropShadow effects for ag-psd", async (t) => {
  const { ops, restore } = installCanvasMock()
  t.after(restore)
  const canvas = document.createElement("canvas")
  canvas.width = 400
  canvas.height = 600
  const page = {
    image: { naturalWidth: 400, naturalHeight: 600 },
    boxes: [
      {
        ...makeBox({ image: { naturalWidth: 400, naturalHeight: 600 } }, { x: .1, y: .1, w: .4, h: .2 }, "Bóng chữ"),
        strokeWidth: 3, strokeColor: "#ffffff", shadowBlur: 6, shadowColor: "#112233", fill: false,
      },
    ],
  }
  drawPage(canvas, page)
  assert.ok(ops.some(([op, text, , , blur, color]) => op === "fillText" && text === "Bóng chữ" && blur === 6 && color === "#112233"))

  const layer = psdTextLayer(canvas, page.boxes[0])
  assert.equal(layer.effects.stroke[0].enabled, true)
  assert.equal(layer.effects.stroke[0].size.value, 3)
  assert.equal(layer.effects.stroke[0].fillType, "color")
  assert.equal(layer.effects.dropShadow[0].enabled, true)
  assert.equal(layer.effects.dropShadow[0].size.value, 6)

  const { writePsd, readPsd } = await import("ag-psd")
  const buffer = writePsd({ width: 400, height: 600, children: [layer] })
  const parsed = readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: true })
  assert.equal(parsed.children[0].effects.stroke[0].size.value, 3)
  assert.equal(parsed.children[0].effects.dropShadow[0].size.value, 6)
})
