/**
 * Place the hand-written client bundle into `lib/`.
 *
 * The bundle is shipped exactly as written, so this step has no transform: it copies
 * the source and then refuses to continue if the result is not the shape the DSH
 * client loader evaluates. That check is the point — a bundle that lost its
 * `__ModuleLoader__` call, or was renamed away from the package id, would fail at
 * load time in the browser with nothing in the host log to explain it.
 *
 * @module dsh-task-stack/scripts/build-client
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const here = join(import.meta.dirname, '..')
const sourcePath = join(here, 'client', 'client.js')
const outPath = join(here, 'lib', 'client.js')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))

const source = readFileSync(sourcePath, 'utf8')

/** Fail loudly with the reason rather than shipping an unloadable bundle. */
function refuse(reason) {
  process.stderr.write(`build-client: ${reason}\n`)
  process.exit(1)
}

if (!source.includes('window.__ModuleLoader__.load(')) {
  refuse('the bundle does not call window.__ModuleLoader__.load()')
}

// Parse without executing: a syntax error here is a syntax error in every browser.
try {
  new vm.Script(source, { filename: 'client.js' })
} catch (error) {
  refuse(`the bundle does not parse: ${error instanceof Error ? error.message : String(error)}`)
}

// The loader id must be the package name: the host serves the file at
// /plugins/<id>/client.js and the module table is keyed by it.
const id = /id:\s*'([^']+)'/.exec(source)?.[1]
if (id !== pkg.name) {
  refuse(`bundle id ${JSON.stringify(id)} does not match package name ${JSON.stringify(pkg.name)}`)
}

if (pkg.dsh?.client === undefined) {
  refuse('package.json is missing dsh.client, so the host would never load this bundle')
}

mkdirSync(join(here, 'lib'), { recursive: true })
writeFileSync(outPath, source, 'utf8')
process.stdout.write(`build-client: ok ${pkg.name} -> lib/client.js (${String(Buffer.byteLength(source, 'utf8'))} bytes)\n`)
