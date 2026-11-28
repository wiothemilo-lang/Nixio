import { psdFontName } from "./fonts.js"
import { compositedLayers, hasVisibleLayer, layersNativeFriendly, strokeVisible } from "./layers.js"
import { nativeCapabilities, runNativeTask } from "./native.js"
import { paintRedraw, redrawLayout } from "./redraw.js"
import { paintRetouchStrokes, waitForNativeRetouch } from "./retouch.js"
import { fitBoxFontSize } from "./tools.js"

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function makeBox(page, rectangle, text = "Lời thoại mới", font = "Arial") {
  return {
    id: crypto.randomUUID(),
    ...rectangle,
    text,
    size: clamp(Math.round(page.image.naturalWidth * 0.033), 12, 400),
    font,
    color: "#171717",
    align: "center",
    rotation: 0,
    fill: true,
  }
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

function baseCanvas(page, image = page.image) {
  const canvas = makeCanvas(image.naturalWidth, image.naturalHeight)
  canvas.getContext("2d").drawImage(image, 0, 0)
  return canvas
}

function displayText(box) {
  return box.uppercase ? box.text.toUpperCase() : box.text
}

function fontSpec(box) {
  return `${box.italic ? "italic " : ""}${box.bold ? "bold " : ""}${box.size}px "${box.font}", sans-serif`
}

function wrap(context, text, width) {
  return text.split(/\r?\n/).flatMap((paragraph) => {
    const lines = []
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? line + " " + word : word
      if (line && context.measureText(candidate).width > width) {
        lines.push(line)
        line = ""
      }
      if (context.measureText(word).width > width) {
        for (const char of word) {
          if (line && context.measureText(line + char).width > width) {
            lines.push(line)
            line = ""
          }
          line += char
        }
      } else {
        line = line ? line + " " + word : word
      }
    }
    lines.push(line)
    return lines
  })
}

export function ellipseChordWidth(innerW, innerH, lineCenterY) {
  const b = Math.max(1, innerH / 2)
  const yNorm = Math.min(0.98, Math.abs(lineCenterY) / b)
  return Math.max(1, innerW * Math.sqrt(Math.max(0.04, 1 - yNorm * yNorm)))
}

function wrapIntoLineWidths(context, text, widths) {
  const lines = []
  const maxSlots = widths.length
  const widthAt = (idx) => widths[Math.min(idx, maxSlots - 1)]
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ""
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const limit = widthAt(lines.length)
      const candidate = line ? line + " " + word : word
      if (line && context.measureText(candidate).width > limit) {
        lines.push(line)
        line = ""
      }
      const nextLimit = widthAt(lines.length)
      if (context.measureText(word).width > nextLimit) {
        for (const char of word) {
          const charLimit = widthAt(lines.length)
          if (line && context.measureText(line + char).width > charLimit) {
            lines.push(line)
            line = ""
          }
          line += char
        }
      } else {
        line = line ? line + " " + word : word
      }
    }
    lines.push(line)
  }
  return lines
}

function wrapEllipse(context, text, innerW, innerH, lineHeight) {
  const maxRows = Math.max(1, Math.min(40, Math.floor(innerH / Math.max(1, lineHeight))))
  let best = null
  for (let rows = 1; rows <= maxRows; rows++) {
    const startY = -((rows - 1) * lineHeight) / 2
    const widths = Array.from({ length: rows }, (_, i) => {
      const cy = startY + i * lineHeight
      // Check both top and bottom edges of the line band against the ellipse chord (like PhotoCraft AreaShape).
      const topW = ellipseChordWidth(innerW, innerH, cy - lineHeight * 0.35)
      const botW = ellipseChordWidth(innerW, innerH, cy + lineHeight * 0.35)
      return Math.min(topW, botW)
    })
    const lines = wrapIntoLineWidths(context, text, widths)
    if (lines.length <= rows) {
      const actualStartY = -((lines.length - 1) * lineHeight) / 2
      const lineWidths = lines.map((_, i) => {
        const cy = actualStartY + i * lineHeight
        return Math.min(
          ellipseChordWidth(innerW, innerH, cy - lineHeight * 0.35),
          ellipseChordWidth(innerW, innerH, cy + lineHeight * 0.35),
        )
      })
      best = { lines, lineWidths }
      break
    }
    best = { lines, lineWidths: lines.map((_, i) => widths[Math.min(i, widths.length - 1)]) }
  }
  return best ?? { lines: wrap(context, text, innerW), lineWidths: null }
}

