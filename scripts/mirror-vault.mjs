import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, posix, sep } from "node:path"
import { fileURLToPath } from "node:url"

// The site (content/Campaigns/<campaign>/) is canonical. The Obsidian vault is a backup mirror.
// Files present on both sides are overwritten with the site's copy. Files that exist only in the
// vault (private transcripts, _Archive, _Discontinued, spare art) are never deleted or modified.
// Anything about to be overwritten is copied to a timestamped backup folder outside the vault first.

export const campaigns = ["Dark Sun", "Moonsea"]

const defaultVaultRoot = "/Users/jamesrichardson/Documents/Obsidian Notes/Campaigns/Campaigns"
const defaultBackupRoot = "/Users/jamesrichardson/Documents/Codex/Campaign Projects/_MirrorBackups"
const alwaysSkipped = new Set([".DS_Store"])

export const loadIgnorePatterns = (configPath) => {
  const lines = readFileSync(configPath, "utf8").split("\n")
  const start = lines.findIndex((line) => /^\s{2}ignorePatterns:\s*$/.test(line))
  if (start === -1) return []
  const patterns = []
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s{4}-\s+(.*?)\s*$/)
    if (!item) break
    patterns.push(item[1].replace(/^["']|["']$/g, ""))
  }
  return patterns
}

const globToRegExp = (glob) => {
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (glob.startsWith("**/", index)) {
      source += "(?:.*/)?"
      index += 2
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

// Mirrors Quartz's ignorePatterns: a plain name matches any path segment, a glob matches the path.
export const isIgnored = (relativePath, patterns) => {
  const path = relativePath.split(sep).join("/")
  const segments = path.split("/")
  return patterns.some((pattern) =>
    /[*?]/.test(pattern) ? globToRegExp(pattern).test(path) : segments.includes(pattern),
  )
}

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

const walk = (root, patterns = [], relative = "") => {
  const files = []
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative ? posix.join(relative.split(sep).join("/"), entry.name) : entry.name
    if (alwaysSkipped.has(entry.name) || entry.isSymbolicLink()) continue
    if (isIgnored(path, patterns)) continue
    if (entry.isDirectory()) files.push(...walk(root, patterns, path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export const mirrorCampaign = ({ source, target, patterns, backupDir, dryRun = false }) => {
  if (!existsSync(source)) throw new Error(`Site folder not found: ${source}`)
  if (!existsSync(target)) throw new Error(`Vault folder not found (refusing to create): ${target}`)

  const result = { added: [], updated: [], unchanged: 0, backedUp: 0, vaultOnly: [] }
  const siteFiles = walk(source, patterns)
  const siteSet = new Set(siteFiles.map((file) => file.toLowerCase()))

  for (const file of siteFiles) {
    const from = join(source, file)
    const to = join(target, file)
    if (!existsSync(to)) {
      result.added.push(file)
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
      }
    } else if (statSync(from).size === statSync(to).size && hash(from) === hash(to)) {
      result.unchanged++
    } else {
      result.updated.push(file)
      if (!dryRun) {
        if (backupDir) {
          const saved = join(backupDir, file)
          mkdirSync(dirname(saved), { recursive: true })
          copyFileSync(to, saved)
          result.backedUp++
        }
        copyFileSync(from, to)
      }
    }
  }

  // Report only: nothing here is ever deleted.
  for (const file of walk(target)) {
    if (!siteSet.has(file.toLowerCase())) result.vaultOnly.push(file)
  }
  return result
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-")

export const main = (argv = process.argv.slice(2), env = process.env) => {
  const dryRun = argv.includes("--dry-run")
  const verbose = argv.includes("--verbose")
  const backups = !argv.includes("--no-backup")
  const siteRoot = fileURLToPath(new URL("../content/Campaigns/", import.meta.url))
  const config = fileURLToPath(new URL("../quartz.config.default.yaml", import.meta.url))
  const vaultRoot = env.VAULT_ROOT ?? defaultVaultRoot
  const backupRoot = join(env.MIRROR_BACKUP_ROOT ?? defaultBackupRoot, stamp())
  const patterns = loadIgnorePatterns(config)

  console.log(`${dryRun ? "[dry run] " : ""}Mirroring site -> vault backup`)
  console.log(`  site : ${siteRoot}`)
  console.log(`  vault: ${vaultRoot}`)
  console.log(`  skipping (ignorePatterns): ${patterns.join(", ") || "none"}`)

  const totals = { added: 0, updated: 0, unchanged: 0, backedUp: 0, vaultOnly: 0 }
  for (const campaign of campaigns) {
    const result = mirrorCampaign({
      source: join(siteRoot, campaign),
      target: join(vaultRoot, campaign),
      patterns,
      backupDir: backups ? join(backupRoot, campaign) : undefined,
      dryRun,
    })
    console.log(`\n${campaign}`)
    console.log(`  added:     ${result.added.length}`)
    console.log(
      `  updated:   ${result.updated.length}${backups && !dryRun ? ` (${result.backedUp} backed up)` : ""}`,
    )
    console.log(`  unchanged: ${result.unchanged}`)
    console.log(`  vault-only, left untouched: ${result.vaultOnly.length}`)
    const show = (label, list, limit) => {
      if (!list.length) return
      console.log(`  ${label}:`)
      for (const file of list.slice(0, verbose ? Infinity : limit)) console.log(`    ${file}`)
      if (!verbose && list.length > limit)
        console.log(`    ... ${list.length - limit} more (--verbose)`)
    }
    show("added", result.added, 40)
    show("updated", result.updated, 15)
    show("vault-only", result.vaultOnly, 15)
    for (const key of Object.keys(totals)) {
      totals[key] += Array.isArray(result[key]) ? result[key].length : result[key]
    }
  }

  console.log(
    `\nTotal: ${totals.added} added, ${totals.updated} updated, ${totals.unchanged} unchanged, ` +
      `${totals.vaultOnly} vault-only left untouched`,
  )
  if (backups && !dryRun && totals.backedUp)
    console.log(`Backup of overwritten vault files: ${backupRoot}`)
  return totals
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (error) {
    console.error(`mirror-vault failed: ${error.message}`)
    process.exit(1)
  }
}
