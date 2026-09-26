import test from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isIgnored, loadIgnorePatterns, mirrorCampaign } from "./mirror-vault.mjs"

const write = (root, file, text) => {
  const path = join(root, file)
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
}

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "mirror-vault-"))
  const site = join(root, "site")
  const vault = join(root, "vault")
  const backup = join(root, "backup")
  mkdirSync(site)
  mkdirSync(vault)
  return { root, site, vault, backup, done: () => rmSync(root, { recursive: true, force: true }) }
}

test("site copy overwrites the vault copy and the old vault file is backed up first", () => {
  const f = fixture()
  write(f.site, "NPCs/Korno.md", "site version")
  write(f.vault, "NPCs/Korno.md", "old vault version")
  const result = mirrorCampaign({
    source: f.site,
    target: f.vault,
    patterns: [],
    backupDir: f.backup,
  })
  assert.deepEqual(result.updated, ["NPCs/Korno.md"])
  assert.equal(readFileSync(join(f.vault, "NPCs/Korno.md"), "utf8"), "site version")
  assert.equal(readFileSync(join(f.backup, "NPCs/Korno.md"), "utf8"), "old vault version")
  f.done()
})

test("new site files are added and identical files are left alone", () => {
  const f = fixture()
  write(f.site, "a.md", "same")
  write(f.vault, "a.md", "same")
  write(f.site, "Sessions/b.md", "new")
  const result = mirrorCampaign({
    source: f.site,
    target: f.vault,
    patterns: [],
    backupDir: f.backup,
  })
  assert.deepEqual(result.added, ["Sessions/b.md"])
  assert.equal(result.unchanged, 1)
  assert.equal(result.backedUp, 0)
  f.done()
})

test("vault-only files are reported and never deleted or modified", () => {
  const f = fixture()
  write(f.site, "a.md", "site")
  write(f.vault, "Session 9 - Transcript.md", "private transcript")
  write(f.vault, "_Archive/old.md", "archived")
  const result = mirrorCampaign({
    source: f.site,
    target: f.vault,
    patterns: [],
    backupDir: f.backup,
  })
  assert.deepEqual(result.vaultOnly.sort(), ["Session 9 - Transcript.md", "_Archive/old.md"])
  assert.equal(
    readFileSync(join(f.vault, "Session 9 - Transcript.md"), "utf8"),
    "private transcript",
  )
  assert.equal(readFileSync(join(f.vault, "_Archive/old.md"), "utf8"), "archived")
  f.done()
})

test("ignorePatterns are honoured: transcripts and private folders are never copied", () => {
  const f = fixture()
  const patterns = ["private", "templates", ".obsidian", "**/*Transcript*.md"]
  write(f.site, "Sessions/Session 9 - Transcript.md", "should not copy")
  write(f.site, "private/secret.md", "should not copy")
  write(f.site, "Sessions/Session 9 - Notes.md", "copy me")
  const result = mirrorCampaign({ source: f.site, target: f.vault, patterns, backupDir: f.backup })
  assert.deepEqual(result.added, ["Sessions/Session 9 - Notes.md"])
  assert.equal(existsSync(join(f.vault, "Sessions/Session 9 - Transcript.md")), false)
  assert.equal(existsSync(join(f.vault, "private/secret.md")), false)
  f.done()
})

test("dry run changes nothing", () => {
  const f = fixture()
  write(f.site, "a.md", "site")
  write(f.site, "b.md", "new")
  write(f.vault, "a.md", "vault")
  const result = mirrorCampaign({
    source: f.site,
    target: f.vault,
    patterns: [],
    backupDir: f.backup,
    dryRun: true,
  })
  assert.deepEqual(result.updated, ["a.md"])
  assert.deepEqual(result.added, ["b.md"])
  assert.equal(readFileSync(join(f.vault, "a.md"), "utf8"), "vault")
  assert.equal(existsSync(join(f.vault, "b.md")), false)
  assert.equal(existsSync(f.backup), false)
  f.done()
})

test("refuses to create a missing vault campaign folder", () => {
  const f = fixture()
  assert.throws(
    () => mirrorCampaign({ source: f.site, target: join(f.vault, "Nope"), patterns: [] }),
    /Vault folder not found/,
  )
  f.done()
})

test("isIgnored matches plain names as path segments and globs against the path", () => {
  const patterns = ["private", "**/*Transcript*.md"]
  assert.equal(isIgnored("x/private/y.md", patterns), true)
  assert.equal(isIgnored("Sessions/Session 1 - Transcript.md", patterns), true)
  assert.equal(isIgnored("Session 1 - Transcript.md", patterns), true)
  assert.equal(isIgnored("Sessions/Session 1 - Notes.md", patterns), false)
  assert.equal(isIgnored("privateer.md", patterns), false)
})

test("reads ignorePatterns from the real quartz config", () => {
  const patterns = loadIgnorePatterns(new URL("../quartz.config.default.yaml", import.meta.url))
  assert.ok(patterns.includes("**/*Transcript*.md"), `got ${JSON.stringify(patterns)}`)
  assert.ok(patterns.includes("private"))
})
