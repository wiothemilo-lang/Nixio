import assert from "node:assert/strict"
import test from "node:test"
import JSZip from "jszip"
import {
  DEFAULT_EXPORT_PROFILE_ID,
  GLOBAL_EXPORT_PROFILE_KEY,
  describeExportProfile,
  exportArchiveDate,
  exportManifest,
  exportManifestFileName,
  exportProfilePresets,
  exportSliceFileName,
  findExportProfilePreset,
  loadGlobalExportProfileId,
  planExportSlices,
  readExportProfile,
  rememberExportProfileId,
  resolveExportProfile,
  saveGlobalExportProfileId,
  serializeExportManifest,
  validateExportProfile,
  writeArchiveEntry,
} from "../src/export-presets.js"
import { CANVAS_LIMITS, renderExportSlices, smartSlicePageImage } from "../src/webtoon.js"

const profile = (overrides = {}) => ({
  id: "custom",
  name: "Tùy chỉnh",
  width: 800,
  maxSliceHeight: 2000,
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
  format: "jpeg",
  quality: 0.9,
  naming: "index-stem",
  preflight: true,
  metadata: {},
  ...overrides,
})

test("the shipped presets name every platform the export dialog offers", () => {
  const ids = exportProfilePresets.map(({ id }) => id)
  assert.deepEqual(ids, ["goc", "naver", "kakaopage", "tapas", "webtoon-canvas"])
  assert.equal(DEFAULT_EXPORT_PROFILE_ID, "goc")
  assert.ok(findExportProfilePreset(DEFAULT_EXPORT_PROFILE_ID), "the default id must resolve")
  for (const preset of exportProfilePresets) {
    assert.ok(Object.isFrozen(preset), `${preset.id} is a frozen preset`)
    assert.ok(Object.isFrozen(preset.margins))
    const validated = validateExportProfile(preset)
    assert.deepEqual(validated, {
      ...preset,
      margins: { ...preset.margins },
      metadata: { ...preset.metadata },
    })
  }
})

test("each platform preset carries its own width, slice height, format and margins", () => {
  const naver = resolveExportProfile("naver")
  assert.deepEqual([naver.width, naver.maxSliceHeight, naver.format], [800, 2000, "jpeg"])
  assert.equal(naver.metadata.platform, "naver")

  const kakao = resolveExportProfile("kakaopage")
  assert.deepEqual([kakao.width, kakao.maxSliceHeight], [720, 2000])
  assert.deepEqual(kakao.margins, { top: 40, right: 0, bottom: 40, left: 0 })

  const tapas = resolveExportProfile("tapas")
  assert.deepEqual([tapas.width, tapas.maxSliceHeight, tapas.quality], [940, 1500, 0.9])

  const original = resolveExportProfile("goc")
  assert.equal(original.width, null, "the original profile keeps the source width")
  assert.equal(original.format, "png")
  assert.equal(original.maxSliceHeight, CANVAS_LIMITS.maxEdge)
})