function drawWarpedLine(context, line, centerX, centerY, spanWidth, warp, warpAmount, strokeWidth) {
  const chars = Array.from(line)
  if (!chars.length) return
  const widths = chars.map((ch) => context.measureText(ch).width)
  const totalW = widths.reduce((sum, w) => sum + w, 0)
  if (totalW <= 0) return

  const bend = (clamp(Number(warpAmount) || 0, -50, 50) / 100) * Math.max(24, spanWidth * 0.45)
  let cursor = -totalW / 2
  const halfSpan = Math.max(1, totalW / 2)

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const cw = widths[i]
    const localX = cursor + cw / 2
    cursor += cw
    const u = clamp(localX / halfSpan, -1, 1)
    let dy = 0
    let slope = 0
    if (warp === "arc" || warp === "arcDown") {
      const sign = warp === "arcDown" ? 1 : -1
      dy = sign * bend * (1 - u * u)
      slope = sign * bend * (-2 * u) / halfSpan
    } else if (warp === "wave") {
      dy = Math.sin(u * Math.PI) * bend * 0.7
      slope = (Math.cos(u * Math.PI) * Math.PI * bend * 0.7) / halfSpan
    }
    const angle = Math.atan(slope)
    context.save()
    context.translate(centerX + localX, centerY + dy)
    context.rotate(angle)
    context.textAlign = "center"
    if (strokeWidth > 0) context.strokeText(ch, 0, 0)
    context.fillText(ch, 0, 0)
    context.restore()
  }
}

function wrapVertical(text, maxHeight, step) {
  const perColumn = Math.max(1, Math.floor(maxHeight / Math.max(1, step)))
  const columns = []
  for (const paragraph of text.split(/\r?\n/)) {
    const chars = Array.from(paragraph.trim())
    if (!chars.length) {
      columns.push([""])
      continue
    }
    for (let index = 0; index < chars.length; index += perColumn) {
      columns.push(chars.slice(index, index + perColumn))
    }
  }
  return columns.length ? columns : [[""]]
}

function geometry(context, box, width, height) {
  const w = box.w * width
  const h = box.h * height
  const strokePad = Math.max(0, box.strokeWidth ?? 0)
  const padding = Math.max(2, Math.min(w, h) * 0.07) + strokePad
  context.font = fontSpec(box)
  const lineSpacing = box.lineHeight ?? 1.15
  const lineHeight = box.size * lineSpacing
  const text = displayText(box)
  const angle = box.rotation * Math.PI / 180
  const cx = (box.x + box.w / 2) * width
  const cy = (box.y + box.h / 2) * height

  if (box.vertical) {
    const columns = wrapVertical(text, Math.max(box.size, h - padding * 2), lineHeight)
    const columnStep = box.size * Math.max(1, lineSpacing)
    return {
      w, h, padding, vertical: true, columns, lineHeight, columnStep, cx, cy, angle,
      lines: columns.map((column) => column.join("")),
      offsetX: 0,
      offsetY: 0,
    }
  }

  const innerW = Math.max(1, w - padding * 2)
  const innerH = Math.max(1, h - padding * 2)
  if (box.bubbleFit) {
    const { lines, lineWidths } = wrapEllipse(context, text, innerW, innerH, lineHeight)
    return {
      w, h, padding, vertical: false, lines, lineWidths, lineHeight, cx, cy, angle,
      offsetX: { left: -w / 2 + padding, center: 0, right: w / 2 - padding }[box.align],
      offsetY: -(lines.length - 1) * lineHeight / 2,
    }
  }

  const lines = wrap(context, text, innerW)
  return {
    w, h, padding, vertical: false, lines, lineWidths: null, lineHeight, cx, cy, angle,
    offsetX: { left: -w / 2 + padding, center: 0, right: w / 2 - padding }[box.align],
    offsetY: -(lines.length - 1) * lineHeight / 2,
  }
}

