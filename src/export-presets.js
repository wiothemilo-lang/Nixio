import { filenameStem } from "./io.js"
import { CANVAS_LIMITS } from "./webtoon.js"

// Per-platform Webtoon export profiles (Nixio #78). A profile is the whole recipe for one
// platform upload: canvas width, the tallest slice it accepts, safe margins, image format and
// quality, file naming and the metadata the manifest sidecar records. Every number an export
// uses comes from the profile, so a named recipe replaces the hard-coded ZIP naming and the
// manually typed slice height.

export const GLOBAL_EXPORT_PROFILE_KEY = "khung-thoai-export-profile"
export const DEFAULT_EXPORT_PROFILE_ID = "goc"
export const DEFAULT_JPEG_QUALITY = 0.92
export const exportManifestFileName = "manifest.json"
// Every archive entry is stamped with this fixed date (the DOS epoch) so exporting the same project
// twice produces the same bytes; JSZip otherwise writes the moment of export into each entry.
export const exportArchiveDate = new Date("1980-01-01T00:00:00Z")

// Every archive writer goes through this helper: a raw `zip.file()` stamps the export moment into the
// entry header, so two exports of the same project would differ even when the page bytes are equal.
export function writeArchiveEntry(zip, name, content) {
  return zip.file(name, content, { date: exportArchiveDate })
}

export const EXPORT_PROFILE_LIMITS = Object.freeze({
  minWidth: 320,
  minSliceHeight: 200,
  maxMargin: 400,
  minQuality: 0.5,
  maxQuality: 1,
  maxMetadataKeys: 8,
  maxMetadataText: 120,
})

export const exportProfileFormats = Object.freeze(["png", "jpeg"])
export const exportProfileNamings = Object.freeze(["index-stem", "stem-index"])
const sideNames = { top: "trên", right: "phải", bottom: "dưới", left: "trái" }
const noMargins = { top: 0, right: 0, bottom: 0, left: 0 }

const invalid = (message) => new Error(message)

function preset(profile) {
  return Object.freeze({
    ...profile,
    margins: Object.freeze({ ...profile.margins }),
    metadata: Object.freeze({ ...profile.metadata }),
  })
}

// The shipped presets are the platforms Nixio targets, with Nixio's own numbers for each
// platform's canvas guidance. A platform that changes its guidance is a new profile, not a code
// change: every export reads width, slice height, margins, format and quality from here.
export const exportProfilePresets = Object.freeze([
  preset({
    id: "goc",
    name: "Bản gốc (PNG, giữ kích thước)",
    width: null,
    maxSliceHeight: CANVAS_LIMITS.maxEdge,
    margins: noMargins,
    format: "png",
    quality: 1,
    naming: "index-stem",
    preflight: true,
    metadata: { platform: "generic", label: "Bản gốc" },
  }),
  preset({
    id: "naver",
    name: "NAVER WEBTOON",
    width: 800,
    maxSliceHeight: 2000,
    margins: noMargins,
    format: "jpeg",
    quality: DEFAULT_JPEG_QUALITY,
    naming: "index-stem",
    preflight: true,
    metadata: { platform: "naver", label: "NAVER WEBTOON", language: "vi" },
  }),
  preset({
    id: "kakaopage",
    name: "KakaoPage",
    width: 720,
    maxSliceHeight: 2000,
    margins: { top: 40, right: 0, bottom: 40, left: 0 },
    format: "jpeg",
    quality: DEFAULT_JPEG_QUALITY,
    naming: "index-stem",
    preflight: true,
    metadata: { platform: "kakaopage", label: "KakaoPage", language: "vi" },
  }),
  preset({
    id: "tapas",
    name: "Tapas",
    width: 940,
    maxSliceHeight: 1500,
    margins: noMargins,
    format: "jpeg",
    quality: 0.9,
    naming: "index-stem",
    preflight: true,
    metadata: { platform: "tapas", label: "Tapas", language: "vi" },
  }),
  preset({
    id: "webtoon-canvas",
    name: "WEBTOON Canvas",
    width: 800,
    maxSliceHeight: 1600,
    margins: noMargins,
    format: "png",
    quality: 1,
    naming: "index-stem",
    preflight: true,
    metadata: { platform: "webtoon-canvas", label: "WEBTOON Canvas", language: "vi" },
  }),
])