test("validateExportProfile refuses every out-of-range field with a Vietnamese message", () => {
  const cases = [
    [null, /Hồ sơ xuất phải là một đối tượng/],
    [profile({ id: "Hồ sơ 1" }), /Mã hồ sơ xuất "Hồ sơ 1" không hợp lệ/],
    [profile({ name: "   " }), /cần tên hiển thị/],
    [profile({ width: 100 }), /Chiều rộng canvas của hồ sơ "Tùy chỉnh" phải là số nguyên trong khoảng 320–16384 px \(nhận 100\)/],
    [profile({ width: 20_000 }), /Chiều rộng canvas/],
    [profile({ maxSliceHeight: 100 }), /Chiều cao mảnh tối đa của hồ sơ "Tùy chỉnh" phải là số nguyên/],
    [profile({ maxSliceHeight: 20_000 }), /Chiều cao mảnh tối đa/],
    [profile({ margins: { top: -1 } }), /Lề an toàn phía trên của hồ sơ "Tùy chỉnh" phải là số nguyên từ 0 đến 400 px \(nhận -1\)/],
    [profile({ margins: { left: 500 } }), /Lề an toàn phía trái/],
    [profile({ maxSliceHeight: 600, margins: { top: 300, bottom: 300 } }), /Lề trên và dưới \(600 px\) chiếm hết chiều cao mảnh tối đa 600 px/],
    [profile({ width: 720, margins: { left: 400, right: 400 } }), /Lề trái và phải \(800 px\) quá lớn so với chiều rộng 720 px/],
    [profile({ format: "webp" }), /Định dạng của hồ sơ "Tùy chỉnh" phải là PNG hoặc JPEG \(nhận "webp"\)/],
    [profile({ quality: 0.2 }), /Chất lượng JPEG của hồ sơ "Tùy chỉnh" phải trong khoảng 0.5–1/],
    [profile({ quality: 1.4 }), /Chất lượng JPEG/],
    [profile({ naming: "date" }), /Cách đặt tên mảnh/],
    [profile({ preflight: "yes" }), /Cờ kiểm tra trước khi xuất/],
    [profile({ metadata: { "bad key": 1 } }), /Khoá siêu dữ liệu "bad key"/],
    [profile({ metadata: { note: "x".repeat(200) } }), /Giá trị siêu dữ liệu "note"/],
    [profile({ metadata: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i])) }), /vượt giới hạn 8 mục/],
    [profile({ width: 16_000, maxSliceHeight: 2000 }), /tạo mảnh 16000×2000 = 32000000 điểm ảnh, vượt giới hạn 25000000 điểm ảnh/],
  ]
  for (const [input, expected] of cases) {
    assert.throws(() => validateExportProfile(input), expected)
  }
})

test("resolveExportProfile reads a preset id or a record and refuses an unknown id", () => {
  assert.equal(resolveExportProfile("tapas").width, 940)
  assert.equal(resolveExportProfile().id, DEFAULT_EXPORT_PROFILE_ID)
  const custom = resolveExportProfile({ id: "custom", name: "Tùy chỉnh", width: 1000, maxSliceHeight: 1800 })
  assert.deepEqual(
    [custom.format, custom.quality, custom.naming, custom.preflight],
    ["png", 1, "index-stem", true],
  )
  assert.deepEqual(custom.margins, { top: 0, right: 0, bottom: 0, left: 0 })
  assert.throws(() => resolveExportProfile("khong-co"), /Hồ sơ xuất "khong-co" không có trong danh sách hồ sơ/)
  assert.equal(readExportProfile({ id: "custom" }), null, "broken stored profiles are dropped")
  assert.equal(readExportProfile(profile()).id, "custom")
})

test("the global default profile is stored separately from the project setting", () => {
  const storage = fakeStorage()
  assert.equal(loadGlobalExportProfileId(storage), DEFAULT_EXPORT_PROFILE_ID)
  assert.equal(saveGlobalExportProfileId("tapas", storage), "tapas")
  assert.equal(storage.entries().get(GLOBAL_EXPORT_PROFILE_KEY), "tapas")
  assert.equal(loadGlobalExportProfileId(storage), "tapas")
  assert.equal(saveGlobalExportProfileId("bogus", storage), DEFAULT_EXPORT_PROFILE_ID)
  assert.equal(loadGlobalExportProfileId(storage), DEFAULT_EXPORT_PROFILE_ID)
  assert.equal(loadGlobalExportProfileId({ getItem() { throw new Error("private mode") } }), DEFAULT_EXPORT_PROFILE_ID)
  assert.equal(saveGlobalExportProfileId("naver", { setItem() { throw new Error("quota") } }), "naver")
})

