const { mkdir, readdir, readFile, writeFile, rename, unlink, stat } = require("node:fs/promises")
const path = require("node:path")
const { randomUUID } = require("node:crypto")

const validId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
const validSnapshot = (id) => typeof id === "string" && /^\d+-[0-9a-f-]{36}\.khungthoai$/i.test(id)

class RecoveryCatalog {
  constructor(directory) {
    this.directory = path.join(directory, "projects")
    this.tail = Promise.resolve()
    this.lastTimestamp = 0
  }

  folder(id) {
    if (!validId(id)) throw new Error("Mã dự án không hợp lệ.")
    return path.join(this.directory, id)
  }

  async metadata(id) {
    try { return JSON.parse(await readFile(path.join(this.folder(id), "metadata.json"), "utf8")) }
    catch { return { id, title: "Dự án", updatedAt: 0, path: null } }
  }

  // The title the user gave the project, or null when it has no catalogue entry yet: metadata()
  // fabricates a default for that case, and a default must never replace a real file name.
  async title(id) {
    try {
      const metadata = JSON.parse(await readFile(path.join(this.folder(id), "metadata.json"), "utf8"))
      return typeof metadata?.title === "string" && metadata.title.trim() ? metadata.title.trim() : null
    } catch { return null }
  }

  async update(id, changes) {
    const run = async () => {
      const folder = this.folder(id)
      await mkdir(folder, { recursive: true })
      const metadata = { ...await this.metadata(id), ...changes, id }
      const temporary = path.join(folder, randomUUID() + ".json.tmp")
      try {
        await writeFile(temporary, JSON.stringify(metadata), "utf8")
        await rename(temporary, path.join(folder, "metadata.json"))
      } finally { await unlink(temporary).catch(() => {}) }
    }
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }

  async prepare(id) {
    const folder = this.folder(id)
    await mkdir(folder, { recursive: true })
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    return path.join(folder, this.lastTimestamp + "-" + randomUUID() + ".khungthoai")
  }

  async snapshots(id) {
    const folder = this.folder(id)
    const names = (await readdir(folder).catch(() => [])).filter(validSnapshot).sort().reverse()
    return Promise.all(names.map(async (name) => ({
      id: name, updatedAt: Number(name.split("-")[0]), size: (await stat(path.join(folder, name))).size,
    })))
  }

  async committed(id, title, sourcePath) {
    const changes = { title, updatedAt: Date.now() }
    if (sourcePath) changes.path = sourcePath
    await this.update(id, changes)
    const snapshots = await this.snapshots(id)
    for (const item of snapshots.slice(10)) await unlink(path.join(this.folder(id), item.id)).catch(() => {})
  }

  async list() {
    await this.tail
    const ids = (await readdir(this.directory).catch(() => [])).filter(validId)
    const projects = await Promise.all(ids.map(async (id) => {
      const { path, ...metadata } = await this.metadata(id)
      // The catalogue entry is sent to the renderer; only the fact that a saved file exists is useful
      // there, never the absolute path main keeps for `resolve()`.
      return { ...metadata, saved: Boolean(path), snapshots: await this.snapshots(id) }
    }))
    return projects.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async resolve(projectId, snapshotId) {
    if (snapshotId) {
      if (!validSnapshot(snapshotId)) throw new Error("Mốc phục hồi không hợp lệ.")
      return path.join(this.folder(projectId), snapshotId)
    }
    const metadata = await this.metadata(projectId)
    if (!metadata.path) throw new Error("Dự án này chưa có tệp lưu thủ công.")
    return metadata.path
  }
}

module.exports = { RecoveryCatalog, validId }
