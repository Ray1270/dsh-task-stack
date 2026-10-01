/**
 * Config + boundary test: the Cordis Config schema, and end-to-end behavior of
 * a real `apply(ctx, config)` driven from a real Cordis context with a stub
 * tool registry.
 *
 * Usage: `pnpm test:config` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const { Config, apply, name, inject } = await import('../lib/index.js')

const validator = Config['~standard']

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

process.stdout.write('config tests\n')

// --- schema ------------------------------------------------------------------
await check('an empty config resolves to the documented defaults', () => {
  const result = validator.validate({})
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    stateDir: '.dsh/task-stack',
    maxStackDepth: 20,
    historyLimit: 100,
    statePruneDays: 0,
  })
})

await check('explicit values pass through untouched', () => {
  const result = validator.validate({ stateDir: '.custom/focus', maxStackDepth: 3, historyLimit: 7, statePruneDays: 30 })
  assert.deepEqual(result.value, { stateDir: '.custom/focus', maxStackDepth: 3, historyLimit: 7, statePruneDays: 30 })
})

await check('out-of-range and wrong-typed values are refused', () => {
  for (const bad of [
    { maxStackDepth: 0 },
    { maxStackDepth: -1 },
    { maxStackDepth: 1.5 },
    { historyLimit: 0 },
    { statePruneDays: -1 },
    { statePruneDays: 0.5 },
  ]) {
    const result = validator.validate(bad)
    assert.ok(result.issues !== undefined, `${JSON.stringify(bad)} must fail validation`)
  }
  assert.ok(validator.validate({ stateDir: '' }).issues !== undefined, 'an empty stateDir must fail validation')
  assert.ok(validator.validate({ maxStackDepth: 'many' }).issues !== undefined, 'a non-number must fail validation')
})

await check('the schema projects a described JSON schema for tooling', () => {
  const json = Config.toJSON()
  const root = json.refs[json.uid]
  assert.equal(root.type, 'object')
  assert.deepEqual(Object.keys(root.dict).sort(), ['historyLimit', 'maxStackDepth', 'stateDir', 'statePruneDays'])
  for (const field of ['stateDir', 'maxStackDepth', 'historyLimit', 'statePruneDays']) {
    const node = json.refs[root.dict[field]]
    assert.ok(node.meta?.description, `${field} must carry a description`)
    assert.ok(node.meta.default !== undefined, `${field} must carry a default`)
  }
})

// --- a real apply(ctx, config) ------------------------------------------------
/** Boot the plugin against stub registries and return what it registered. */
function bootPlugin(workspace, config) {
  const ctx = new Context()
  const registered = []
  const commands = []
  ctx.provide('tools', {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  })
  ctx.provide('commands', {
    register: (definition) => {
      commands.push(definition)
      return () => {}
    },
  })
  const logger = { info: () => {}, warn: () => {} }
  apply(ctx, { ...validator.validate(config ?? {}).value })
  return {
    ctx,
    tools: new Map(registered.map((definition) => [definition.name, definition])),
    commands,
    logger,
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-task-stack-config-'))

await check('apply registers the three tools and the /focus command', () => {
  const { tools, commands } = bootPlugin(join(root, 'a'), { stateDir: '.custom/focus', maxStackDepth: 2, historyLimit: 1 })
  assert.deepEqual([...tools.keys()], ['focus_task', 'focus_complete', 'read_focus'])
  assert.deepEqual(commands.map((definition) => definition.name), ['focus'])
})

await check('stateDir decides where the state file lands', async () => {
  const workspace = join(root, 'b')
  const { tools } = bootPlugin(workspace, { stateDir: '.custom/focus' })
  const sessionId = 'session-config-b'
  const exec = { agent: { session: { id: sessionId, header: { cwd: workspace } } } }
  await tools.get('focus_task').execute({ description: 'land in a custom directory' }, exec)
  const document = JSON.parse(await readFile(join(workspace, '.custom', 'focus', `${sessionId}.json`), 'utf8'))
  assert.equal(document.stack.length, 1)
  assert.equal(document.sessionId, sessionId)
})

await check('maxStackDepth=2 is enforced at exactly two', async () => {
  const workspace = join(root, 'c')
  const { tools } = bootPlugin(workspace, { maxStackDepth: 2 })
  const exec = { agent: { session: { id: 'session-config-c', header: { cwd: workspace } } } }
  assert.equal((await tools.get('focus_task').execute({ description: 'one' }, exec)).depth, 1)
  assert.equal((await tools.get('focus_task').execute({ description: 'two' }, exec)).depth, 2)
  const third = await tools.get('focus_task').execute({ description: 'three' }, exec)
  assert.equal(third.ok, false)
  assert.equal(third.code, 'stack-full')
  assert.match(String(third.reason), /full \(2\/2 tasks\)/)
})

await check('historyLimit=1 keeps only the newest record', async () => {
  const workspace = join(root, 'd')
  const { tools } = bootPlugin(workspace, { historyLimit: 1 })
  const exec = { agent: { session: { id: 'session-config-d', header: { cwd: workspace } } } }
  for (const label of ['first', 'second']) {
    await tools.get('focus_task').execute({ description: label }, exec)
    await tools.get('focus_complete').execute({ conclusion: `closed ${label}` }, exec)
  }
  const snapshot = await tools.get('read_focus').execute({}, exec)
  assert.deepEqual(
    snapshot.history.map((entry) => entry.description),
    ['second'],
  )
  const document = JSON.parse(await readFile(join(workspace, '.dsh', 'task-stack', 'session-config-d.json'), 'utf8'))
  assert.equal(document.history.length, 1)
})

// --- boundaries through a real apply ------------------------------------------
await check('a hand-corrupted state file cannot crash a tool call', async () => {
  const workspace = join(root, 'e')
  const { tools } = bootPlugin(workspace, {})
  const exec = { agent: { session: { id: 'session-config-e', header: { cwd: workspace } } } }
  const path = join(workspace, '.dsh', 'task-stack', 'session-config-e.json')

  for (const corrupt of ['{ truncated', 'null', '"a string"', '[]', '{"version":999}', '{"version":1}']) {
    await writeFile(path, corrupt, 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(workspace, '.dsh', 'task-stack'), { recursive: true })
      await writeFile(path, corrupt, 'utf8')
    })
    const read = await tools.get('read_focus').execute({}, exec)
    assert.equal(read.ok, true, `${corrupt} must not throw`)
    assert.equal(read.depth, 0)
    assert.ok(read.warnings.length >= 1, `${corrupt} must be reported as a warning`)
    // A mutation over the same damaged file must also recover, not throw.
    const pushed = await tools.get('focus_task').execute({ description: 'recover' }, exec)
    assert.equal(pushed.ok, true, `${corrupt} must not block a push`)
  }
})