// Regression for #145: the reset snapshot was taken once at start-up, so a profile picked later in the
// session was saved globally but a new project still opened on the start-up profile.
test("a profile pick also becomes the default the next new project starts from", () => {
  const storage = fakeStorage()
  const defaults = ["goc", "goc"]
  assert.equal(rememberExportProfileId("tapas", defaults, 1, storage), "tapas")
  assert.equal(defaults[1], "tapas")
  assert.equal(loadGlobalExportProfileId(storage), "tapas")

  // An unknown id is stored as the shipped default, and the default snapshot follows the same value.
  assert.equal(rememberExportProfileId("bogus", defaults, 1, storage), DEFAULT_EXPORT_PROFILE_ID)
  assert.equal(defaults[1], DEFAULT_EXPORT_PROFILE_ID)

  // A setup without the field (or with a stale index) must not throw.
  assert.equal(rememberExportProfileId("naver", null, -1, storage), "naver")
  assert.equal(rememberExportProfileId("naver", ["goc"], 4, storage), "naver")
})

test("planExportSlices scales the page to the profile width and cuts contiguous balanced slices", () => {
  const naver = resolveExportProfile("naver")
  const plan = planExportSlices(naver, { width: 1600, height: 9000, pageName: "Trang 01.png" })
  assert.equal(plan.width, 800, "the canvas takes the profile width, not the page width")
  assert.equal(plan.scale, 0.5)
  assert.equal(plan.contentHeight, 4500)
  assert.equal(plan.sliceCount, 3)
  assert.deepEqual(plan.slices.map(({ fileName }) => fileName), [
    "01-Trang 01.jpg",
    "02-Trang 01.jpg",
    "03-Trang 01.jpg",
  ])
  let covered = 0
  for (const slice of plan.slices) {
    assert.equal(slice.sourceY, covered, "slices cover the page without gaps")
    assert.equal(slice.destHeight, 1500)
    assert.equal(slice.canvasHeight, 1500)
    assert.equal(slice.canvasWidth, 800)
    covered += slice.sourceHeight
  }
  assert.equal(covered, 9000)
  assert.deepEqual(plan.slices.at(-1).order, 3)
})