const presetById = new Map(exportProfilePresets.map((profile) => [profile.id, profile]))

/**
 * Normalizes and checks one profile record, refusing anything an export cannot honor with a
 * readable Vietnamese message naming the field and the value that was supplied.
 */
export function validateExportProfile(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("Hồ sơ xuất phải là một đối tượng có tên, chiều rộng và chiều cao mảnh.")
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    throw invalid(`Mã hồ sơ xuất "${String(raw.id ?? "")}" không hợp lệ: chỉ dùng chữ thường, số và dấu gạch ngang (tối đa 32 ký tự).`)
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : ""
  if (!name || name.length > 80) {
    throw invalid(`Hồ sơ "${id}" cần tên hiển thị từ 1 đến 80 ký tự.`)
  }

  const width = raw.width === null || raw.width === undefined ? null : Number(raw.width)
  if (
    width !== null &&
    (!Number.isInteger(width) || width < EXPORT_PROFILE_LIMITS.minWidth || width > CANVAS_LIMITS.maxEdge)
  ) {
    throw invalid(
      `Chiều rộng canvas của hồ sơ "${name}" phải là số nguyên trong khoảng ${EXPORT_PROFILE_LIMITS.minWidth}–${CANVAS_LIMITS.maxEdge} px (nhận ${String(raw.width)}).`,
    )
  }

  const maxSliceHeight = Number(raw.maxSliceHeight)
  if (
    !Number.isInteger(maxSliceHeight) ||
    maxSliceHeight < EXPORT_PROFILE_LIMITS.minSliceHeight ||
    maxSliceHeight > CANVAS_LIMITS.maxEdge
  ) {
    throw invalid(
      `Chiều cao mảnh tối đa của hồ sơ "${name}" phải là số nguyên trong khoảng ${EXPORT_PROFILE_LIMITS.minSliceHeight}–${CANVAS_LIMITS.maxEdge} px (nhận ${String(raw.maxSliceHeight)}).`,
    )
  }

  const rawMargins = raw.margins ?? {}
  const margins = {}
  for (const side of ["top", "right", "bottom", "left"]) {
    const value = rawMargins[side] === undefined ? 0 : Number(rawMargins[side])
    if (!Number.isInteger(value) || value < 0 || value > EXPORT_PROFILE_LIMITS.maxMargin) {
      throw invalid(
        `Lề an toàn phía ${sideNames[side]} của hồ sơ "${name}" phải là số nguyên từ 0 đến ${EXPORT_PROFILE_LIMITS.maxMargin} px (nhận ${String(rawMargins[side])}).`,
      )
    }
    margins[side] = value
  }
  const verticalMargins = margins.top + margins.bottom
  if (verticalMargins >= maxSliceHeight) {
    throw invalid(
      `Lề trên và dưới (${verticalMargins} px) chiếm hết chiều cao mảnh tối đa ${maxSliceHeight} px của hồ sơ "${name}". Hãy giảm lề hoặc tăng chiều cao mảnh.`,
    )
  }
  if (width !== null && width - margins.left - margins.right < EXPORT_PROFILE_LIMITS.minWidth) {
    throw invalid(
      `Lề trái và phải (${margins.left + margins.right} px) quá lớn so với chiều rộng ${width} px của hồ sơ "${name}": cần chừa ít nhất ${EXPORT_PROFILE_LIMITS.minWidth} px cho nội dung.`,
    )
  }

  const format = raw.format ?? "png"
  if (!exportProfileFormats.includes(format)) {
    throw invalid(`Định dạng của hồ sơ "${name}" phải là PNG hoặc JPEG (nhận "${String(raw.format)}").`)
  }
  const quality = raw.quality === undefined
    ? (format === "jpeg" ? DEFAULT_JPEG_QUALITY : 1)
    : Number(raw.quality)
  if (
    !Number.isFinite(quality) ||
    quality < EXPORT_PROFILE_LIMITS.minQuality ||
    quality > EXPORT_PROFILE_LIMITS.maxQuality
  ) {
    throw invalid(
      `Chất lượng JPEG của hồ sơ "${name}" phải trong khoảng ${EXPORT_PROFILE_LIMITS.minQuality}–${EXPORT_PROFILE_LIMITS.maxQuality} (nhận ${String(raw.quality)}).`,
    )
  }

  const naming = raw.naming ?? "index-stem"
  if (!exportProfileNamings.includes(naming)) {
    throw invalid(`Cách đặt tên mảnh của hồ sơ "${name}" phải là "index-stem" hoặc "stem-index" (nhận "${String(raw.naming)}").`)
  }
  const preflight = raw.preflight ?? true
  if (typeof preflight !== "boolean") {
    throw invalid(`Cờ kiểm tra trước khi xuất của hồ sơ "${name}" phải là true hoặc false.`)
  }

  const rawMetadata = raw.metadata ?? {}
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw invalid(`Siêu dữ liệu của hồ sơ "${name}" phải là một đối tượng.`)
  }
  const metadataEntries = Object.entries(rawMetadata)
  if (metadataEntries.length > EXPORT_PROFILE_LIMITS.maxMetadataKeys) {
    throw invalid(
      `Siêu dữ liệu của hồ sơ "${name}" có ${metadataEntries.length} mục, vượt giới hạn ${EXPORT_PROFILE_LIMITS.maxMetadataKeys} mục.`,
    )
  }
  const metadata = {}
  for (const [key, value] of metadataEntries) {
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/i.test(key)) {
      throw invalid(`Khoá siêu dữ liệu "${key}" của hồ sơ "${name}" chỉ được dùng chữ, số và dấu gạch ngang (tối đa 24 ký tự).`)
    }
    const textOk = typeof value === "string" && value.length <= EXPORT_PROFILE_LIMITS.maxMetadataText
    const numberOk = typeof value === "number" && Number.isFinite(value)
    if (!textOk && !numberOk && typeof value !== "boolean") {
      throw invalid(
        `Giá trị siêu dữ liệu "${key}" của hồ sơ "${name}" phải là chuỗi tối đa ${EXPORT_PROFILE_LIMITS.maxMetadataText} ký tự, số hoặc true/false.`,
      )
    }
    metadata[key] = value
  }

  if (width !== null && width * maxSliceHeight > CANVAS_LIMITS.maxPixels) {
    throw invalid(
      `Hồ sơ "${name}" tạo mảnh ${width}×${maxSliceHeight} = ${width * maxSliceHeight} điểm ảnh, vượt giới hạn ${CANVAS_LIMITS.maxPixels} điểm ảnh của canvas. Hãy giảm chiều rộng hoặc chiều cao mảnh.`,
    )
  }

  return { id, name, width, maxSliceHeight, margins, format, quality, naming, preflight, metadata }
}

