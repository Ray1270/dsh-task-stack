/**
 * Host-free plugin probe.
 *
 * A full DSH boot composes a profile directory and therefore writes outside
 * this workspace, which is not always permitted. This probe verifies the same
 * contract the Cordis loader depends on, without booting a profile:
 *
 *   1. the compiled entry imports as an ES module;
 *   2. it exports `name`, `inject` (containing `tools`), and `apply`;
 *   3. `apply(ctx)` runs against a real Cordis context whose `tools` service is
 *      provided, and its log line reaches `ctx.logger`;
 *   4. nothing throws, so the plugin's own startup path is clean.
 *
 * Usage: `pnpm probe` (after `pnpm build`).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const ENTRY = new URL('../lib/index.js', import.meta.url)

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

/** Collected `{ name, level, args }` log records, for assertions. */
const logs = []
/** Records every definition the plugin registers, like the host registry would. */
const registry = {
  registered: [],
  register(definition) {
    this.registered.push(definition)
    return () => {}
  },
}

/** Same idea for the command registry. */
const commandRegistry = {
  registered: [],
  register(definition) {
    this.registered.push(definition)
    return () => {}
  },
}

const ctx = new Context()
ctx.provide('tools', registry)
ctx.provide('commands', commandRegistry)

// The logger service is callable and also carries severity methods; replace the
// severity methods with recorders so the probe can assert what the plugin logged.
const loggerCalls = []
ctx.logger = Object.assign((childName) => makeLogger(String(childName)), {
  info: (...args) => loggerCalls.push(['info', ...args]),
  warn: (...args) => loggerCalls.push(['warn', ...args]),
  error: (...args) => loggerCalls.push(['error', ...args]),
  debug: (...args) => loggerCalls.push(['debug', ...args]),
})

