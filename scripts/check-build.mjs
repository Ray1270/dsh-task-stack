/**
 * Post-build sanity check: the compiled entry must exist, be importable as an
 * ES module, and export the three names the Cordis loader reads off a function
 * plugin (`name`, `inject`, `apply`).
 *
 * This runs after `tsc`, so a broken emit or a mis-declared export fails the
 * build instead of failing later inside a host boot.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entryUrl = new URL('../lib/index.js', import.meta.url)
const entry = fileURLToPath(entryUrl)

/** Fail the build with one explanatory line. */
function fail(message) {
  process.stderr.write(`check-build: ${message}\n`)
  process.exit(1)
}

let source
try {
  source = readFileSync(entry, 'utf8')
} catch (error) {
  fail(`missing compiled entry ${entry} — run \`pnpm build\` after a clean checkout (${String(error)})`)
}

if (!/^export\s/m.test(source)) {
  fail(`${entry} does not look like an ES module emit (no top-level export)`)
}

const mod = await import(entryUrl.href)

// The plugin's own `name` export is the SHORT fiber/logger label, deliberately
// independent of the scoped package name (a scope may change; the label is what
// users see in logs). Derive the expected label from the manifest so a rename
// cannot silently desynchronize them.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const expectedLabel = manifest.name.includes('/') ? manifest.name.slice(manifest.name.indexOf('/') + 1) : manifest.name

if (mod.name !== expectedLabel) {
  fail(`expected the plugin label ${JSON.stringify(expectedLabel)} (package ${JSON.stringify(manifest.name)}), got ${JSON.stringify(mod.name)}`)
}
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) {
  fail(`inject must include 'tools', got ${JSON.stringify(mod.inject)}`)
}
if (!Array.isArray(mod.inject) || !mod.inject.includes('commands')) {
  fail(`inject must include 'commands' (the /focus command), got ${JSON.stringify(mod.inject)}`)
}
if (typeof mod.apply !== 'function') fail('apply is not a function')

process.stdout.write(`check-build: OK — ${entry} exports name/inject/apply (label ${expectedLabel})\n`)
