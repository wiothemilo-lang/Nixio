import { clamp } from "../canvas.js"
import { detectBubbleOnImage } from "../bubble.js"
import { addStroke, canPaint } from "../layers.js"
import { prepareNativeClone, prepareNativeInpaint, samplePixelColor } from "../retouch.js"
import { resizeBox, rotateBox, snapBox } from "../tools.js"
import { resizeGroup } from "../selection.js"

const zoomSteps = [.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4]
const MIN_ZOOM = .1
const MAX_ZOOM = 4
const ZOOM_FACTOR = 1.15

export function setupGestures({
  state,
  byId,
  stage,
  overlays,
  pageCanvas,
  viewport,
  status,
  t = (key) => key,
  checkpoint,
  editorSnapshot,
  commitLiveForm,
  selectedPage,
  selectedBox,
  selectBox,
  toggleSelectBox,
  addBox,
  freezeCleanup,
  rectStyle,
  paintPreview,
  renderCleanupOverlay,
  renderCanvas,
  renderInspector,
  render,
  projectBusy,
  changePage,
}) {
  let gesture
  let pendingPaint
  let spaceHeld = false

  function point(event) {
    const area = pageCanvas.getBoundingClientRect()
    if (!area.width || !area.height) return { x: 0, y: 0 }
    return {
      x: clamp((event.clientX - area.left) / area.width, 0, 1),
      y: clamp((event.clientY - area.top) / area.height, 0, 1),
    }
  }

  function placement(a, b) {
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    if (w < .015 && h < .015) return { x: clamp(a.x - .17, 0, .66), y: clamp(a.y - .08, 0, .84), w: .34, h: .16 }
    return { x: Math.min(a.x, b.x, .97), y: Math.min(a.y, b.y, .97), w: Math.max(.03, w), h: Math.max(.03, h) }
  }

  function clearGuides() {
    overlays.querySelectorAll(".snap-guide").forEach((el) => el.remove())
  }

  function renderGuides(guides) {
    clearGuides()
    for (const guide of guides) {
      const line = document.createElement("div")
      line.className = "snap-guide " + guide.axis
      if (guide.axis === "x") line.style.left = guide.pos * 100 + "%"
      else line.style.top = guide.pos * 100 + "%"
      overlays.append(line)
    }
  }

  function renderCloneMarker() {
    overlays.querySelector(".clone-marker")?.remove()
    if (byId("cleanup-tool").value !== "clone" || !state.cloneSource) return
    const marker = document.createElement("div")
    marker.className = "clone-marker"
    marker.style.left = state.cloneSource.x * 100 + "%"
    marker.style.top = state.cloneSource.y * 100 + "%"
    overlays.append(marker)
  }

  function updateZoomDisplay() {
    byId("zoom-level").textContent = Math.round((state.zoom ?? currentScale()) * 100) + "%"
  }

  function currentScale() {
    const page = selectedPage()
    if (!page) return 1
    if (state.zoom) return state.zoom
    const rendered = pageCanvas.getBoundingClientRect().width
    return rendered > 0 ? rendered / page.image.naturalWidth : 1
  }

  // Steps follow the scale the page really renders at, so leaving a small Fit zooms out instead of
  // jumping up to the first preset step.
  function nextZoomStep(direction) {
    const cur = currentScale()
    const step = direction > 0
      ? zoomSteps.find((value) => value > cur + .02)
      : [...zoomSteps].reverse().find((value) => value < cur - .02)
    return clamp(step ?? cur * (direction > 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR), MIN_ZOOM, MAX_ZOOM)
  }

  function viewportCenter() {
    const area = viewport.getBoundingClientRect()
    return { clientX: area.left + area.width / 2, clientY: area.top + area.height / 2 }
  }

  // Re-scroll so the image point that sat under the anchor stays there after the stage is resized.
  function restoreAnchor(focus, anchor) {
    const area = pageCanvas.getBoundingClientRect()
    if (!area.width || !area.height) return
    viewport.scrollLeft += area.left + focus.x * area.width - anchor.clientX
    viewport.scrollTop += area.top + focus.y * area.height - anchor.clientY
  }

  function setZoom(nextZoom, anchorAt) {
    const page = selectedPage()
    if (!page) return
    const next = clamp(Math.round(nextZoom * 100) / 100, MIN_ZOOM, MAX_ZOOM)
    if (next === state.zoom) return
    const anchor = anchorAt ?? viewportCenter()
    const focus = point(anchor)
    state.zoom = next
    state.fit = false
    byId("fit-page").textContent = "Kích thước gốc"
    renderCanvas()
    restoreAnchor(focus, anchor)
  }

  byId("zoom-in").onclick = () => setZoom(nextZoomStep(1))
  byId("zoom-out").onclick = () => setZoom(nextZoomStep(-1))
  viewport.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !selectedPage()) return
    event.preventDefault()
    const factor = event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
    setZoom(currentScale() * factor, event)
  }, { passive: false })

  function drawInpaintPreview(stroke) {
    const canvas = byId("cleanup-overlay")
    canvas.width = pageCanvas.width
    canvas.height = pageCanvas.height
    const ctx = canvas.getContext("2d")
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = "#0284c7"
    ctx.lineWidth = Math.max(1, stroke.size * Math.min(canvas.width, canvas.height))
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.beginPath()
    const first = stroke.points[0]
    ctx.moveTo(first.x * canvas.width, first.y * canvas.height)
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x * canvas.width, stroke.points[i].y * canvas.height)
    }
    if (stroke.points.length === 1) ctx.lineTo(first.x * canvas.width + .01, first.y * canvas.height)
    ctx.stroke()
  }

  function schedulePaint() {
    pendingPaint ??= requestAnimationFrame(() => {
      pendingPaint = undefined
      const page = selectedPage()
      if (page) paintPreview(page)
    })
  }

  stage.addEventListener("pointerdown", (event) => {
    if (projectBusy()) return
    const page = selectedPage()
    if (!page) return
    const tool = byId("cleanup-tool").value

    // Pan with middle mouse button, Hand tool, or Space+Left click.
    if (event.button === 1 || (event.button === 0 && (tool === "pan" || spaceHeld))) {
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      stage.classList.add("dragging-pan")
      gesture = {
        kind: "pan",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      }
      return
    }
    if (event.button !== 0) return

    commitLiveForm()
    const origin = point(event)

    // Eyedropper tool.
    if (tool === "eyedropper") {
      event.preventDefault()
      const color = samplePixelColor(page.image, origin)
      if (!color) return
      byId("paint-color").value = color
      const readout = byId("eyedropper-readout")
      readout.textContent = color.toUpperCase()
      readout.hidden = false
      if (selectedBox() && event.shiftKey) {
        checkpoint(undefined, { label: "Đổi màu chữ từ hút màu", kind: "form" })
        selectedBox().color = color
        byId("box-color").value = color
        renderCanvas()
        status(`Đã hút màu ${color.toUpperCase()} cho màu chữ.`)
      } else {
        status(`Đã hút màu ${color.toUpperCase()} cho cọ vẽ (giữ Shift+bấm để đổi màu chữ).`)
      }
      return
    }

    // Magic Bubble Click tool.
    if (tool === "bubble") {
      event.preventDefault()
      const rect = detectBubbleOnImage(page.image, origin.x, origin.y)
      if (!rect) {
        status("Không nhận diện được bong bóng thoại sáng tại vị trí vừa bấm.", true)
        return
      }
      addBox(rect)
      status("Đã tạo khung khớp bong bóng thoại.")
      return
    }

    // Paint, Clone Stamp, Smart Inpaint & Retouch Eraser tools.
    if (tool === "paint" || tool === "clone" || tool === "inpaint" || tool === "retouch-erase") {
      event.preventDefault()
      if (tool === "clone" && event.altKey) {
        state.cloneSource = origin
        renderCloneMarker()
        status("Đã đặt điểm nguồn sao chép nền. Giờ kéo cọ để che chữ.")
        return
      }
      if (tool === "clone" && !state.cloneSource) {
        status("Giữ Alt + bấm vào vùng nền mẫu trước khi dùng cọ sao chép.", true)
        return
      }
      if (!canPaint(page, state.layerId)) {
        status(t("status.retouch.noLayer"), true)
        return
      }
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
      const opacity = clamp((Number(byId("paint-opacity").value) || 100) / 100, .05, 1)
      const minDim = Math.min(page.image.naturalWidth, page.image.naturalHeight)
      const stroke = tool === "paint"
        ? { mode: "paint", size: size / minDim, color: byId("paint-color").value, ...(opacity !== 1 && { opacity }), points: [origin] }
        : tool === "inpaint"
          ? { mode: "inpaint", size: size / minDim, ...(opacity !== 1 && { opacity }), points: [origin] }
          : tool === "retouch-erase"
            ? { mode: "erase", size: size / minDim, ...(opacity !== 1 && { opacity }), points: [origin] }
            : {
              mode: "clone", size: size / minDim,
              offsetX: clamp(state.cloneSource.x - origin.x, -1, 1),
              offsetY: clamp(state.cloneSource.y - origin.y, -1, 1),
              ...(byId("clone-seamless")?.checked && { seamless: true }),
              ...(opacity !== 1 && { opacity }),
              points: [origin],
            }
      if (tool === "inpaint") {
        // Draw fast overlay preview during drag, then commit inpaint reconstruction on pointerup.
        gesture = { kind: "inpaint-preview", pointer: event.pointerId, stroke, before }
        drawInpaintPreview(stroke)
      } else {
        addStroke(page, stroke, state.layerId)
        gesture = { kind: "retouch", pointer: event.pointerId, stroke, before }
        paintPreview(page)
      }
      return
    }

    // Rotate handle on active box.
    const rotateEl = event.target.closest?.(".rotate-handle")
    if (tool === "text" && !state.placing && rotateEl) {
      const box = selectedBox()
      if (!box) return
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      const area = pageCanvas.getBoundingClientRect()
      const center = { x: (box.x + box.w / 2) * area.width, y: (box.y + box.h / 2) * area.height }
      gesture = { kind: "rotate", pointer: event.pointerId, box, center, startRotation: box.rotation, before }
      return
    }

    // Resize handle on the primary box; the rest of a multi-selection follows its delta.
    const handleEl = event.target.closest?.(".resize-handle")
    if (tool === "text" && !state.placing && handleEl) {
      const box = selectedBox()
      if (!box) return
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      const before = editorSnapshot()
      if (box.cleanup) freezeCleanup(box)
      const group = state.selectedBoxIds.size > 1
        ? page.boxes.filter((item) => state.selectedBoxIds.has(item.id))
        : []
      if (!group.includes(box)) group.push(box)
      gesture = {
        kind: "resize",
        pointer: event.pointerId,
        box,
        handle: handleEl.dataset.handle,
        origin,
        start: { x: box.x, y: box.y, w: box.w, h: box.h },
        starts: new Map(group.map((item) => [item.id, { x: item.x, y: item.y, w: item.w, h: item.h }])),
        boxes: new Map(group.map((item) => [item.id, item])),
        before,
      }
      return
    }

    const clickedOutline = event.target.closest?.("[data-box]")
    const box = tool === "text"
      ? page.boxes.find((item) => item.id === clickedOutline?.dataset.box)
      : selectedBox()

    if (!box && !state.placing) {
      if (tool === "text" && (state.boxId || state.selectedBoxIds.size)) {
        state.boxId = null
        state.selectedBoxIds.clear()
        renderCanvas()
        renderInspector()
      }
      return
    }
    event.preventDefault()
    if (tool === "text" && box && !state.placing && event.shiftKey) {
      toggleSelectBox(box)
      return
    }
    stage.setPointerCapture(event.pointerId)
    const before = editorSnapshot()

    if (tool !== "text") {
      if (!box) return
      freezeCleanup(box)
      box.cleanup = true
      if (tool !== "region") {
        const size = clamp(Number(byId("brush-size").value) || 20, 1, 200)
        const stroke = { mode: tool, size: size / Math.min(pageCanvas.width, pageCanvas.height), points: [origin] }
        box.cleanupStrokes ??= []
        box.cleanupStrokes.push(stroke)
        gesture = { kind: "cleanup-stroke", pointer: event.pointerId, box, stroke, before }
        renderCleanupOverlay()
        return
      }
    } else if (box && !state.placing) {
      const keepGroup = state.selectedBoxIds.size > 1 && state.selectedBoxIds.has(box.id)
      if (!keepGroup) selectBox(box)
      const moveBoxes = keepGroup
        ? page.boxes.filter((item) => state.selectedBoxIds.has(item.id))
        : [box]
      for (const item of moveBoxes) {
        if (item.cleanup) freezeCleanup(item)
      }
      gesture = {
        kind: "move",
        pointer: event.pointerId,
        box,
        moveBoxes,
        collapseOnClick: keepGroup,
        origin,
        starts: new Map(moveBoxes.map((item) => [item.id, { x: item.x, y: item.y }])),
        moved: false,
        before,
      }
      return
    }

    const draft = document.createElement("div")
    draft.className = "outline draft"
    overlays.append(draft)
    gesture = { kind: "draft", pointer: event.pointerId, origin, draft, cleanupBox: tool === "region" ? box : null, before }
  })

  stage.addEventListener("pointermove", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    if (gesture.kind === "pan") {
      viewport.scrollLeft = gesture.scrollLeft - (event.clientX - gesture.startX)
      viewport.scrollTop = gesture.scrollTop - (event.clientY - gesture.startY)
      return
    }
    const cursor = point(event)
    if (gesture.kind === "inpaint-preview") {
      gesture.stroke.points.push(cursor)
      drawInpaintPreview(gesture.stroke)
      return
    }
    if (gesture.kind === "retouch") {
      gesture.stroke.points.push(cursor)
      schedulePaint()
      return
    }
    if (gesture.kind === "cleanup-stroke") {
      gesture.stroke.points.push(cursor)
      renderCleanupOverlay()
      return
    }
    if (gesture.kind === "rotate") {
      const area = pageCanvas.getBoundingClientRect()
      const pointerPx = { x: event.clientX - area.left, y: event.clientY - area.top }
      gesture.box.rotation = rotateBox(gesture.center, pointerPx, { snap: event.shiftKey })
      byId("box-rotation").value = gesture.box.rotation
      const outline = overlays.querySelector('[aria-current="true"]')
      if (outline) rectStyle(outline, gesture.box)
      schedulePaint()
      return
    }
    if (gesture.kind === "resize") {
      const aspect = pageCanvas.width / Math.max(1, pageCanvas.height)
      const next = resizeBox(
        gesture.start,
        gesture.handle,
        { x: cursor.x - gesture.origin.x, y: cursor.y - gesture.origin.y },
        { rotation: gesture.box.rotation ?? 0, aspect },
      )
      for (const [id, rect] of resizeGroup(gesture.starts, gesture.box.id, next)) {
        const item = gesture.boxes.get(id)
        Object.assign(item, rect)
        const outline = overlays.querySelector(`[data-box="${id}"]`)
        if (outline) rectStyle(outline, item)
      }
      schedulePaint()
      return
    }
    if (gesture.kind === "move") {
      const page = selectedPage()
      if (!page) return
      let dx = cursor.x - gesture.origin.x
      let dy = cursor.y - gesture.origin.y
      // Clamp dx/dy so all moving boxes stay within [0, 1].
      let minDx = -Infinity, maxDx = Infinity, minDy = -Infinity, maxDy = Infinity
      for (const item of gesture.moveBoxes) {
        const st = gesture.starts.get(item.id)
        minDx = Math.max(minDx, -st.x)
        maxDx = Math.min(maxDx, 1 - item.w - st.x)
        minDy = Math.max(minDy, -st.y)
        maxDy = Math.min(maxDy, 1 - item.h - st.y)
      }
      dx = clamp(dx, minDx, maxDx)
      dy = clamp(dy, minDy, maxDy)

      if (!event.altKey) {
        const movingIds = new Set(gesture.moveBoxes.map((item) => item.id))
        const others = page.boxes.filter((item) => !movingIds.has(item.id))
        const minX = Math.min(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).x))
        const maxX = Math.max(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).x + item.w))
        const minY = Math.min(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).y))
        const maxY = Math.max(...gesture.moveBoxes.map((item) => gesture.starts.get(item.id).y + item.h))
        const groupRect = { x: minX + dx, y: minY + dy, w: maxX - minX, h: maxY - minY }
        const snapped = snapBox(groupRect, others)
        dx = clamp(dx + (snapped.x - groupRect.x), minDx, maxDx)
        dy = clamp(dy + (snapped.y - groupRect.y), minDy, maxDy)
        renderGuides(snapped.guides)
      } else {
        clearGuides()
      }

      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) gesture.moved = true
      for (const item of gesture.moveBoxes) {
        const st = gesture.starts.get(item.id)
        item.x = clamp(st.x + dx, 0, Math.max(0, 1 - item.w))
        item.y = clamp(st.y + dy, 0, Math.max(0, 1 - item.h))
        const outline = overlays.querySelector(`[data-box="${item.id}"]`)
        if (outline) rectStyle(outline, item)
      }
      schedulePaint()
      return
    }
    if (gesture.kind === "draft") {
      rectStyle(gesture.draft, placement(gesture.origin, cursor))
    }
  })

  stage.addEventListener("pointerup", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    const completed = gesture
    gesture = undefined
    clearGuides()
    if (completed.kind === "pan") {
      stage.classList.remove("dragging-pan")
      return
    }
    if (completed.kind === "inpaint-preview") {
      const page = selectedPage()
      if (page) {
        if (!addStroke(page, completed.stroke, state.layerId)) {
          status(t("status.retouch.noLayer"), true)
          render()
          return
        }
        checkpoint(completed.before, { label: "Tẩy chữ và tái tạo nền (Inpaint)", kind: "retouch" })
        prepareNativeInpaint(page, completed.stroke).then((usedNative) => {
          if (usedNative && selectedPage() === page) {
            paintPreview(page)
            status("Đã tái tạo nền sắc nét bằng C# PatchMatch Inpaint.")
          }
        })
      }
      render()
      status("Đã tẩy chữ và tái tạo nền bằng Inpaint.")
      return
    }
    if (completed.kind === "retouch") {
      const page = selectedPage()
      checkpoint(completed.before, { label: "Nét vẽ tay trên trang", kind: "retouch" })
      if (page && completed.stroke?.mode === "clone" && completed.stroke.seamless) {
        prepareNativeClone(page, completed.stroke).then((usedNative) => {
          if (usedNative && selectedPage() === page) {
            paintPreview(page)
            status("Đã hòa biên sao chép nền bằng C# Poisson Seamless Clone.")
          }
        })
      }
      render()
      return
    }
    if (completed.kind === "rotate") {
      if (completed.box.rotation !== completed.startRotation) {
        checkpoint(completed.before, { label: "Xoay khung thoại", kind: "gesture" })
      }
      render()
      return
    }
    if (completed.kind === "resize") {
      const resized = [...completed.boxes.values()].some((item) => {
        const start = completed.starts.get(item.id)
        return item.x !== start.x || item.y !== start.y || item.w !== start.w || item.h !== start.h
      })
      if (resized) {
        checkpoint(completed.before, {
          label: completed.boxes.size > 1
            ? `Đổi kích thước ${completed.boxes.size} khung`
            : "Đổi kích thước khung",
          kind: "gesture",
        })
      }
      render()
      return
    }
    if (completed.kind === "move") {
      if (completed.moved) checkpoint(completed.before, { label: "Di chuyển khung", kind: "gesture" })
      else if (completed.collapseOnClick) selectBox(completed.box)
      render()
      return
    }
    if (completed.kind === "cleanup-stroke") {
      checkpoint(completed.before, { label: "Tô vùng xoá nền", kind: "cleanup" })
      render()
      return
    }
    if (completed.kind === "draft") {
      checkpoint(completed.before, {
        label: completed.cleanupBox ? "Khoanh vùng xoá nền" : "Vẽ khung thoại mới",
        kind: "gesture",
      })
      if (completed.cleanupBox) {
        completed.cleanupBox.cleanupRect = placement(completed.origin, point(event))
        completed.cleanupBox.cleanupStrokes = []
      } else {
        addBox(placement(completed.origin, point(event)), undefined, false)
      }
      render()
    }
  })

  stage.addEventListener("pointercancel", (event) => {
    if (gesture?.pointer !== event.pointerId) return
    const cancelled = gesture
    gesture = undefined
    clearGuides()
    if (cancelled.kind === "pan") {
      stage.classList.remove("dragging-pan")
      return
    }
    if (cancelled.before) {
      const { settings, ...editor } = cancelled.before
      Object.assign(state, editor)
    }
    render()
  })

  stage.addEventListener("keydown", (event) => {
    if (event.target !== stage) return
    if (event.key === "Enter") {
      event.preventDefault()
      addBox({ x: .33, y: .42, w: .34, h: .16 })
      byId("box-text").focus()
    } else if (event.key === "Escape") {
      state.placing = false
      renderCanvas()
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const rtl = byId("direction").value === "rtl"
      changePage((event.key === "ArrowLeft") === rtl ? 1 : -1)
      event.preventDefault()
    }
  })

  const splitHandle = byId("split-handle")
  if (splitHandle) {
    let draggingSplit = false
    const applySplitPos = (value) => {
      state.splitPos = clamp(Math.round(value), 0, 100)
      stage.style.setProperty("--split-pos", `${state.splitPos}%`)
      splitHandle.setAttribute("aria-valuenow", String(state.splitPos))
      splitHandle.setAttribute("aria-valuetext", `Rèm ở ${state.splitPos}%`)
    }
    const updateSplitFromClientX = (clientX) => {
      const rect = stage.getBoundingClientRect()
      if (!rect.width) return
      applySplitPos(((clientX - rect.left) / rect.width) * 100)
    }
    splitHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault()
      event.stopPropagation()
      draggingSplit = true
      splitHandle.focus?.({ preventScroll: true })
      splitHandle.setPointerCapture?.(event.pointerId)
      updateSplitFromClientX(event.clientX)
    })
    splitHandle.addEventListener("pointermove", (event) => {
      if (!draggingSplit) return
      event.preventDefault()
      updateSplitFromClientX(event.clientX)
    })
    const stopSplit = () => { draggingSplit = false }
    splitHandle.addEventListener("pointerup", stopSplit)
    splitHandle.addEventListener("pointercancel", stopSplit)
    splitHandle.addEventListener("keydown", (event) => {
      const key = event.key
      const arrow = key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowRight" || key === "ArrowDown"
      if (!arrow && key !== "Home" && key !== "End") return
      event.preventDefault()
      event.stopPropagation()
      if (key === "Home") return applySplitPos(0)
      if (key === "End") return applySplitPos(100)
      const step = event.shiftKey ? 10 : 2
      applySplitPos(state.splitPos + ((key === "ArrowRight" || key === "ArrowDown") ? step : -step))
    })
  }

  return {
    hasGesture: () => Boolean(gesture),
    cancelPendingPaint() {
      if (pendingPaint) {
        cancelAnimationFrame(pendingPaint)
        pendingPaint = undefined
      }
    },
    abortGesture() {
      if (!gesture) return null
      const before = gesture.before ?? null
      gesture = undefined
      clearGuides()
      stage.classList.remove("dragging-pan")
      return before
    },
    clearGuides,
    renderCloneMarker,
    updateZoomDisplay,
    getSpaceHeld: () => spaceHeld,
    setSpaceHeld(value) {
      spaceHeld = Boolean(value)
      stage.classList.toggle("panning", byId("cleanup-tool").value === "pan" || spaceHeld)
    },
  }
}
