// Reports translation keys that components pass to t() but that no locale file
// defines. Those fall back to the English default baked into the call, which is
// why parts of the UI stay English no matter which language is selected.
import fs from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..", "src")
const localesDir = path.join(root, "i18n", "locales")

const flatten = (obj, prefix = "", out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === "object") flatten(v, key, out)
    else out[key] = v
  }
  return out
}

const locales = Object.fromEntries(
  fs.readdirSync(localesDir).map((lang) => [
    lang,
    flatten(
      JSON.parse(fs.readFileSync(path.join(localesDir, lang, "translation.json"), "utf8")),
    ),
  ]),
)

const sourceFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) sourceFiles.push(p)
  }
}
walk(root)

// Keys reach t() two ways: written inline, or held in a data table and passed
// as a variable (`t(tab.labelKey)`). Catch both, otherwise whole tab bars and
// script lists look translated when they are not.
const PATTERNS = [
  // t("some.key", "Default text") — needs a dot, to skip t(variable).
  /\bt\(\s*["'`]([\w.]+\.[\w.]+)["'`]/g,
  // labelKey: "some.key", nameKey: "…", descriptionKey: "…", hintKey: "…"
  /\b\w*[kK]ey:\s*["'`]([\w.]+\.[\w.]+)["'`]/g,
]

const used = new Map()
for (const file of sourceFiles) {
  const src = fs.readFileSync(file, "utf8")
  const rel = path.relative(root, file).replaceAll("\\", "/")
  for (const pattern of PATTERNS) {
    for (const m of src.matchAll(pattern)) {
      if (!used.has(m[1])) used.set(m[1], new Set())
      used.get(m[1]).add(rel)
    }
  }
}

// i18next plurals live under `key_one` / `key_other`, so a bare `key` that has
// those suffixed forms is defined even though the exact string isn't present.
const defined = (table, key) =>
  key in table || `${key}_one` in table || `${key}_other` in table

const base = locales.en ?? {}
const missing = [...used.keys()].filter((k) => !defined(base, k)).sort()

console.log(`t() keys used: ${used.size}`)
for (const [lang, table] of Object.entries(locales)) {
  const absent = Object.keys(base).filter((k) => !(k in table))
  console.log(`  ${lang}: ${Object.keys(table).length} keys, ${absent.length} missing vs en`)
}
console.log(`\nUsed in code but defined in NO locale file: ${missing.length}`)

const byFile = new Map()
for (const key of missing) {
  const file = [...used.get(key)][0]
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push(key)
}
for (const file of [...byFile.keys()].sort()) {
  console.log(`\n${file}  (${byFile.get(file).length})`)
  for (const k of byFile.get(file)) console.log(`  ${k}`)
}