function drawFillShape(context, g, box) {
  context.fillStyle = box.fillColor || "#fff"
  if (box.fillShape === "ellipse") {
    context.beginPath()
    context.ellipse(0, 0, Math.max(1, g.w / 2), Math.max(1, g.h / 2), 0, 0, Math.PI * 2)
    context.fill()
    return
  }
  if (box.fillShape === "rounded") {
    const radius = Math.min(g.w, g.h) * 0.16
    const x = -g.w / 2
    const y = -g.h / 2
    context.beginPath()
    context.moveTo(x + radius, y)
    context.arcTo(x + g.w, y, x + g.w, y + g.h, radius)
    context.arcTo(x + g.w, y + g.h, x, y + g.h, radius)
    context.arcTo(x, y + g.h, x, y, radius)
    context.arcTo(x, y, x + g.w, y, radius)
    context.closePath()
    context.fill()
    return
  }
  context.fillRect(-g.w / 2, -g.h / 2, g.w, g.h)
}

function drawBox(canvas, box, {
  background = true, text = true, width = canvas.width, height = canvas.height, left = 0, top = 0,
} = {}) {
  const context = canvas.getContext("2d")
  context.save()
  const g = geometry(context, box, width, height)
  context.translate(g.cx - left, g.cy - top)
  context.rotate(g.angle)
  context.beginPath()
  context.rect(-g.w / 2, -g.h / 2, g.w, g.h)
  context.clip()
  if (background && box.fill) drawFillShape(context, g, box)
  if (text) {
    const strokeWidth = Math.max(0, box.strokeWidth ?? 0)
    const shadowBlur = Math.max(0, box.shadowBlur ?? 0)
    if (strokeWidth > 0) {
      context.strokeStyle = box.strokeColor || "#ffffff"
      context.lineWidth = strokeWidth * 2
      context.lineJoin = "round"
      context.miterLimit = 2
    }
    if (shadowBlur > 0) {
      context.shadowColor = box.shadowColor || "#000000"
      context.shadowBlur = shadowBlur
      context.shadowOffsetX = 0
      context.shadowOffsetY = 0
    }
    context.fillStyle = box.color
    context.textBaseline = "middle"
    if (g.vertical) {
      context.textAlign = "center"
      const startX = (g.columns.length - 1) * g.columnStep / 2
      g.columns.forEach((column, colIndex) => {
        const x = startX - colIndex * g.columnStep
        const colHeight = (column.length - 1) * g.lineHeight
        const startY = box.align === "left"
          ? -g.h / 2 + g.padding + box.size / 2
          : box.align === "right"
            ? g.h / 2 - g.padding - box.size / 2 - colHeight
            : -colHeight / 2
        column.forEach((char, rowIndex) => {
          const y = startY + rowIndex * g.lineHeight
          if (strokeWidth > 0) context.strokeText(char, x, y)
          context.fillText(char, x, y)
        })
      })
    } else {
      const hasWarp = box.warp && box.warp !== "none" && Number(box.warpAmount || 0) !== 0
      context.textAlign = box.align
      g.lines.forEach((line, index) => {
        const y = g.offsetY + index * g.lineHeight
        if (hasWarp) {
          const lineW = g.lineWidths?.[index] ?? Math.max(1, g.w - g.padding * 2)
          const cxLine = box.align === "center"
            ? 0
            : box.align === "left"
              ? -lineW / 2 + context.measureText(line).width / 2
              : lineW / 2 - context.measureText(line).width / 2
          drawWarpedLine(context, line, cxLine, y, g.w - g.padding * 2, box.warp, box.warpAmount, strokeWidth)
        } else {
          const lineOffsetX = g.lineWidths
            ? (box.align === "center" ? 0 : box.align === "left" ? -g.lineWidths[index] / 2 : g.lineWidths[index] / 2)
            : g.offsetX
          if (strokeWidth > 0) context.strokeText(line, lineOffsetX, y)
          context.fillText(line, lineOffsetX, y)
        }
      })
    }
  }
  context.restore()
}