// Profiles read back from storage are never trusted: an unreadable one is dropped rather than
// making the export dialog unusable.
export function readExportProfile(raw) {
  try {
    return validateExportProfile(raw)
  } catch {
    return null
  }
}

export function findExportProfilePreset(id) {
  return presetById.get(id) ?? null
}

export function resolveExportProfile(value) {
  if (value === undefined || value === null || value === "") {
    return validateExportProfile(presetById.get(DEFAULT_EXPORT_PROFILE_ID))
  }
  if (typeof value === "string") {
    const profile = presetById.get(value)
    if (!profile) throw invalid(`Hồ sơ xuất "${value}" không có trong danh sách hồ sơ của ứng dụng.`)
    return validateExportProfile(profile)
  }
  return validateExportProfile(value)
}

export function loadGlobalExportProfileId(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(GLOBAL_EXPORT_PROFILE_KEY)
    return typeof stored === "string" && presetById.has(stored) ? stored : DEFAULT_EXPORT_PROFILE_ID
  } catch {
    return DEFAULT_EXPORT_PROFILE_ID
  }
}

export function saveGlobalExportProfileId(id, storage = globalThis.localStorage) {
  const stored = typeof id === "string" && presetById.has(id) ? id : DEFAULT_EXPORT_PROFILE_ID
  try {
    storage?.setItem(GLOBAL_EXPORT_PROFILE_KEY, stored)
  } catch {
    // Ignore storage quota or private-mode errors.
  }
  return stored
}