/** Build the named-logger facade `ctx.logger(name)` returns. */
function makeLogger(childName) {
  const record = (level) => (...args) => {
    loggerCalls.push([level, ...args])
    logs.push({ name: childName, level, args })
  }
  return { name: childName, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

// Reproduce the loader's specifier resolution for the patch row's `name`.
// The app boot resolves a bare name against the config/profile URL, which is why
// the package must be reachable as `node_modules/<name>` from the invocation
// directory (an installed bundle, or a dev junction).
const packageUrl = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(await readFile(fileURLToPath(packageUrl), 'utf8'))
const anchor = manifest.name
/** The plugin's own export name is the SHORT label, not the scoped package name. */
const expectedLabel = anchor.includes('/') ? anchor.slice(anchor.indexOf('/') + 1) : anchor
let resolved
try {
  resolved = import.meta.resolve(anchor, packageUrl.href)
} catch (error) {
  resolved = `unresolved (${error instanceof Error ? error.message : String(error)})`
}
check(
  resolved === ENTRY.href,
  `patch name ${JSON.stringify(anchor)} resolves to ${resolved}, expected ${ENTRY.href}` +
    ` — is the plugin reachable as node_modules/${anchor} from the invocation directory?`,
)

const mod = await import(ENTRY.href)

check(
  mod.name === expectedLabel,
  `expected the plugin label ${JSON.stringify(expectedLabel)} (package ${JSON.stringify(anchor)}), got ${JSON.stringify(mod.name)}`,
)
check(Array.isArray(mod.inject), `inject must be an array, got ${typeof mod.inject}`)
check(mod.inject?.includes('tools') === true, `inject must include "tools", got ${JSON.stringify(mod.inject)}`)
check(mod.inject?.includes('commands') === true, `inject must include "commands", got ${JSON.stringify(mod.inject)}`)
check(typeof mod.apply === 'function', 'apply must be a function')

check(ctx.get('tools') === registry, 'the probe context must expose the provided tools service')
check(ctx.get('commands') === commandRegistry, 'the probe context must expose the provided commands service')

if (typeof mod.apply === 'function') {
  try {
    mod.apply(ctx)
  } catch (error) {
    failures.push(`apply(ctx) threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

check(loggerCalls.length > 0, 'apply() produced no log line through ctx.logger')

const registeredNames = registry.registered.map((definition) => definition.name)
check(
  JSON.stringify(registeredNames) === JSON.stringify(['focus_task', 'focus_complete', 'read_focus']),
  `expected exactly focus_task/focus_complete/read_focus to be registered, got ${JSON.stringify(registeredNames)}`,
)
check(
  commandRegistry.registered.length === 1 && commandRegistry.registered[0]?.name === 'focus',
  `expected the /focus command to register, got ${JSON.stringify(commandRegistry.registered.map((definition) => definition.name))}`,
)
for (const definition of registry.registered) {
  check(typeof definition.description === 'string' && definition.description.length > 80, `${definition.name} needs a real description`)
  check(definition.parameters?.type === 'object', `${definition.name} needs an object parameter schema`)
  check(typeof definition.output?.render === 'function', `${definition.name} needs an output renderer`)
}

if (failures.length > 0) {
  process.stderr.write(`probe: FAILED\n${failures.map((line) => `  - ${line}`).join('\n')}\n`)
  process.exit(1)
}

process.stdout.write('probe: OK\n')
process.stdout.write(`  entry   : ${ENTRY.href}\n`)
process.stdout.write(`  anchor  : ${JSON.stringify(anchor)} -> ${resolved}\n`)
process.stdout.write(`  exports : name=${JSON.stringify(mod.name)} inject=${JSON.stringify(mod.inject)}\n`)
process.stdout.write(`  tools   : ${registeredNames.join(', ')}\n`)
process.stdout.write(`  command : /${commandRegistry.registered[0]?.name} — ${commandRegistry.registered[0]?.description}\n`)
for (const definition of registry.registered) {
  const params = Object.keys(definition.parameters.properties ?? {})
  process.stdout.write(`            - ${definition.name}(${params.join(', ')}) → ${definition.output.schema.type}\n`)
}
for (const { name: logName, level, args } of logs) {
  process.stdout.write(`  log     : [${logName}] ${level}: ${args.map((value) => String(value)).join(' ')}\n`)
}

// --- live exercise -----------------------------------------------------------
// Drive the three registered tools exactly as the host would, through the real
// plugin entry point, against a real Cordis context whose `tools` service
// collects definitions. This is the probe's "does the wiring actually work"
// half; it needs no host boot and no model.
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

// A filesystem-safe prefix: a scoped package name contains `/`, which mkdtemp
// would treat as a missing subdirectory and fail with ENOENT.
const workspace = await mkdtemp(join(tmpdir(), 'dsh-task-stack-probe-'))
const sessionId = 'session-probe'
const exec = { agent: { session: { id: sessionId, header: { cwd: workspace } } } }
const byName = new Map(registry.registered.map((definition) => [definition.name, definition]))
const textOf = (content) => content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

const pushed = await byName.get('focus_task').execute({ description: 'probe: push through the plugin entry' }, exec)
const readBack = await byName.get('read_focus').execute({}, exec)
const closed = await byName.get('focus_complete').execute({ conclusion: 'probe: all three tools answered' }, exec)

process.stdout.write('\nlive exercise (no host, no model)\n')
process.stdout.write(`  focus_task     → ok=${pushed.ok} depth=${pushed.depth} top="${pushed.pushed.description}"\n`)
process.stdout.write(`  read_focus     → ok=${readBack.ok} depth=${readBack.depth} active="${readBack.top?.description}"\n`)
process.stdout.write(`  focus_complete → ok=${closed.ok} depth=${closed.depth} resumed=${closed.resumed === undefined ? 'none' : `"${closed.resumed.description}"`}\n`)
process.stdout.write(`  render (read_focus):\n${textOf(byName.get('read_focus').output.render({}, readBack)).split('\n').map((line) => `    ${line}`).join('\n')}\n`)

const statePath = join(workspace, '.dsh', 'task-stack', `${sessionId}.json`)
process.stdout.write(`  state file     : ${statePath}\n`)
process.stdout.write((await readFile(statePath, 'utf8')).split('\n').map((line) => `    ${line}`).join('\n'))
process.stdout.write('\n')
await rm(workspace, { recursive: true, force: true })
