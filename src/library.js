import { writeArchiveEntry } from "./export-presets.js"
import { filenameStem, imageMimeType, normalizedSearch, saveFile } from "./io.js"

function catalogUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("URL ảnh không hợp lệ.")
  const url = new URL(value, location.href)
  if ((url.protocol !== "https:" && url.origin !== location.origin) || url.username || url.password) {
    throw new Error("Mỗi ảnh cần dùng URL HTTPS hoặc cùng nguồn với ứng dụng.")
  }
  return url.href
}

function catalogData(input) {
  if (!Array.isArray(input?.series)) throw new Error("Danh mục JSON cần thuộc tính series.")
  return input.series.map((series) => {
    if (typeof series?.title !== "string" || !series.title.trim() || !Array.isArray(series.chapters)) {
      throw new Error("Mỗi truyện cần title và danh sách chapters.")
    }
    return {
      title: series.title.trim(),
      aliases: Array.isArray(series.aliases) ? series.aliases.filter((value) => typeof value === "string") : [],
      chapters: series.chapters.map((chapter) => {
        if (typeof chapter?.title !== "string" || !chapter.title.trim() || !Array.isArray(chapter.pages) || !chapter.pages.length || chapter.pages.length > 50) {
          throw new Error("Mỗi chương cần title và từ 1 đến 50 URL ảnh.")
        }
        return { title: chapter.title.trim(), pages: chapter.pages.map(catalogUrl) }
      }),
    }
  })
}

async function chapterFiles(chapter) {
  const files = []
  for (const [index, url] of chapter.pages.entries()) {
    const result = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(25000) })
    if (!result.ok) throw new Error(`Không tải được ảnh trang ${index + 1}.`)
    const bytes = await result.blob()
    const contentType = imageMimeType(new URL(url).pathname, bytes.type)
    if (!contentType) throw new Error(`Định dạng ảnh ở trang ${index + 1} chưa được hỗ trợ.`)
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1]
    files.push(new File([bytes], `trang-${String(index + 1).padStart(2, "0")}.${extension}`, { type: contentType }))
  }
  return files
}

export function setupLibrary(importPages) {
  const get = (id) => document.getElementById(id)
  const resultList = get("catalog-results")
  const chapterSelect = get("chapter-select")
  const actionButtons = ["read-chapter", "import-chapter", "download-chapter"].map(get)
  const status = get("library-status")
  let seriesList = []
  let selection
  let busy = false
  const currentChapter = () => selection?.chapters[Number(chapterSelect.value)]

  function syncAbilities() {
    chapterSelect.disabled = busy || !selection?.chapters.length
    actionButtons.forEach((button) => { button.disabled = busy || !currentChapter() })
  }

  function selectSeries(series) {
    selection = series
    chapterSelect.replaceChildren(...series.chapters.map((chapter, index) => new Option(chapter.title, index)))
    syncAbilities()
    renderResults()
  }

  function renderResults() {
    const query = normalizedSearch(get("catalog-search").value)
    const match = seriesList.filter((series) =>
      [series.title, ...series.aliases].some((title) => normalizedSearch(title).includes(query)))
    resultList.replaceChildren(...match.map((series) => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "button"
      button.textContent = series.title
      button.setAttribute("aria-pressed", String(selection === series))
      button.onclick = () => selectSeries(series)
      return button
    }))
    if (seriesList.length && !match.length) {
      const message = document.createElement("p")
      message.className = "muted"
      message.textContent = "Không tìm thấy truyện."
      resultList.append(message)
    }
  }

  get("catalog-file").addEventListener("change", async (event) => {
    const file = event.target.files[0]
    if (!file) return
    try {
      seriesList = catalogData(JSON.parse(await file.text()))
      selection = undefined
      chapterSelect.replaceChildren()
      get("reader").hidden = true
      get("reader-images").replaceChildren()
      // A filter the previous catalogue was searched with would hide the new one: the panel would
      // report "Đã nhập N truyện" and then show "Không tìm thấy truyện." next to nothing.
      get("catalog-search").value = ""
      renderResults()
      syncAbilities()
      if (seriesList.length === 1) selectSeries(seriesList[0])
      status.textContent = `Đã nhập ${seriesList.length} truyện.`
    } catch (error) {
      status.textContent = error.message
    } finally {
      event.target.value = ""
    }
  })
  get("catalog-search").addEventListener("input", renderResults)
  chapterSelect.addEventListener("change", syncAbilities)

  get("read-chapter").onclick = () => {
    const chapter = currentChapter()
    const destination = get("reader-images")
    get("reader-title").textContent = selection.title + " · " + chapter.title
    destination.replaceChildren(...chapter.pages.map((url, index) => {
      const figure = document.createElement("figure")
      const caption = document.createElement("figcaption")
      caption.textContent = "Trang " + (index + 1)
      const image = document.createElement("img")
      image.alt = caption.textContent
      image.loading = index === 0 ? "eager" : "lazy"
      image.referrerPolicy = "no-referrer"
      image.src = url
      image.onerror = () => { caption.textContent += " · Không tải được ảnh" }
      figure.append(image, caption)
      return figure
    }))
    get("reader-page").replaceChildren(...chapter.pages.map((_, index) => new Option(index + 1, index)))
    get("reader").hidden = false
    get("reader").scrollIntoView()
  }
  get("close-reader").onclick = () => {
    get("reader").hidden = true
    get("reader-images").replaceChildren()
    get("read-chapter").focus()
  }
  get("reader-page").onchange = (event) => get("reader-images").children[Number(event.target.value)]?.scrollIntoView()
  for (const [id, run] of [
    ["import-chapter", async (files) => importPages(files)],
    ["download-chapter", async (files, name) => {
      const { default: JSZip } = await import("jszip")
      const zip = new JSZip()
      files.forEach((file) => writeArchiveEntry(zip, file.name, file))
      saveFile(await zip.generateAsync({ type: "blob" }), name + ".zip")
    }],
  ]) {
    get(id).onclick = async () => {
      const chapter = currentChapter()
      if (!chapter || busy) return
      const name = filenameStem(selection.title + " - " + chapter.title)
      busy = true
      syncAbilities()
      status.textContent = "Đang tải ảnh chương…"
      try {
        await run(await chapterFiles(chapter), name)
        status.textContent = `Đã tải ${chapter.pages.length} ảnh.`
      } catch (error) {
        status.textContent = error instanceof TypeError ? "Không tải được ảnh. Kiểm tra mạng và quyền CORS của máy chủ ảnh." : error.message
      } finally {
        busy = false
        syncAbilities()
      }
    }
  }
}