await check('a state file replaced by a directory degrades to a warning', async () => {
  const workspace = join(root, 'f')
  const { tools } = bootPlugin(workspace, {})
  const exec = { agent: { session: { id: 'session-config-f', header: { cwd: workspace } } } }
  const path = join(workspace, '.dsh', 'task-stack', 'session-config-f.json')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive: true })

  const read = await tools.get('read_focus').execute({}, exec)
  assert.equal(read.ok, true)
  assert.equal(read.depth, 0)
  assert.equal(read.warnings[0].code, 'unreadable')
})

await check('statePruneDays cleans stale files when the plugin loads', async () => {
  // The plugin prunes against the host process's working directory, which a test
  // cannot change. Run this child in a temp cwd instead of touching process.cwd.
  const { spawn } = await import('node:child_process')
  const { writeFile, utimes, mkdir, readdir, rm: remove } = await import('node:fs/promises')
  const workspace = join(root, 'prune-on-load')
  const stateDir = join(workspace, '.dsh', 'task-stack')
  await mkdir(stateDir, { recursive: true })
  // Two candidates: both older than the threshold, one is the running session's.
  const stale = join(stateDir, 'session-stale.json')
  await writeFile(stale, '{"version":1,"sessionId":"session-stale","stack":[],"history":[]}', 'utf8')
  const when = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await utimes(stale, when, when)
  const fresh = join(stateDir, 'session-fresh.json')
  await writeFile(fresh, '{"version":1,"sessionId":"session-fresh","stack":[],"history":[]}', 'utf8')

  const runner = join(workspace, 'run.mjs')
  const pluginUrl = new URL('../lib/index.js', import.meta.url).href
  // Absolute URLs for everything the child imports: a bare specifier in a script
  // under the temp workspace would resolve from THAT directory and find no
  // node_modules at all.
  const cordisUrl = import.meta.resolve('@deepseek-ai/cordis')
  await writeFile(
    runner,
    [
      `const { Context } = await import(${JSON.stringify(cordisUrl)})`,
      `const plugin = await import(${JSON.stringify(pluginUrl)})`,
      `process.chdir(process.env.DSH_TEST_WORKSPACE)`,
      `const ctx = new Context()`,
      `ctx.provide('tools', { register: () => () => {} })`,
      `ctx.provide('commands', { register: () => () => {} })`,
      `plugin.apply(ctx, { stateDir: '.dsh/task-stack', maxStackDepth: 20, historyLimit: 100, statePruneDays: 7 })`,
      `await new Promise((resolve) => setTimeout(resolve, 500))`,
      `await ctx.fiber.dispose()`,
      '',
    ].join('\n'),
    'utf8',
  )

  // The child runs FROM the plugin directory so it can resolve `@deepseek-ai/*`,
  // then chdir()s to the workspace: pruning reads `process.cwd()`, and the module
  // graph is already resolved by then.
  const { promise, resolve } = Promise.withResolvers()
  const pluginDir = fileURLToPath(new URL('..', import.meta.url))
  const child = spawn(process.execPath, [runner], {
    cwd: pluginDir,
    stdio: 'inherit',
    env: { ...process.env, DSH_TEST_WORKSPACE: workspace },
  })
  child.on('exit', (code) => resolve(code ?? 1))
  assert.equal(await promise, 0, 'the pruning child must exit cleanly')

  const remaining = (await readdir(stateDir)).sort()
  assert.deepEqual(remaining, ['session-fresh.json'], 'only the stale file may be deleted')
  await remove(runner, { force: true })
})

await check('the plugin exports the contract the loader reads', () => {
  assert.equal(name, 'dsh-task-stack')
  assert.deepEqual(inject, ['tools', 'commands'])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

await rm(root, { recursive: true, force: true })
process.stdout.write(`config tests: ${passed} passed\n`)
