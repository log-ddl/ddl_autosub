// Builds the `latest.json` that the Tauri updater reads.
//
// `tauri build` produces the installer and a detached `.sig`, but not the
// manifest tying them together — that part is normally done by tauri-action in
// CI. We build locally, so generate it here and upload it with the installer.
//
// Usage:  node scripts/make-latest-json.mjs [--notes "What changed"]
import fs from "node:fs"
import path from "node:path"

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
const version = pkg.version

const notesFlag = process.argv.indexOf("--notes")
const notes = notesFlag !== -1 ? process.argv[notesFlag + 1] ?? "" : `AutoSubs ${version}`

// Honour CARGO_TARGET_DIR, which this project sets on Windows to dodge the
// 260-character path limit.
const targetDir = process.env.CARGO_TARGET_DIR || path.join("src-tauri", "target")
const nsisDir = path.join(targetDir, "release", "bundle", "nsis")

if (!fs.existsSync(nsisDir)) {
  console.error(`No installer directory at ${nsisDir}. Run \`npm run build:win\` first.`)
  process.exit(1)
}

const files = fs.readdirSync(nsisDir)
const installer = files.find((f) => f.endsWith("-setup.exe") && f.includes(version))
if (!installer) {
  console.error(`No installer for ${version} in ${nsisDir}. Found: ${files.join(", ") || "nothing"}`)
  process.exit(1)
}
const sigFile = `${installer}.sig`
if (!files.includes(sigFile)) {
  console.error(
    `${sigFile} is missing. The build did not sign the installer — check that ` +
      `TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD are set in .env.`,
  )
  process.exit(1)
}

const signature = fs.readFileSync(path.join(nsisDir, sigFile), "utf8").trim()
const repo = "log-ddl/autosub"

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      // The updater follows this URL, so the release tag must be `v<version>`
      // and the installer must be attached to it under exactly this name.
      url: `https://github.com/${repo}/releases/download/v${version}/${installer}`,
    },
  },
}

const out = path.join(nsisDir, "latest.json")
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n")

console.log(`Wrote ${out}`)
console.log(`\nUpload BOTH of these to release v${version}:`)
console.log(`  ${path.join(nsisDir, installer)}`)
console.log(`  ${out}`)
console.log(`\n  gh release create v${version} "${path.join(nsisDir, installer)}" "${out}" \\`)
console.log(`     --repo ${repo} --title "v${version}" --notes ${JSON.stringify(notes)}`)