// The scan the page paints first: while cleanup is in effect it is the working scan, and hiding
// cleanup (by layer or by the compare master switch) shows the untouched scan the page arrived with.
export function scanSourceImage(page, { showCleanup = true } = {}) {
  return (!showCleanup || !hasVisibleLayer(page, "cleanup")) && page.originalImage ? page.originalImage : page.image
}

function paintCleanupLayer(canvas, patches, opacity) {
  if (!patches.length || opacity <= 0) return false
  if (opacity >= 1) {
    paintRedraw(canvas, patches)
    return true
  }
  const layer = makeCanvas(canvas.width, canvas.height)
  paintRedraw(layer, patches)
  const context = canvas.getContext("2d")
  context.save()
  context.globalAlpha = opacity
  context.drawImage(layer, 0, 0)
  context.restore()
  return true
}

function paintTextLayer(canvas, page, opacity) {
  if (!page.boxes.length || opacity <= 0) return false
  const context = canvas.getContext("2d")
  context.save()
  context.globalAlpha = opacity
  page.boxes.forEach((box) => drawBox(canvas, box))
  context.restore()
  return true
}

function visibleRetouchStrokes(page) {
  return (page.retouchStrokes ?? []).filter(strokeVisible)
}

// Paints the stack bottom to top. `showCleanup` and `showText` stay as the master switches compare
// mode uses; per-layer visibility and opacity are applied on top of them.
function paintPage(canvas, page, patches, { showCleanup = true, showText = true } = {}) {
  const width = page.image.naturalWidth
  const height = page.image.naturalHeight
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  const context = canvas.getContext("2d")
  context.clearRect(0, 0, width, height)
  context.drawImage(scanSourceImage(page, { showCleanup }), 0, 0)
  for (const { layer, opacity, strokes } of compositedLayers(page)) {
    if (layer.kind === "cleanup") {
      if (showCleanup) paintCleanupLayer(canvas, patches, opacity)
    } else if (layer.kind === "retouch") {
      if (showCleanup) paintRetouchStrokes(canvas, page, { strokes, opacity, key: layer.id })
    } else if (showText) {
      paintTextLayer(canvas, page, opacity)
    }
  }
}

export function drawPage(canvas, page, options) {
  if (options?.showCleanup === false) {
    paintPage(canvas, page, [], options)
    return null
  }
  const redraw = redrawLayout(page)
  paintPage(canvas, page, redraw.patches, options)
  return redraw.pending
}

function hexToRgb(hex) {
  const [r, g, b] = (hex || "#000000").slice(1).match(/../g).map((value) => parseInt(value, 16))
  return { r, g, b }
}

function croppedLayer({ width, height }, box, options) {
  const angle = box.rotation * Math.PI / 180
  const pad = Math.ceil((box.strokeWidth ?? 0) + (box.shadowBlur ?? 0) * 1.5)
  const halfWidth = (Math.abs(Math.cos(angle)) * box.w * width + Math.abs(Math.sin(angle)) * box.h * height) / 2 + pad
  const halfHeight = (Math.abs(Math.sin(angle)) * box.w * width + Math.abs(Math.cos(angle)) * box.h * height) / 2 + pad
  const cx = (box.x + box.w / 2) * width
  const cy = (box.y + box.h / 2) * height
  const left = Math.max(0, Math.floor(cx - halfWidth))
  const top = Math.max(0, Math.floor(cy - halfHeight))
  const right = Math.min(width, Math.ceil(cx + halfWidth))
  const bottom = Math.min(height, Math.ceil(cy + halfHeight))
  const crop = makeCanvas(Math.max(1, right - left), Math.max(1, bottom - top))
  drawBox(crop, box, { width, height, left, top, ...options })
  return { canvas: crop, left, top }
}

