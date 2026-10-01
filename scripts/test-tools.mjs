/**
 * Tool-layer test: no DSH process, no model. Imports the compiled
 * `lib/tools.js`, drives each tool's real wrapper (`defineTool`'s argument
 * validation included) with a fake `exec.agent`, and asserts the canonical
 * value, the model-facing markdown, and the on-disk result.
 *
 * Usage: `pnpm test:tools` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { focusCompleteTool, focusTaskTool, readFocusTool, registerFocusTools } = await import('../lib/tools.js')
const { Store } = await import('../lib/store.js')
const { resolveConfig } = await import('../lib/types.js')

const warnings = []
const logger = { info: () => {}, warn: (format, ...rest) => warnings.push(`${String(format)} ${rest.map(String).join(' ')}`) }

const root = await mkdtemp(join(tmpdir(), 'dsh-task-stack-tools-'))
const sessionId = 'session-tools-test'
const cwd = join(root, 'workspace')

/** A stand-in for `exec`: only `agent.session` is read by the tools. */
const exec = { agent: { session: { id: sessionId, header: { cwd } } } }
/** A non-agent caller, which must be a loud contract failure. */
const agentlessExec = {}

const config = resolveConfig({ stateDir: '.dsh/task-stack', maxStackDepth: 2, historyLimit: 2 })
const store = new Store(config, logger)
const statePath = store.locate(sessionId, cwd).path

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ok  ${name}\n`)
}

/** The model-visible text of a rendered result. */
const textOf = (content) => content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

process.stdout.write('tool tests\n')

const focusTask = focusTaskTool(store)
const focusComplete = focusCompleteTool(store)
const readFocus = readFocusTool(store)

// --- registration ------------------------------------------------------------
await check('registerFocusTools registers exactly the three tool names', () => {
  const registered = []
  const fake = {
    register: (definition) => {
      registered.push(definition.name)
      return () => {}
    },
  }
  const dispose = registerFocusTools({ tools: fake }, store)
  assert.deepEqual(registered, ['focus_task', 'focus_complete', 'read_focus'])
  dispose()
})

await check('the shared schemas are complete for every tool', () => {
  for (const tool of [focusTask, focusComplete, readFocus]) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.description.length > 80, `${tool.name} needs a real model-facing description`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.deepEqual(Object.keys(focusTask.parameters.properties), ['description'])
  assert.deepEqual(Object.keys(focusComplete.parameters.properties), ['conclusion'])
  assert.deepEqual(Object.keys(readFocus.parameters.properties), [])
})

await check('concurrency policy: mutations exclusive, read safe', () => {
  assert.equal(focusTask.isConcurrencySafe({ description: 'x' }), false)
  assert.equal(focusComplete.isConcurrencySafe({ conclusion: 'x' }), false)
  assert.equal(readFocus.isConcurrencySafe({}), true)
})

// --- focus_task --------------------------------------------------------------
let firstTaskId

await check('focus_task pushes, renders, and persists', async () => {
  const args = { description: '  wire the tools into the plugin  ' }
  assert.equal(focusTask.parameters.properties.description.type, 'string')
  assert.ok(focusTask.parameters.required?.includes('description'), 'description must be required')
  const value = await focusTask.execute(args, exec)

  assert.equal(value.ok, true)
  assert.equal(value.depth, 1)
  assert.equal(value.pushed.description, 'wire the tools into the plugin', 'description must be trimmed')
  assert.equal(value.pushed.status, 'active')
  assert.match(value.pushed.id, /^task-[0-9a-f-]{36}$/)
  firstTaskId = value.pushed.id

  const text = textOf(focusTask.output.render(args, value))
  assert.match(text, /Focus set \(depth 1\)/)
  assert.match(text, /wire the tools into the plugin/)
  assert.match(text, /1\. \*\*active\*\*/)

  const document = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(document.stack.length, 1)
  assert.equal(document.stack[0].id, firstTaskId)
  assert.equal(document.stack[0].status, 'active')
})

await check('a second focus_task pauses the first and keeps depth honest', async () => {
  const args = { description: 'run the end-to-end check' }
  const value = await focusTask.execute(args, exec)
  assert.equal(value.depth, 2)
  assert.deepEqual(
    value.stack.map((frame) => frame.status),
    ['paused', 'active'],
  )
  const text = textOf(focusTask.output.render(args, value))
  assert.match(text, /Focus set \(depth 2\)/)
  // Deepest first, so the last line is the new active task at depth 1.
  assert.match(text, /2\. paused — wire the tools into the plugin/)
  assert.match(text, /1\. \*\*active\*\* — run the end-to-end check/)
})

await check('focus_task refuses at the depth cap instead of throwing', async () => {
  const args = { description: 'one too many' }
  const value = await focusTask.execute(args, exec)
  assert.equal(value.ok, false)
  assert.equal(value.code, 'stack-full')
  assert.match(String(value.reason), /full \(2\/2 tasks\)/)
  assert.equal(value.depth, 2, 'the refusal must report the real current depth')
  assert.equal(value.stack.length, 2)
  // Rendering a refusal is its own code path: it must not read success-only
  // fields, and the model must still learn why nothing happened.
  const text = textOf(focusTask.output.render(args, value))
  assert.match(text, /Focus unchanged \(stack-full\)/)
  assert.match(text, /full \(2\/2 tasks\)/)
  assert.match(text, /1\. \*\*active\*\* — run the end-to-end check/)
  const document = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(document.stack.length, 2, 'a refused push must not touch the file')
})

await check('focus_task rejects blank and non-string descriptions', async () => {
  await assert.rejects(() => focusTask.execute({ description: '   ' }, exec), /non-empty `description`/)
  await assert.rejects(() => focusTask.execute({}, exec), /invalid arguments/)
  await assert.rejects(() => focusTask.execute({ description: 42 }, exec), /invalid arguments/)
})

await check('an agentless call is a loud contract failure', async () => {
  await assert.rejects(() => focusTask.execute({ description: 'no agent' }, agentlessExec), /owning agent session/)
  await assert.rejects(() => readFocus.execute({}, agentlessExec), /owning agent session/)
})

// --- read_focus --------------------------------------------------------------
await check('read_focus renders the stack and an empty history', async () => {
  const value = await readFocus.execute({}, exec)
  assert.equal(value.ok, true)
  assert.equal(value.depth, 2)
  assert.equal(value.top?.description, 'run the end-to-end check')
  assert.equal(value.history.length, 0)

  const text = textOf(readFocus.output.render({}, value))
  assert.match(text, /## Task stack \(depth 2\)/)
  assert.match(text, /2\. paused — wire the tools into the plugin/)
  assert.match(text, /1\. \*\*active\*\* — run the end-to-end check/)
  assert.match(text, /### Recent history \(0\)/)
  assert.match(text, /nothing completed yet/)
})

await check('read_focus on an untouched workspace says so without a warning', async () => {
  const freshStore = new Store(config, logger)
  const value = await readFocusTool(freshStore).execute({}, { agent: { session: { id: 'session-fresh', header: { cwd: join(root, 'fresh') } } } })
  assert.equal(value.depth, 0)
  assert.equal(value.top, undefined)
  assert.deepEqual(value.warnings, [])
  const text = textOf(readFocusTool(freshStore).output.render({}, value))
  assert.match(text, /_\(no active task\)_/)
  assert.ok(!text.includes('State file warnings'), 'a missing file is not a warning')
  freshStore.release()
})

await check('read_focus surfaces a corrupt file as a warning, not an error', async () => {
  const brokenStore = new Store(config, logger)
  const brokenCwd = join(root, 'broken')
  const brokenPath = brokenStore.locate('session-broken', brokenCwd).path
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(join(brokenCwd, '.dsh', 'task-stack'), { recursive: true })
  await writeFile(brokenPath, 'not json at all', 'utf8')

  const brokenRead = readFocusTool(brokenStore)
  const value = await brokenRead.execute({}, { agent: { session: { id: 'session-broken', header: { cwd: brokenCwd } } } })
  assert.equal(value.depth, 0)
  assert.equal(value.warnings.length, 1)
  assert.equal(value.warnings[0].code, 'invalid-json')
  const text = textOf(brokenRead.output.render({}, value))
  assert.match(text, /State file warnings/)
  assert.match(text, /invalid-json/)
  brokenStore.release()
})

await check('every refusal value also renders (the demo crash that shipped)', async () => {
  // Regression: the success renderers used to read success-only fields, so a
  // refused call crashed the renderer after its value validated. Drive both
  // refusal paths and render each.
  const capStore = new Store({ ...config, maxStackDepth: 1 }, logger)
  const capCwd = join(root, 'render-refusal')
  const capTask = focusTaskTool(capStore)
  const capComplete = focusCompleteTool(capStore)
  const capExec = { agent: { session: { id: 'session-render', header: { cwd: capCwd } } } }

  await capTask.execute({ description: 'fills the cap' }, capExec)
  const fullArgs = { description: 'over the cap' }
  const full = await capTask.execute(fullArgs, capExec)
  assert.equal(full.ok, false)
  assert.doesNotThrow(() => capTask.output.render(fullArgs, full))
  assert.match(textOf(capTask.output.render(fullArgs, full)), /Focus unchanged/)

  await capComplete.execute({ conclusion: 'empties it' }, capExec)
  const emptyArgs = { conclusion: 'nothing left' }
  const empty = await capComplete.execute(emptyArgs, capExec)
  assert.equal(empty.ok, false)
  assert.doesNotThrow(() => capComplete.output.render(emptyArgs, empty))
  assert.match(textOf(capComplete.output.render(emptyArgs, empty)), /Focus unchanged/)
  capStore.release()
})

// --- focus_complete ----------------------------------------------------------
await check('focus_complete pops, records the conclusion, and resumes the frame below', async () => {
  const args = { conclusion: '  both tools wired and covered by tests  ' }
  const value = await focusComplete.execute(args, exec)

  assert.equal(value.ok, true)
  assert.equal(value.completed.description, 'run the end-to-end check')
  assert.equal(value.completed.conclusion, 'both tools wired and covered by tests', 'conclusion must be trimmed')
  assert.equal(value.resumed?.description, 'wire the tools into the plugin')
  assert.equal(value.resumed?.status, 'active')
  assert.equal(value.depth, 1)

  const text = textOf(focusComplete.output.render(args, value))
  assert.match(text, /Focus cleared: run the end-to-end check/)
  assert.match(text, /Conclusion: both tools wired and covered by tests/)
  assert.match(text, /Resumed \(depth 1\): wire the tools into the plugin/)

  const document = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(document.history.length, 1)
  assert.equal(document.history[0].conclusion, 'both tools wired and covered by tests')
  assert.equal(document.stack.length, 1)
  assert.equal(document.stack[0].status, 'active')
})

await check('the final focus_complete empties the stack and says so', async () => {
  const args = { conclusion: 'phase 3 tools verified' }
  const value = await focusComplete.execute(args, exec)
  assert.equal(value.ok, true)
  assert.equal(value.resumed, undefined)
  assert.equal(value.depth, 0)
  const text = textOf(focusComplete.output.render(args, value))
  assert.match(text, /The stack is now empty/)
})

await check('focus_complete on an empty stack refuses with guidance', async () => {
  const args = { conclusion: 'nothing to do' }
  const value = await focusComplete.execute(args, exec)
  assert.equal(value.ok, false)
  assert.equal(value.code, 'stack-empty')
  assert.match(String(value.reason), /no active task/)
  assert.equal(value.depth, 0)
  const text = textOf(focusComplete.output.render(args, value))
  assert.match(text, /Focus unchanged \(stack-empty\)/)
  assert.match(text, /_\(no active task\)_/)
})

await check('focus_complete rejects a blank conclusion', async () => {
  await assert.rejects(() => focusComplete.execute({ conclusion: '   ' }, exec), /non-empty `conclusion`/)
  await assert.rejects(() => focusComplete.execute({}, exec), /invalid arguments/)
})

// --- history limit reaches the model -----------------------------------------
await check('history trimming is visible through read_focus', async () => {
  // historyLimit is 2: push/pop three tasks and only the last two must remain.
  for (const name of ['h1', 'h2', 'h3']) {
    await focusTask.execute({ description: name }, exec)
    await focusComplete.execute({ conclusion: `done ${name}` }, exec)
  }
  const value = await readFocus.execute({}, exec)
  assert.deepEqual(
    value.history.map((entry) => entry.description),
    ['h2', 'h3'],
  )
  const text = textOf(readFocus.output.render({}, value))
  assert.match(text, /### Recent history \(2\)/)
  assert.match(text, /- h3 → done h3/)
  assert.ok(!text.includes('- h1 →'), 'the trimmed record must not reach the model')
})

// --- tool registration doubles -------------------------------------------------
await check('a second registration of the same names is still one set', () => {
  const registered = []
  const fake = { register: (definition) => { registered.push(definition.name); return () => {} } }
  const disposeA = registerFocusTools({ tools: fake }, store)
  const disposeB = registerFocusTools({ tools: fake }, store)
  assert.equal(registered.length, 6)
  disposeA()
  disposeB()
})

await store.release()
await rm(root, { recursive: true, force: true })
process.stdout.write(`tool tests: ${passed} passed\n`)
