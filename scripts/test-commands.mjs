/**
 * `/focus` command test: drives the real command definition's handler against a
 * real store, the way the command registry would, plus the registration path.
 *
 * Usage: `pnpm test:commands` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { focusCommandDefinition, registerFocusCommand, FOCUS_COMMAND } = await import('../lib/commands.js')
const { Store } = await import('../lib/store.js')
const { resolveConfig } = await import('../lib/types.js')

const warnings = []
const logger = { info: () => {}, warn: (format, ...rest) => warnings.push(`${String(format)} ${rest.map(String).join(' ')}`) }

const root = await mkdtemp(join(tmpdir(), 'dsh-task-stack-commands-'))
const cwd = join(root, 'workspace')
const sessionId = 'session-commands'
const config = resolveConfig({ maxStackDepth: 20, historyLimit: 5 })
const store = new Store(config, logger)
const command = focusCommandDefinition(store)

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

/** The invocation shape the registry hands a handler. */
const invoke = (rawInput, agent = { session: { id: sessionId, header: { cwd } } }) => ({
  commandId: 'cmd-test',
  agent,
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})

const run = (rawInput, agent) => command.handler(invoke(rawInput, agent))
/** The tools, driven directly, so the command and the tools share one store. */
const { focusTaskTool, readFocusTool } = await import('../lib/tools.js')
const focusTask = focusTaskTool(store)
const readFocus = readFocusTool(store)
const exec = { agent: { session: { id: sessionId, header: { cwd } } } }

process.stdout.write('command tests\n')

await check('the definition is registry-shaped', () => {
  assert.equal(command.name, FOCUS_COMMAND)
  assert.equal(command.name, 'focus')
  assert.ok(command.description.length > 20)
  assert.equal(command.input.hint.includes('done'), true)
  assert.equal(typeof command.handler, 'function')
})

await check('registerFocusCommand hands the definition to the registry', () => {
  const registered = []
  const fake = { commands: { register: (definition) => { registered.push(definition); return () => {} } } }
  const dispose = registerFocusCommand(fake, store)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'focus')
  dispose()
})

await check('bare /focus reports an empty stack', async () => {
  const result = await run('')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Task stack \(depth 0\)/)
  assert.match(result.text, /\(no active task\)/)
  assert.match(result.text, /Recent history \(0\)/)
  assert.match(result.text, /usage: \/focus/)
})

await check('bare /focus lists the stack with active/paused marks', async () => {
  await focusTask.execute({ description: 'parent task' }, exec)
  await focusTask.execute({ description: 'nested task' }, exec)
  const result = await run('   ')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Task stack \(depth 2\)/)
  assert.match(result.text, /1\. \[active\] nested task/)
  assert.match(result.text, /2\. \[paused\] parent task/)
})

await check('/focus done closes the top task and reports the resume', async () => {
  const result = await run('done  finished via command  ')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Cleared: nested task/)
  // The conclusion keeps its internal spacing but is trimmed at the edges.
  assert.match(result.text, /Conclusion: finished via command/)
  assert.match(result.text, /Resumed \(depth 1\): parent task/)
})

await check('/focus done without a conclusion is refused with usage', async () => {
  const result = await run('done')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /needs a one-line conclusion/)
  assert.match(result.text, /usage: \/focus/)
})

await check('/focus done on an empty stack is a readable refusal', async () => {
  await run('done clear the parent')
  const result = await run('done nothing left')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /already empty/)
})

await check('/focus clear empties the stack and records every frame', async () => {
  await focusTask.execute({ description: 'clear-a' }, exec)
  await focusTask.execute({ description: 'clear-b' }, exec)
  const result = await run('clear')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Cleared 2 task\(s\)/)
  assert.match(result.text, /clear-b/)
  assert.match(result.text, /clear-a/)

  const after = await readFocus.execute({}, exec)
  assert.equal(after.depth, 0)
  assert.deepEqual(
    after.history.slice(-2).map((entry) => [entry.description, entry.conclusion]),
    [
      ['clear-a', 'cleared via /focus'],
      ['clear-b', 'cleared via /focus'],
    ],
  )
})

await check('/focus clear on an empty stack says so', async () => {
  const result = await run('clear')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /already empty/)
})

await check('an unknown subcommand is refused with usage', async () => {
  const result = await run('wat')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown subcommand "wat"/)
  assert.match(result.text, /usage: \/focus/)
})

await check('an invocation without an agent fails loudly', async () => {
  const result = await run('', {})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /needs an owning session/)
})

await check('/focus reads the same state the tools wrote', async () => {
  await focusTask.execute({ description: 'shared store check' }, exec)
  const result = await run('')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /shared store check/)
  await run('done cleanup')
})

await check('a corrupt state file surfaces as a warning, not an exception', async () => {
  const brokenCwd = join(root, 'broken')
  const broken = new Store(config, logger)
  const brokenCommand = focusCommandDefinition(broken)
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(brokenCwd, '.dsh', 'task-stack'), { recursive: true })
  await writeFile(join(brokenCwd, '.dsh', 'task-stack', 'session-broken.json'), '{ not json', 'utf8')

  const result = await brokenCommand.handler(
    invoke('', { session: { id: 'session-broken', header: { cwd: brokenCwd } } }),
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Task stack \(depth 0\)/)
  assert.match(result.text, /warning \(invalid-json\)/)
  broken.release()
})

await store.release()
await rm(root, { recursive: true, force: true })
process.stdout.write(`command tests: ${passed} passed\n`)