export function psdTextLayer(canvas, box) {
  const g = geometry(canvas.getContext("2d"), box, canvas.width, canvas.height)
  const cos = Math.cos(g.angle)
  const sin = Math.sin(g.angle)
  const localX = g.vertical ? (g.columns.length - 1) * g.columnStep / 2 : g.offsetX
  const localY = g.vertical ? -g.h / 2 + g.padding : g.offsetY + box.size * 0.34
  const effects = {}
  const strokeWidth = Math.max(0, box.strokeWidth ?? 0)
  if (strokeWidth > 0) {
    effects.stroke = [{
      enabled: true,
      present: true,
      size: { units: "Pixels", value: strokeWidth },
      position: "outside",
      fillType: "color",
      color: hexToRgb(box.strokeColor || "#ffffff"),
      opacity: 1,
    }]
  }
  const shadowBlur = Math.max(0, box.shadowBlur ?? 0)
  if (shadowBlur > 0) {
    effects.dropShadow = [{
      enabled: true,
      present: true,
      size: { units: "Pixels", value: shadowBlur },
      distance: { units: "Pixels", value: 0 },
      angle: 90,
      color: hexToRgb(box.shadowColor || "#000000"),
      opacity: 1,
    }]
  }
  return {
    name: box.text.split(/\r?\n/)[0].slice(0, 72),
    text: {
      text: g.vertical ? g.columns.map((column) => column.join("")).join("\n") : g.lines.join("\n"),
      ...(box.vertical && { orientation: "vertical" }),
      transform: [cos, sin, -sin, cos, g.cx + localX * cos - localY * sin, g.cy + localX * sin + localY * cos],
      style: {
        font: { name: psdFontName(box.font) },
        fontSize: box.size,
        leading: g.lineHeight,
        fauxBold: Boolean(box.bold),
        fauxItalic: Boolean(box.italic),
        fillColor: hexToRgb(box.color),
      },
      paragraphStyle: { justification: box.align },
    },
    ...(Object.keys(effects).length && { effects }),
  }
}

// The cleanup and retouch layers over transparency, in stack order, for the PSD layer tree.
function paintEffects(canvas, page, patches) {
  for (const { layer, opacity, strokes } of compositedLayers(page)) {
    if (layer.kind === "cleanup") paintCleanupLayer(canvas, patches, opacity)
    else if (layer.kind === "retouch") paintRetouchStrokes(canvas, page, { strokes, opacity, key: layer.id })
  }
}

// Returns null when the stack needs an order or an opacity the native compositor cannot express, so
// the caller falls back to the renderer instead of exporting something the user did not see.
export async function nativePageLayers(page) {
  if (!layersNativeFriendly(page)) return null
  const redraw = redrawLayout(page, { cancellable: false })
  await Promise.all([redraw.pending, waitForNativeRetouch(page)])
  const base = baseCanvas(page, scanSourceImage(page))
  const text = makeCanvas(base.width, base.height)
  if (hasVisibleLayer(page, "text")) page.boxes.forEach((box) => drawBox(text, box))
  const read = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data
  const retouchStrokes = hasVisibleLayer(page, "retouch") ? visibleRetouchStrokes(page) : []
  let patches = []
  if (retouchStrokes.length) {
    // One full-size patch keeps the painted layers in the order the stack shows them.
    const effects = makeCanvas(base.width, base.height)
    paintEffects(effects, page, redraw.patches)
    patches = [{ patch: effects, left: 0, top: 0 }]
  } else if (hasVisibleLayer(page, "cleanup")) {
    patches = [...redraw.patches]
  }
  if (patches.reduce((sum, { patch }) => sum + patch.width * patch.height, 0) > base.width * base.height) {
    const merged = makeCanvas(base.width, base.height)
    paintRedraw(merged, patches)
    patches = [{ patch: merged, left: 0, top: 0 }]
  }
  const parts = [read(base), read(text), ...patches.map(({ patch }) => read(patch))]
  const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { data.set(part, offset); offset += part.length }
  return {
    options: { width: base.width, height: base.height, patches: patches.map(({ patch, left, top }) => ({
      left, top, width: patch.width, height: patch.height,
    })) },
    data,
  }
}