/**
 * Remember a profile pick as the default for new projects as well as the global preference.
 *
 * `defaults` is the snapshot the project controller resets the form from. Saving only the global key
 * left that snapshot at its start-up value, so a project created later in the same session fell back
 * to the old profile even though the select showed the new one.
 */
export function rememberExportProfileId(id, defaults = null, index = -1, storage = globalThis.localStorage) {
  const stored = saveGlobalExportProfileId(id, storage)
  if (Array.isArray(defaults) && Number.isInteger(index) && index >= 0 && index < defaults.length) {
    defaults[index] = stored
  }
  return stored
}

export function exportSliceExtension(format) {
  return format === "jpeg" ? "jpg" : "png"
}

/**
 * Names one slice: `01-ten-trang.png` for `index-stem` or `ten-trang-01.png` for `stem-index`,
 * always padded so the archive sorts in slice order.
 */
export function exportSliceFileName(profile, { order = 1, pad = 2, pageName = "" } = {}) {
  const sequence = String(Math.max(1, Math.floor(Number(order) || 1))).padStart(Math.max(2, Math.floor(Number(pad) || 2)), "0")
  const stem = filenameStem(pageName || "webtoon")
  const extension = exportSliceExtension(profile?.format ?? "png")
  return profile?.naming === "stem-index" ? `${stem}-${sequence}.${extension}` : `${sequence}-${stem}.${extension}`
}

/**
 * Plans the slices one page needs under a profile: the output canvas is the profile's width,
 * the page is scaled to the content box left by the safe margins, and the page is cut into
 * balanced bands no taller than the profile's slice height (lowered by the canvas pixel
 * budget when needed). The plan is pure arithmetic, so the same image and profile always
 * produce the same slices, names and order.
 */
export function planExportSlices(profile, { width, height, order = 1, pad, pageName = "" } = {}) {
  const clean = validateExportProfile(profile)
  const sourceWidth = Math.floor(Number(width))
  const sourceHeight = Math.floor(Number(height))
  if (!Number.isFinite(sourceWidth) || sourceWidth < 1 || !Number.isFinite(sourceHeight) || sourceHeight < 1) {
    throw invalid("Kích thước ảnh để xuất theo hồ sơ không hợp lệ.")
  }
  const { margins } = clean
  const canvasWidth = clean.width ?? sourceWidth
  const contentWidth = canvasWidth - margins.left - margins.right
  if (contentWidth < 1) {
    throw invalid(
      `Hồ sơ "${clean.name}" không còn chỗ cho nội dung: lề trái và phải (${margins.left + margins.right} px) rộng hơn canvas ${canvasWidth} px.`,
    )
  }
  const rowLimit = Math.min(
    clean.maxSliceHeight,
    CANVAS_LIMITS.maxEdge,
    Math.floor(CANVAS_LIMITS.maxPixels / canvasWidth),
  )
  const contentBudget = rowLimit - margins.top - margins.bottom
  if (contentBudget < 1) {
    throw invalid(
      `Hồ sơ "${clean.name}" cần ${margins.top + margins.bottom} px lề an toàn nhưng giới hạn canvas chỉ cho ${rowLimit} px mỗi mảnh (tối đa ${CANVAS_LIMITS.maxPixels} điểm ảnh). Hãy giảm lề an toàn hoặc chiều rộng hồ sơ.`,
    )
  }

  const scale = contentWidth / sourceWidth
  const contentHeight = Math.max(1, Math.round(sourceHeight * scale))
  const parts = Math.max(1, Math.ceil(contentHeight / contentBudget))
  const slicePad = Number(pad) > 0 ? Math.max(2, Math.floor(Number(pad))) : Math.max(2, String(order + parts - 1).length)
  const slices = []
  for (let part = 0; part < parts; part++) {
    const destTop = Math.floor((contentHeight * part) / parts)
    const destBottom = Math.floor((contentHeight * (part + 1)) / parts)
    const destHeight = Math.max(1, destBottom - destTop)
    const sourceTop = Math.floor((sourceHeight * destTop) / contentHeight)
    const sourceBottom = part === parts - 1 ? sourceHeight : Math.floor((sourceHeight * destBottom) / contentHeight)
    const sliceOrder = order + part
    slices.push({
      index: part + 1,
      order: sliceOrder,
      fileName: exportSliceFileName(clean, { order: sliceOrder, pad: slicePad, pageName }),
      sourceY: sourceTop,
      sourceHeight: Math.max(1, sourceBottom - sourceTop),
      destX: margins.left,
      destY: margins.top,
      destWidth: contentWidth,
      destHeight,
      canvasWidth,
      canvasHeight: margins.top + destHeight + margins.bottom,
    })
  }

  return {
    profile: clean,
    sourceWidth,
    sourceHeight,
    width: canvasWidth,
    contentWidth,
    rowLimit,
    contentBudget,
    scale,
    contentHeight,
    sliceCount: slices.length,
    slices,
  }
}

