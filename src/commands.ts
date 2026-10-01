/**
 * The human-facing `/focus` command: inspect and clear this session's task stack
 * without spending a model turn.
 *
 * The command is deliberately thin — it drives the same {@link Store} the tools
 * use, so there is one persistence path and one lock map. Every outcome is a
 * `CommandResult`; a thrown handler would be reported as an opaque failure, so
 * domain refusals (unknown subcommand, empty stack) come back as `kind: 'error'`
 * with a line that says what to do instead.
 *
 * @module dsh-task-stack/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Store } from './store.ts'
import type { TaskFrame, StoreWarning } from './types.ts'

/** Command name without the leading slash. */
export const FOCUS_COMMAND = 'focus'

/** One line of usage, shared by the command's help text and its refusals. */
const USAGE = 'usage: /focus [done <conclusion> | clear]'

/** The slice of `Agent` the command reads; identical to what the tools read. */
interface CallerSession {
  sessionId: string
  cwd: string
}

/**
 * Build the `/focus` definition.
 *
 * Exported separately from registration so tests can drive the handler against a
 * store without a live command registry.
 *
 * @param store - the plugin's single store instance.
 * @returns the registry-ready command definition.
 */
export function focusCommandDefinition(store: Store): CommandDefinition {
  return {
    name: FOCUS_COMMAND,
    description: "Show this session's task stack, close the current task, or clear the stack",
    input: { hint: '[done <conclusion> | clear]' },
    handler: (invocation) => runFocusCommand(store, invocation),
  }
}

/**
 * Register `/focus` on the host command registry.
 *
 * @param ctx - plugin context carrying the `commands` service.
 * @param store - the plugin's single store instance.
 * @returns a disposer that unregisters the command (idempotent).
 */
export function registerFocusCommand(ctx: Pick<Context, 'commands'>, store: Store): () => void {
  return ctx.commands.register(focusCommandDefinition(store))
}

/** Dispatch one invocation; never throws for a domain refusal. */
async function runFocusCommand(store: Store, invocation: CommandInvocation): Promise<CommandResult> {
  const caller = callerOf(invocation.agent)
  if (caller === undefined) {
    return { kind: 'error', text: `dsh-task-stack: /${FOCUS_COMMAND} needs an owning session` }
  }

  const input = invocation.rawInput.trim()
  const [verb = '', ...rest] = input.length === 0 ? [] : input.split(/\s+/u)
  const argument = rest.join(' ').trim()

  switch (verb) {
    case '':
      return show(store, caller)
    case 'done':
      if (argument.length === 0) {
        return { kind: 'error', text: `/${FOCUS_COMMAND} done needs a one-line conclusion. ${USAGE}` }
      }
      return complete(store, caller, argument)
    case 'clear':
      return clear(store, caller)
    default:
      return { kind: 'error', text: `/${FOCUS_COMMAND}: unknown subcommand ${JSON.stringify(verb)}. ${USAGE}` }
  }
}

/** Read the stack and render it as plain text. */
async function show(store: Store, caller: CallerSession): Promise<CommandResult> {
  const snapshot = await store.getSnapshot(store.locate(caller.sessionId, caller.cwd))
  const lines = [`Task stack (depth ${snapshot.stack.length})`]
  if (snapshot.stack.length === 0) {
    lines.push('  (no active task)')
  } else {
    for (let depth = 1; depth <= snapshot.stack.length; depth += 1) {
      const frame = snapshot.stack[snapshot.stack.length - depth]
      if (frame === undefined) continue
      lines.push(`  ${depth}. [${frame.status === 'active' ? 'active' : 'paused'}] ${frame.description}`)
    }
  }
  lines.push('', `Recent history (${snapshot.history.length})`)
  if (snapshot.history.length === 0) {
    lines.push('  (nothing completed yet)')
  } else {
    for (const entry of [...snapshot.history].reverse()) {
      lines.push(`  - ${entry.description} -> ${entry.conclusion}`)
    }
  }
  lines.push('', USAGE)
  return { kind: 'success', text: [...lines, ...warningLines(snapshot.warnings)].join('\n') }
}

/** Pop the top frame with the given conclusion. */
async function complete(store: Store, caller: CallerSession, conclusion: string): Promise<CommandResult> {
  const result = await store.popTask(store.locate(caller.sessionId, caller.cwd), conclusion)
  if (!result.ok) {
    return { kind: 'error', text: `/${FOCUS_COMMAND} done: ${result.message}` }
  }
  const { completed, resumed, stack, warnings } = result.value
  const lines = [`Cleared: ${completed.description}`, `Conclusion: ${completed.conclusion}`]
  lines.push(
    resumed === undefined
      ? 'The stack is now empty.'
      : `Resumed (depth ${stack.length}): ${resumed.description}`,
  )
  return { kind: 'success', text: [...lines, ...warningLines(warnings)].join('\n') }
}

/** Pop every frame, recording each so nothing silently disappears. */
async function clear(store: Store, caller: CallerSession): Promise<CommandResult> {
  const { cleared, warnings } = await store.clearStack(store.locate(caller.sessionId, caller.cwd), 'cleared via /focus')
  if (cleared.length === 0) {
    return { kind: 'success', text: 'The stack was already empty; nothing to clear.' }
  }
  const lines = [
    `Cleared ${cleared.length} task(s):`,
    ...[...cleared].reverse().map((frame: TaskFrame) => `  - ${frame.description}`),
    'Each was recorded in history as "cleared via /focus".',
  ]
  return { kind: 'success', text: [...lines, ...warningLines(warnings)].join('\n') }
}

/** The calling session, or `undefined` when the invocation has no usable agent. */
function callerOf(agent: Agent | undefined): CallerSession | undefined {
  // A handler may be invoked with a malformed agent (a foreign or replay-only
  // caller); treat that like no agent at all instead of throwing, because a
  // thrown handler settles as an opaque command error.
  const session = agent?.session
  if (session === undefined) return undefined
  return { sessionId: String(session.id), cwd: session.header.cwd ?? process.cwd() }
}

/** Append state-file warnings to a command result. */
function warningLines(warnings: readonly StoreWarning[]): string[] {
  if (warnings.length === 0) return []
  return ['', ...warnings.map((warning) => `warning (${warning.code}): ${warning.message}`)]
}