test("planExportSlices is deterministic for the same image and profile", () => {
  const kakao = resolveExportProfile("kakaopage")
  const first = planExportSlices(kakao, { width: 1440, height: 8888, order: 4, pageName: "trang.png" })
  const second = planExportSlices(kakao, { width: 1440, height: 8888, order: 4, pageName: "trang.png" })
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test("planExportSlices keeps the canvas cap when the profile has no width", () => {
  const original = resolveExportProfile("goc")
  const plan = planExportSlices(original, { width: 2000, height: 60_000 })
  assert.equal(plan.width, 2000)
  assert.equal(plan.rowLimit, Math.floor(CANVAS_LIMITS.maxPixels / 2000))
  assert.ok(plan.sliceCount > 1)
  for (const slice of plan.slices) {
    assert.ok(slice.canvasHeight <= plan.rowLimit)
    assert.ok(slice.canvasHeight <= CANVAS_LIMITS.maxEdge)
    assert.ok(slice.canvasWidth * slice.canvasHeight <= CANVAS_LIMITS.maxPixels)
  }
})

test("planExportSlices pads every slice canvas with the profile's safe margins", () => {
  const kakao = resolveExportProfile("kakaopage")
  const plan = planExportSlices(kakao, { width: 720, height: 5000 })
  assert.equal(plan.scale, 1)
  for (const slice of plan.slices) {
    assert.equal(slice.destY, 40)
    assert.equal(slice.destX, 0)
    assert.equal(slice.destWidth, 720)
    assert.equal(slice.canvasHeight, 40 + slice.destHeight + 40)
    assert.ok(slice.canvasHeight <= 2000)
  }
  const inset = planExportSlices(profile({ width: 800, margins: { left: 40, right: 40 } }), {
    width: 1440,
    height: 3000,
  })
  assert.equal(inset.contentWidth, 720)
  assert.equal(inset.scale, 0.5)
  for (const slice of inset.slices) {
    assert.deepEqual([slice.destX, slice.destWidth], [40, 720])
    assert.equal(slice.canvasWidth, 800)
  }
})

test("planExportSlices refuses geometry the profile cannot honor", () => {
  assert.throws(
    () => planExportSlices(profile({ width: null, margins: { left: 400, right: 400 } }), { width: 500, height: 3000 }),
    /không còn chỗ cho nội dung: lề trái và phải \(800 px\) rộng hơn canvas 500 px/,
  )
  assert.throws(() => planExportSlices(profile(), { width: 0, height: 3000 }), /Kích thước ảnh để xuất theo hồ sơ không hợp lệ/)
  assert.throws(() => planExportSlices(profile(), { width: 800, height: -4 }), /Kích thước ảnh để xuất theo hồ sơ không hợp lệ/)
  assert.throws(() => planExportSlices(profile({ width: 40 }), { width: 800, height: 3000 }), /Chiều rộng canvas/)
})

test("exportSliceFileName follows the profile naming and pads the archive order", () => {
  const numbered = resolveExportProfile("naver")
  assert.equal(exportSliceFileName(numbered, { order: 1, pageName: "trang-1.png" }), "01-trang-1.jpg")
  assert.equal(exportSliceFileName(numbered, { order: 9, pageName: "trang-1.png" }), "09-trang-1.jpg")
  assert.equal(exportSliceFileName(numbered, { order: 100, pageName: "trang-1.png" }), "100-trang-1.jpg")
  assert.equal(exportSliceFileName(numbered, { order: 7, pad: 3, pageName: "trang-1.png" }), "007-trang-1.jpg")
  const suffixed = resolveExportProfile({ ...profile(), naming: "stem-index", format: "png" })
  assert.equal(exportSliceFileName(suffixed, { order: 2, pageName: "trang-1.png" }), "trang-1-02.png")
  assert.equal(exportSliceFileName(suffixed, { order: 2 }), "webtoon-02.png")
})

test("describeExportProfile summarizes the constraints the export will enforce", () => {
  assert.equal(
    describeExportProfile(resolveExportProfile("naver")),
    "canvas 800 px · mảnh ≤ 2000 px · lề 0/0/0/0 · JPEG 92% · 01-tên.jpg",
  )
  assert.equal(
    describeExportProfile(resolveExportProfile("kakaopage")),
    "canvas 720 px · mảnh ≤ 2000 px · lề 40/0/40/0 · JPEG 92% · 01-tên.jpg",
  )
  assert.match(describeExportProfile(resolveExportProfile("goc")), /^giữ chiều rộng gốc · mảnh ≤ 16384 px · lề 0\/0\/0\/0 · PNG/)
})

test("exportManifest lists the slice order of every page and carries no timestamp", () => {
  const naver = resolveExportProfile("naver")
  const later = planExportSlices(naver, { width: 1600, height: 6000, order: 4, pageName: "trang-2.png" })
  const first = planExportSlices(naver, { width: 1600, height: 3000, order: 1, pageName: "trang-1.png" })
  const plans = [
    { pageName: "trang-2.png", plan: later },
    { pageName: "trang-1.png", plan: first },
  ]
  const manifest = exportManifest({ profile: naver, plans })
  assert.equal(manifest.sliceCount, 3)
  assert.deepEqual(manifest.slices.map(({ order }) => order), [1, 4, 5])
  assert.deepEqual(manifest.slices.map(({ file }) => file), ["01-trang-1.jpg", "04-trang-2.jpg", "05-trang-2.jpg"])
  assert.deepEqual(manifest.slices[0], {
    order: 1, file: "01-trang-1.jpg", page: "trang-1.png",
    width: 800, height: 1500, sourceY: 0, sourceHeight: 3000,
  })
  assert.deepEqual(manifest.profile.metadata, { platform: "naver", label: "NAVER WEBTOON", language: "vi" })
  assert.equal(manifest.profile.quality, 0.92)
  const json = serializeExportManifest(manifest)
  assert.equal(json, serializeExportManifest(exportManifest({ profile: naver, plans })))
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(json), "the manifest stays byte-identical between runs")
  assert.deepEqual(JSON.parse(json).slices[0], manifest.slices[0])
  assert.equal(exportManifest({ profile: resolveExportProfile("goc"), plans: [] }).profile.quality, null)
  // Archive entries carry a fixed date, so the ZIP bytes do not change between runs either.
  assert.equal(exportArchiveDate.toISOString(), "1980-01-01T00:00:00.000Z")
  assert.throws(() => exportManifest({ profile: naver, plans: null }), /Danh sách mảnh xuất không hợp lệ/)
  assert.throws(() => exportManifest({ profile: naver, plans: [{}] }), /Kế hoạch xuất theo hồ sơ không hợp lệ/)
  assert.throws(
    () => exportManifest({
      profile: naver,
      plans: [{ pageName: "trang.png", plan: { slices: [{ order: 0, fileName: "x.jpg", canvasWidth: 800, canvasHeight: 10 }] } }],
    }),
    /Thứ tự mảnh xuất không hợp lệ/,
  )
})

test("every archive entry uses the fixed epoch so two exports of the same bytes are identical", async () => {
  const build = async () => {
    const zip = new JSZip()
    writeArchiveEntry(zip, "01.png", new Uint8Array([1, 2, 3]))
    writeArchiveEntry(zip, exportManifestFileName, "{}")
    return zip.generateAsync({ type: "nodebuffer" })
  }
  const first = await build()
  assert.deepEqual(await build(), first, "a later export must not stamp the current time")
  const read = await JSZip.loadAsync(first)
  assert.equal(read.file("01.png").date.toISOString(), exportArchiveDate.toISOString())
  assert.equal(read.file(exportManifestFileName).date.toISOString(), exportArchiveDate.toISOString())
})

test("renderExportSlices draws, pads and encodes one file per planned slice", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const kakao = resolveExportProfile("kakaopage")
  const image = { naturalWidth: 720, naturalHeight: 5000 }
  const plan = planExportSlices(kakao, { width: 720, height: 5000, pageName: "trang.png" })
  const reports = []
  const files = await renderExportSlices(image, plan, { onSlice: (report) => reports.push(report) })

  assert.equal(canvases.length, plan.sliceCount)
  assert.equal(files.length, plan.sliceCount)
  for (const [index, canvas] of canvases.entries()) {
    const slice = plan.slices[index]
    assert.deepEqual([canvas.width, canvas.height], [720, slice.canvasHeight])
    assert.deepEqual(canvas.fills, [["#ffffff", 0, 0, 720, slice.canvasHeight]])
    assert.deepEqual(canvas.draws, [[image, 0, slice.sourceY, 720, slice.sourceHeight, 0, 40, 720, slice.destHeight]])
    assert.deepEqual(canvas.encodes, [["image/jpeg", 0.92]])
  }
  assert.deepEqual(files.map(({ name }) => name), plan.slices.map(({ fileName }) => fileName))
  assert.equal(files[0].type, "image/jpeg")
  assert.deepEqual(reports.map(({ index, total, fileName, width, height }) => [index, total, fileName, width, height]), [
    [1, 3, "01-trang.jpg", 720, plan.slices[0].canvasHeight],
    [2, 3, "02-trang.jpg", 720, plan.slices[1].canvasHeight],
    [3, 3, "03-trang.jpg", 720, plan.slices[2].canvasHeight],
  ])
})

