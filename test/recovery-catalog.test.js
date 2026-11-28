import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import catalog from "../desktop/recovery-catalog.cjs"

test("project recovery keeps separate histories, recent paths and ten snapshots per project", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "khung-thoai-catalog-"))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const library = new catalog.RecoveryCatalog(folder)
  const first = randomUUID()
  const second = randomUUID()
  for (let index = 0; index < 12; index++) {
    const file = await library.prepare(first)
    await writeFile(file, "snapshot-" + index)
    await library.committed(first, "Chapter 1", "/chapter-1.khungthoai")
  }
  await library.update(second, { title: "Chapter 2", path: "/chapter-2.khungthoai", updatedAt: Date.now() + 1 })
  const projects = await library.list()
  assert.equal(projects.length, 2)
  assert.equal(projects[0].id, second)
  assert.equal(projects[0].saved, true)
  assert.equal(projects[1].saved, true)
  assert.ok(projects.every((project) => !Object.hasOwn(project, "path")), "the renderer list must not carry file paths")
  assert.equal(projects[1].snapshots.length, 10)
  assert.equal(await library.resolve(second), "/chapter-2.khungthoai")
  assert.ok((await library.resolve(first, projects[1].snapshots[0].id)).startsWith(library.folder(first)))
  assert.throws(() => library.folder("../escape"), /không hợp lệ/)
  await assert.rejects(library.resolve(first, "../escape"), /không hợp lệ/)
})