export async function exportPage(page, format) {
  if (format === "png" && globalThis.khungThoaiDesktop?.native) {
    if (await nativeCapabilities()) {
      const layers = await nativePageLayers(page)
      if (layers) {
        const response = await runNativeTask("png", layers.options, layers.data)
        return new Blob([response.data], { type: "image/png" })
      }
    }
  }
  const redraw = redrawLayout(page, { cancellable: false })
  await Promise.all([redraw.pending, waitForNativeRetouch(page)])
  const composite = makeCanvas(page.image.naturalWidth, page.image.naturalHeight)
  paintPage(composite, page, redraw.patches)
  if (format === "png") {
    const result = await new Promise((resolve) => composite.toBlob(resolve, "image/png"))
    if (!result) throw new Error("Không thể tạo ảnh PNG.")
    return result
  }
  const { writePsd } = await import("ag-psd")
  const base = baseCanvas(page, scanSourceImage(page))
  const children = [{ name: "Ảnh gốc", canvas: base }]
  // Hidden layers are simply absent from the file, so the exported layer tree matches the canvas.
  if (hasVisibleLayer(page, "cleanup") || (hasVisibleLayer(page, "retouch") && visibleRetouchStrokes(page).length)) {
    const cleaned = makeCanvas(base.width, base.height)
    paintEffects(cleaned, page, redraw.patches)
    children.push({ name: "Nền đã xóa chữ", canvas: cleaned })
  }
  const dialogue = []
  for (const box of hasVisibleLayer(page, "text") ? page.boxes : []) {
    const title = box.text.split(/\r?\n/)[0].slice(0, 72)
    if (format === "raster") {
      children.push({ name: title, ...croppedLayer(base, box) })
      continue
    }
    if (box.fill) {
      dialogue.push({ name: "Nền / " + title, ...croppedLayer(base, box, { text: false }) })
    }
    dialogue.push({ ...psdTextLayer(composite, box), ...croppedLayer(base, box, { background: false }) })
  }
  if (dialogue.length) children.push({ name: "Thoại", opened: true, children: dialogue })
  const psd = writePsd({ width: base.width, height: base.height, canvas: composite, children }, { invalidateTextLayers: format === "psd" })
  return new Blob([psd], { type: "image/vnd.adobe.photoshop" })
}

export function textOverflows(page, box, context = document.createElement("canvas").getContext("2d")) {
  const g = geometry(context, box, page.image.naturalWidth, page.image.naturalHeight)
  if (g.vertical) {
    const maxColHeight = Math.max(...g.columns.map((column) => column.length)) * g.lineHeight
    return g.columns.length * g.columnStep > g.w - g.padding * 2 + .01 || maxColHeight > g.h - g.padding * 2 + .01
  }
  return g.lines.length * g.lineHeight > g.h - g.padding * 2 ||
    g.lines.some((line, index) => {
      const limit = g.lineWidths?.[index] ?? (g.w - g.padding * 2)
      return context.measureText(line).width > limit + .01
    })
}

export function autoFitBox(page, box) {
  const context = document.createElement("canvas").getContext("2d")
  return fitBoxFontSize(page, box, (currentPage, candidate) => textOverflows(currentPage, candidate, context))
}