test("renderExportSlices is deterministic and encodes PNG without a quality argument", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const original = resolveExportProfile("goc")
  const image = { naturalWidth: 600, naturalHeight: 2500 }
  const plan = planExportSlices(original, { width: 600, height: 2500, pageName: "trang.png" })
  const first = await renderExportSlices(image, plan)
  const second = await renderExportSlices(image, plan)
  assert.deepEqual(first.map(({ name }) => name), second.map(({ name }) => name))
  assert.deepEqual(
    canvases.map(({ width, height }) => [width, height]),
    Array.from({ length: first.length + second.length }, () => [600, plan.slices[0].canvasHeight]),
  )
  for (const canvas of canvases) {
    assert.deepEqual(canvas.encodes, [["image/png", undefined]])
    assert.deepEqual(canvas.fills, [], "PNG keeps the page background")
  }
})

test("renderExportSlices refuses a plan that does not match the image", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const plan = planExportSlices(resolveExportProfile("naver"), { width: 1600, height: 6000 })
  await assert.rejects(
    renderExportSlices({ naturalWidth: 800, naturalHeight: 1000 }, plan),
    /Kế hoạch xuất theo hồ sơ "NAVER WEBTOON" không khớp ảnh 800×1000/,
  )
  await assert.rejects(renderExportSlices({ naturalWidth: 0, naturalHeight: 0 }, plan), /Trang không có ảnh hợp lệ/)
  await assert.rejects(renderExportSlices({ naturalWidth: 800, naturalHeight: 3000 }, null), /Kế hoạch xuất theo hồ sơ không hợp lệ/)
  assert.equal(canvases.length, 0)
})

