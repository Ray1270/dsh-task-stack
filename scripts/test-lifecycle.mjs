/**
 * Lifecycle test: mount the plugin as a real Cordis child fiber (the shape the
 * loader uses for one patch row) over a REAL `@deepseek-ai/dsh-tools`
 * `ToolRuntime`, then unload and reload it.
 *
 * This is the phase 5 gate. It proves the resource contract a hot reload
 * depends on:
 *
 *   1. `apply` leaves no unmanaged resource: one plugin-owned effect plus one
 *      `tools.register()` effect per tool;
 *   2. unloading the plugin fiber deregisters all three tools and leaves no
 *      disposables behind, so a reload cannot report "already registered";
 *   3. reloading on the same context succeeds and the store is usable again;
 *   4. disposing the plugin twice is harmless.
 *
 * Usage: `pnpm test:lifecycle` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const plugin = await import('../lib/index.js')

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

process.stdout.write('lifecycle tests\n')

const config = { stateDir: '.dsh/task-stack', maxStackDepth: 20, historyLimit: 100 }

/** A context with one real ToolRuntime mounted, plus its injected systemPrompt. */
function bootRuntime() {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools: () => () => {},
    section: () => () => {},
    getSectionOrder: () => 0,
  })
  const runtime = new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 10 })
  // The plugin also injects `commands`; the base bundle provides it in a real
  // profile. Keep it ON the root context so it survives the child fiber's unload.
  const commands = {
    registered: [],
    register(definition) {
      this.registered.push(definition)
      return () => {}
    },
  }
  ctx.provide('commands', commands)
  return { ctx, runtime, commands }
}

/** Load the plugin exactly as a loader row would: one child fiber. */
async function mount(ctx) {
  const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
  await fiber.await()
  return fiber
}

await check('mounting the plugin row publishes the three tools', async () => {
  const { ctx, runtime } = bootRuntime()
  const fiber = await mount(ctx)

  assert.ok(runtime.get('focus_task'), 'focus_task must be registered')
  assert.ok(runtime.get('focus_complete'), 'focus_complete must be registered')
  assert.ok(runtime.get('read_focus'), 'read_focus must be registered')
  const names = runtime.view(undefined).restrictableNames
  assert.ok(names.has('focus_task') && names.has('focus_complete') && names.has('read_focus'))

  // Resource accounting: the plugin owns one labeled effect that covers both
  // registries and the store's lock map, and each `ctx.tools.register()` adds its
  // own Cordis-managed effect beneath it.
  const labels = fiber.getEffects().map((meta) => meta.label)
  assert.equal(labels.filter((label) => label === 'dsh-task-stack').length, 1)
  assert.equal(labels.filter((label) => label === 'tools.register()').length, 3)

  await fiber.dispose()
  await ctx.fiber.dispose()
})

await check('unloading the plugin row removes the tools and every disposable', async () => {
  const { ctx, runtime } = bootRuntime()
  const fiber = await mount(ctx)
  await fiber.dispose()

  assert.equal(runtime.get('focus_task'), undefined, 'focus_task must be gone after unload')
  assert.equal(runtime.get('focus_complete'), undefined)
  assert.equal(runtime.get('read_focus'), undefined)
  assert.deepEqual(fiber.getEffects(), [], 'no disposables may survive the unload')

  await ctx.fiber.dispose()
})

await check('unload then reload is clean: no "already registered"', async () => {
  const { ctx, runtime } = bootRuntime()

  const first = await mount(ctx)
  await first.dispose()
  assert.equal(runtime.get('read_focus'), undefined)

  // Reloading on the same context is where a leaked registration would throw
  // "tool ... is already registered".
  const second = await mount(ctx)
  assert.ok(runtime.get('focus_task'), 'reload must succeed')
  assert.equal(second.getEffects().filter((meta) => meta.label === 'dsh-task-stack').length, 1)
  assert.equal(second.getEffects().filter((meta) => meta.label === 'tools.register()').length, 3)

  // A double dispose must stay harmless.
  await second.dispose()
  await second.dispose()
  assert.equal(runtime.get('focus_task'), undefined)

  await ctx.fiber.dispose()
})

await check('the store is re-created and usable after a reload', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-task-stack-lifecycle-'))
  const { ctx, runtime } = bootRuntime()
  const exec = { agent: { session: { id: 'session-lifecycle', header: { cwd: workspace } } } }

  const first = await mount(ctx)
  const tool = runtime.get('focus_task')
  assert.ok(tool)
  await tool.execute({ description: 'before reload' }, exec)
  await first.dispose()

  const second = await mount(ctx)
  const reloaded = runtime.get('focus_task')
  assert.ok(reloaded)
  const pushed = await reloaded.execute({ description: 'after reload' }, exec)
  assert.equal(pushed.ok, true)
  assert.equal(pushed.depth, 2, 'the state file must still hold the frame pushed before the reload')

  const document = JSON.parse(await readFile(join(workspace, '.dsh', 'task-stack', 'session-lifecycle.json'), 'utf8'))
  assert.deepEqual(
    document.stack.map((frame) => frame.description),
    ['before reload', 'after reload'],
  )

  await second.dispose()
  await ctx.fiber.dispose()
  await rm(workspace, { recursive: true, force: true })
})

process.stdout.write(`lifecycle tests: ${passed} passed\n`)