export function describeExportProfile(profile) {
  const clean = validateExportProfile(profile)
  const size = clean.width === null ? "giữ chiều rộng gốc" : `canvas ${clean.width} px`
  const format = clean.format === "jpeg" ? `JPEG ${Math.round(clean.quality * 100)}%` : "PNG"
  const margins = [clean.margins.top, clean.margins.right, clean.margins.bottom, clean.margins.left].join("/")
  const sample = clean.naming === "stem-index"
    ? `tên-01.${exportSliceExtension(clean.format)}`
    : `01-tên.${exportSliceExtension(clean.format)}`
  return `${size} · mảnh ≤ ${clean.maxSliceHeight} px · lề ${margins} · ${format} · ${sample}`
}

/**
 * The sidecar manifest: which profile produced the archive and the order every slice appears in,
 * so a re-upload can be checked without opening the images. It is built from the same plans that
 * produced the files, so the list can never drift from the archive, and it carries no timestamp,
 * so the same project exported twice produces the same bytes.
 */
export function exportManifest({ profile, plans }) {
  const clean = validateExportProfile(profile)
  if (!Array.isArray(plans)) throw invalid("Danh sách mảnh xuất không hợp lệ.")
  const slices = []
  for (const { pageName = "", plan } of plans) {
    if (!plan || !Array.isArray(plan.slices)) throw invalid("Kế hoạch xuất theo hồ sơ không hợp lệ.")
    for (const slice of plan.slices) {
      if (!Number.isInteger(slice.order) || slice.order < 1) throw invalid("Thứ tự mảnh xuất không hợp lệ.")
      slices.push({
        order: slice.order,
        file: slice.fileName,
        page: String(pageName ?? ""),
        width: slice.canvasWidth,
        height: slice.canvasHeight,
        sourceY: slice.sourceY,
        sourceHeight: slice.sourceHeight,
      })
    }
  }
  const ordered = slices.slice().sort((left, right) => left.order - right.order
    || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  return {
    version: 1,
    app: "nixio",
    profile: {
      id: clean.id,
      name: clean.name,
      width: clean.width,
      maxSliceHeight: clean.maxSliceHeight,
      margins: { ...clean.margins },
      format: clean.format,
      quality: clean.format === "jpeg" ? clean.quality : null,
      naming: clean.naming,
      metadata: { ...clean.metadata },
    },
    sliceCount: ordered.length,
    slices: ordered,
  }
}

export function serializeExportManifest(manifest) {
  return JSON.stringify(manifest, null, 2)
}