test("renderExportSlices reads the size of a decoded bitmap, not only an image element", async (t) => {
  const { canvases } = installCanvasHarness(t)
  const kakao = resolveExportProfile("kakaopage")
  // createImageBitmap hands back an ImageBitmap: width and height, no naturalWidth.
  const bitmap = { width: 720, height: 2400 }
  const plan = planExportSlices(kakao, { width: 720, height: 2400, pageName: "trang.png" })
  const files = await renderExportSlices(bitmap, plan)
  assert.equal(files.length, plan.slices.length)
  assert.equal(canvases.length, plan.slices.length)
})

test("exporting through a profile mutates neither the page image nor the shipped presets", async (t) => {
  installCanvasHarness(t)
  const presets = JSON.stringify(exportProfilePresets)
  const image = { naturalWidth: 1600, naturalHeight: 9000 }
  const plan = planExportSlices(findExportProfilePreset("naver"), {
    width: image.naturalWidth,
    height: image.naturalHeight,
    pageName: "trang.png",
  })
  await renderExportSlices(image, plan)
  assert.deepEqual(image, { naturalWidth: 1600, naturalHeight: 9000 })
  assert.equal(JSON.stringify(exportProfilePresets), presets)
  // The plan carries its own copy, so an edit cannot leak back into the shared preset.
  plan.profile.margins.top = 99
  assert.equal(findExportProfilePreset("naver").margins.top, 0)
  assert.equal(JSON.stringify(exportProfilePresets), presets)
})

test("smartSlicePageImage takes its slice height from the profile when no target is given", async (t) => {
  installCanvasHarness(t, { probe: (width, height) => gutterPixels(width, height, 100) })
  const page = { name: "dai.png", image: { naturalWidth: 800, naturalHeight: 6000 } }
  const tall = await smartSlicePageImage(page, { profile: { maxSliceHeight: 1200 } })
  const short = await smartSlicePageImage(page, { profile: { maxSliceHeight: 2400 } })
  assert.ok(tall.length > short.length, `a smaller profile slice must cut more strips (${tall.length} vs ${short.length})`)
  assert.ok(short.length > 1)
})

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    entries: () => map,
  }
}

function installCanvasHarness(t, { blob = () => new Blob([Uint8Array.of(1, 2, 3)]), probe = null } = {}) {
  const previousDocument = globalThis.document
  const canvases = []
  globalThis.document = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        draws: [],
        fills: [],
        encodes: [],
        getContext() {
          return {
            fillStyle: "",
            drawImage(...args) {
              canvas.draws.push(args)
            },
            fillRect(...args) {
              canvas.fills.push([this.fillStyle, ...args])
            },
            getImageData() {
              if (!probe) return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }
              return { data: probe(canvas.width, canvas.height) }
            },
          }
        },
        toBlob(callback, ...args) {
          canvas.encodes.push(args)
          callback(blob(canvas))
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }
  t.after(() => {
    globalThis.document = previousDocument
  })
  return { canvases }
}

function gutterPixels(width, height, period, gutter = 4) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const flat = y % period < gutter
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      const value = flat ? 255 : ((x + y) % 8 < 4 ? 30 : 220)
      pixels[offset] = value
      pixels[offset + 1] = value
      pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
  return pixels
}
