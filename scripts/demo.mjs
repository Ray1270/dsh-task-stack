/**
 * Readable demo over a REAL `@deepseek-ai/dsh-tools` `ToolRuntime` mounted on a
 * real Cordis context: mounts the plugin as a child fiber (the shape one loader
 * row produces), then drives the three tools through the registry the host
 * built, and prints the model-facing markdown plus the resulting state file.
 *
 * Usage: `pnpm demo`
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const plugin = await import('../lib/index.js')

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..', '.demo', 'workspace')
const session = 'session-demo'
rmSync(join(here, '..', '.demo'), { recursive: true, force: true })
mkdirSync(workspace, { recursive: true })

// --- the host side: a real tool registry over a real context ------------------
const ctx = new Context()
ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
const tools = new ToolRuntime(ctx, { mode: 'native', maxParallelSubCalls: 10 })

// The plugin also injects `commands`; the base bundle provides it in a real
// profile, so the demo provides a stand-in and shows what it registers.
const commands = {
  registered: [],
  register(definition) {
    this.registered.push(definition)
    return () => {}
  },
}
ctx.provide('commands', commands)

// One loader row = one child fiber.
const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, {
  stateDir: '.dsh/task-stack',
  maxStackDepth: 2,
  historyLimit: 10,
  statePruneDays: 0,
})
await fiber.await()

process.stdout.write('real host side\n')
process.stdout.write(`  registry : ${['focus_task', 'focus_complete', 'read_focus'].filter((name) => tools.get(name)).join(', ')}\n`)
process.stdout.write(`  commands : ${commands.registered.map((definition) => `/${definition.name}`).join(', ')}\n`)
process.stdout.write(`  effects  : ${fiber.getEffects().map((meta) => meta.label).join(' | ')}\n\n`)

// --- the model side: what the pipeline would call ----------------------------
const exec = { agent: { session: { id: session, header: { cwd: workspace } } } }
const textOf = (content) => content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

async function call(name, args) {
  const definition = tools.get(name)
  assert.ok(definition, `${name} must be registered`)
  const value = await definition.execute(args, exec)
  process.stdout.write(`── ${name}(${JSON.stringify(args)})\n`)
  process.stdout.write(`${textOf(definition.output.render(args, value)).split('\n').map((line) => `   ${line}`).join('\n')}\n`)
  process.stdout.write(`   [value] ok=${value.ok} depth=${value.depth}${value.code === undefined ? '' : ` code=${value.code}`}\n\n`)
  return value
}

await call('focus_task', { description: '给 CLI 加 JSON 导入命令' })
await call('focus_task', { description: '顺便修掉导入的错误提示' })
await call('focus_task', { description: '再推一个（maxStackDepth=2，应被拒绝）' })
await call('read_focus', {})
await call('focus_complete', { conclusion: '错误提示已改，附带单测' })
await call('read_focus', {})

// --- the human side: what `/focus` does without a model turn -----------------
const focusCommand = commands.registered[0]
const invoke = (rawInput) => ({
  commandId: 'demo',
  agent: { session: { id: session, header: { cwd: workspace } } },
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
})
for (const line of ['', 'done 导入命令已加，冒烟测试通过', 'clear', 'bogus']) {
  const result = await focusCommand.handler(invoke(line))
  process.stdout.write(`── /focus${line === '' ? '' : ` ${line}`} → ${result.kind}\n`)
  process.stdout.write(`${String(result.text).split('\n').map((text) => `   ${text}`).join('\n')}\n\n`)
}

const emptied = await call('focus_complete', { conclusion: '空栈再弹（应被拒绝）' })

// --- what lands on disk ------------------------------------------------------
const statePath = join(workspace, '.dsh', 'task-stack', `${session}.json`)
process.stdout.write(`state file: ${statePath}\n`)
process.stdout.write(readFileSync(statePath, 'utf8').split('\n').map((line) => `  ${line}`).join('\n'))

// --- unload: nothing may survive --------------------------------------------
await fiber.dispose()
await ctx.fiber.dispose()
process.stdout.write(`\nafter unload: registry=${['focus_task', 'focus_complete', 'read_focus'].filter((name) => tools.get(name)).length} tools, effects=${fiber.getEffects().length}\n`)

assert.equal(emptied.ok, false, 'the last pop must be refused')
assert.equal(emptied.code, 'stack-empty')
process.stdout.write('demo: OK\n')
