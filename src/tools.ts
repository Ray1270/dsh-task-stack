/**
 * The three model-facing tools: `focus_task`, `focus_complete`, `read_focus`.
 *
 * Each tool resolves the calling session from `exec.agent` (there is no
 * tool-local workspace), because state is per session:
 * `exec.agent.session.header.cwd` is the session workspace and
 * `exec.agent.session.id` is the session id used in the state file name.
 *
 * Return contract: domain outcomes (a full stack, an empty stack) are canonical
 * values with `ok: false` plus a model-readable `reason`, never thrown errors.
 * Only a contract violation — a call with no owning agent — throws.
 *
 * @module dsh-task-stack/tools
 */

import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Store } from './store.ts'
import type { StoreWarning, TaskFrame, TaskHistoryEntry } from './types.ts'

/** A logger surface; satisfied by `ctx.logger(name)`. */
export interface ToolsLogger {
  info: (format: unknown, ...params: unknown[]) => void
  warn: (format: unknown, ...params: unknown[]) => void
}

/** The calling session, as much of it as these tools consume. */
interface CallerSession {
  /** Session id, used as the state file's identity. */
  sessionId: string
  /** Absolute session workspace directory. */
  cwd: string
}

/** One frame projected for the model. */
interface StackFrameView {
  id: string
  description: string
  status: 'active' | 'paused'
  createdAt: string
}

/** One completed record projected for the model. */
interface HistoryEntryView {
  id: string
  description: string
  conclusion: string
  completedAt: string
}

/** A non-fatal state problem projected for the model. */
interface WarningView {
  code: string
  message: string
}

/** What `focus_task` returns. */
interface FocusTaskResult {
  ok: true
  pushed: StackFrameView
  depth: number
  top: StackFrameView
  stack: StackFrameView[]
  warnings: WarningView[]
}

/** What `focus_task` returns when the depth cap refuses the push. */
interface FocusTaskRefusal {
  ok: false
  code: string
  reason: string
  depth: number
  stack: StackFrameView[]
  warnings: WarningView[]
}

/** What `focus_complete` returns. */
interface FocusCompleteResult {
  ok: true
  completed: HistoryEntryView
  resumed?: StackFrameView
  depth: number
  stack: StackFrameView[]
  warnings: WarningView[]
}

/** What `focus_complete` returns on an already-empty stack. */
interface FocusCompleteRefusal {
  ok: false
  code: string
  reason: string
  depth: number
  stack: StackFrameView[]
  warnings: WarningView[]
}

/** What `read_focus` returns. */
interface ReadFocusResult {
  ok: true
  depth: number
  top?: StackFrameView
  stack: StackFrameView[]
  history: HistoryEntryView[]
  warnings: WarningView[]
}

/** Shared description guidance: when to use the tool and when not to. */
const COMMON_GUIDANCE =
  'Call this only for work that will span several steps. Do not call it for a single question that needs one reply, for a change in how you approach the task already on top, or to announce a plan in advance.'

/**
 * Register the three focus tools on the host tool registry.
 *
 * The store is passed in rather than created here so one plugin instance owns
 * exactly one lock map, shared with state pruning and the `/focus` command.
 *
 * @param ctx - plugin context carrying the `tools` registry.
 * @param store - the plugin's single store instance.
 * @returns a disposer that unregisters all three tools (idempotent).
 */
export function registerFocusTools(ctx: { tools: ToolRuntime }, store: Store): () => void {
  const disposers = [
    ctx.tools.register(focusTaskTool(store)),
    ctx.tools.register(focusCompleteTool(store)),
    ctx.tools.register(readFocusTool(store)),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** `focus_task` — push one frame onto the top of the stack. */
export function focusTaskTool(store: Store) {
  return defineTool({
    name: 'focus_task',
    description:
      'Set the current focus: push one line describing the multi-step task you are starting, and it becomes the task that focus_complete will later pop and that read_focus reports as active. The task already on top (if any) turns paused and is resumed when the nested one completes. ' +
      'Use it when the user asks for something that needs several steps before it can be delivered, especially when the request has more than one clearly separable objective — push the outermost objective you are accountable for, not each step of your own plan. ' +
      'Do not use it for a single question that needs one reply, for a routine step inside the task already on top, or to restate the user\'s message. ' +
      'Returns the new depth and the top task; refuses when the stack is already at the configured depth cap.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description:
          'One line naming the task you are starting, in the same language the user is using (for example "add a JSON import command to the CLI"). Keep it to a single sentence; it is read back after context compaction, so it must stand alone.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          // Refusal-only fields.
          code: { type: 'string', description: 'Machine-readable refusal code, present when ok is false.' },
          reason: { type: 'string', description: 'Model-readable refusal explanation, present when ok is false.' },
          // Success-only fields: a refused push has no frame to report, so these
          // must stay optional or the refusal value fails output validation.
          pushed: { type: 'object', additionalProperties: false, properties: FRAME_PROPERTIES },
          top: { type: 'object', additionalProperties: false, properties: FRAME_PROPERTIES },
          depth: {
            type: 'integer',
            required: true,
            description: 'Number of tasks on the stack after the call (unchanged when refused).',
          },
          stack: { type: 'array', required: true, items: FRAME_ITEM },
          warnings: { type: 'array', required: true, items: WARNING_ITEM },
        },
      },
      render: (_args, value) => {
        if (!value.ok) {
          return [{
            type: 'text',
            text: [
              `Focus unchanged (${value.code}): ${value.reason}`,
              '',
              renderStack(value.stack),
              ...renderWarnings(value.warnings),
            ].join('\n'),
          }]
        }
        return [
          {
            type: 'text',
            text: [
              `Focus set (depth ${value.depth}): ${requireFrame(value.top).description}`,
              '',
              renderStack(value.stack),
              ...renderWarnings(value.warnings),
            ].join('\n'),
          },
        ]
      },
    },
    async execute(args, exec) {
      const caller = requireCaller(exec.agent)
      const description = args.description.trim()
      if (description.length === 0) {
        throw new Error('focus_task requires a non-empty `description`')
      }
      const result = await store.pushTask(store.locate(caller.sessionId, caller.cwd), description)
      if (!result.ok) {
        const current = await store.getSnapshot(store.locate(caller.sessionId, caller.cwd))
        const refusal: FocusTaskRefusal = {
          ok: false,
          code: result.code,
          reason: result.message,
          depth: current.stack.length,
          stack: current.stack.map(toFrameView),
          warnings: current.warnings.map(toWarningView),
        }
        return refusal as typeof refusal & FocusTaskResult
      }
      const { pushed, stack, warnings } = result.value
      return {
        ok: true as const,
        pushed: toFrameView(pushed),
        depth: stack.length,
        top: toFrameView(pushed),
        stack: stack.map(toFrameView),
        warnings: warnings.map(toWarningView),
      } satisfies FocusTaskResult
    },
    presentCall: (args) => ({ card: 'generic', title: `focus: ${args.description}`, kind: 'other' }),
    isConcurrencySafe: () => false,
  })
}

/** `focus_complete` — pop the top frame and record its conclusion. */
export function focusCompleteTool(store: Store) {
  return defineTool({
    name: 'focus_complete',
    description:
      'Close the task on top of the stack: pop it, record one line of conclusion, and make the task below it active again. ' +
      'Call it once the top task\'s work is finished and its deliverable has actually landed — before you write the final answer to the user, so a later context compaction can see what was closed. ' +
      'Do not call it to abandon, pause, or rename work; if the objective changed, finish or restate the top task instead of leaving it open. ' +
      'Returns the closed task, the task that became active again, and the remaining depth; refuses when the stack is empty, which means no focus_task was pushed for this work.',
    parameters: {
      conclusion: {
        type: 'string',
        required: true,
        description:
          'One line stating the outcome the user can verify (for example "added the import command; smoke test passes"), not a restatement of the task. It is the only record kept in history.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          // Refusal-only fields.
          code: { type: 'string', description: 'Machine-readable refusal code, present when ok is false.' },
          reason: { type: 'string', description: 'Model-readable refusal explanation, present when ok is false.' },
          // Success-only fields: an empty stack has nothing to report as closed.
          completed: { type: 'object', additionalProperties: false, properties: HISTORY_PROPERTIES },
          resumed: { type: 'object', additionalProperties: false, properties: FRAME_PROPERTIES },
          depth: { type: 'integer', required: true },
          stack: { type: 'array', required: true, items: FRAME_ITEM },
          warnings: { type: 'array', required: true, items: WARNING_ITEM },
        },
      },
      render: (_args, value) => {
        if (!value.ok) {
          return [{
            type: 'text',
            text: [
              `Focus unchanged (${value.code}): ${value.reason}`,
              '',
              renderStack(value.stack),
              ...renderWarnings(value.warnings),
            ].join('\n'),
          }]
        }
        const lines = [
          `Focus cleared: ${requireHistory(value.completed).description}`,
          `Conclusion: ${requireHistory(value.completed).conclusion}`,
        ]
        if (value.resumed !== undefined) lines.push(`Resumed (depth ${value.depth}): ${value.resumed.description}`)
        else lines.push('The stack is now empty — no task is active.')
        return [{ type: 'text', text: [...lines, ...renderWarnings(value.warnings)].join('\n') }]
      },
    },
    async execute(args, exec) {
      const caller = requireCaller(exec.agent)
      const conclusion = args.conclusion.trim()
      if (conclusion.length === 0) {
        throw new Error('focus_complete requires a non-empty `conclusion`')
      }
      const result = await store.popTask(store.locate(caller.sessionId, caller.cwd), conclusion)
      if (!result.ok) {
        const current = await store.getSnapshot(store.locate(caller.sessionId, caller.cwd))
        const refusal: FocusCompleteRefusal = {
          ok: false,
          code: result.code,
          reason: result.message,
          depth: current.stack.length,
          stack: current.stack.map(toFrameView),
          warnings: current.warnings.map(toWarningView),
        }
        return refusal as typeof refusal & FocusCompleteResult
      }
      const { completed, resumed, stack, warnings } = result.value
      return {
        ok: true as const,
        completed: toHistoryView(completed),
        ...(resumed === undefined ? {} : { resumed: toFrameView(resumed) }),
        depth: stack.length,
        stack: stack.map(toFrameView),
        warnings: warnings.map(toWarningView),
      } satisfies FocusCompleteResult
    },
    presentCall: () => ({ card: 'generic', title: 'Complete current focus', kind: 'other' }),
    isConcurrencySafe: () => false,
  })
}

/** `read_focus` — render the stack and recent history. */
export function readFocusTool(store: Store) {
  return defineTool({
    name: 'read_focus',
    description:
      'Read the current task stack: every active and paused task, plus the most recently completed ones with their conclusions. ' +
      'Call it when you have lost track of the current focus — after a context compaction, when resuming a session, when the user asks what you are working on, or before deciding whether to push or complete a task. ' +
      'Do not call it after every step: while your own recent turns still show the focus, calling it only spends tokens. This plugin never injects the stack into the prompt, so this call is the only way to see it. ' +
      'Returns the depth, the active task, the full stack, and recent history.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          depth: { type: 'integer', required: true },
          top: { type: 'object', additionalProperties: false, properties: FRAME_PROPERTIES },
          stack: { type: 'array', required: true, items: FRAME_ITEM },
          history: { type: 'array', required: true, items: HISTORY_ITEM },
          warnings: { type: 'array', required: true, items: WARNING_ITEM },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `## Task stack (depth ${value.depth})`,
            '',
            renderStack(value.stack),
            '',
            renderHistory(value.history),
            ...renderWarnings(value.warnings),
          ].join('\n'),
        },
      ],
    },
    async execute(_args, exec) {
      const caller = requireCaller(exec.agent)
      const snapshot = await store.getSnapshot(store.locate(caller.sessionId, caller.cwd))
      const top = snapshot.stack.at(-1)
      return {
        ok: true as const,
        depth: snapshot.stack.length,
        ...(top === undefined ? {} : { top: toFrameView(top) }),
        stack: snapshot.stack.map(toFrameView),
        history: snapshot.history.map(toHistoryView),
        warnings: snapshot.warnings.map(toWarningView),
      } satisfies ReadFocusResult
    },
    presentCall: () => ({ card: 'generic', title: 'Read task stack', kind: 'read' }),
    isConcurrencySafe: () => true,
  })
}

/** Property map of one stack frame, shared by the three tool schemas. */
const FRAME_PROPERTIES = {
  id: { type: 'string', required: true },
  description: { type: 'string', required: true },
  status: { type: 'string', required: true, enum: ['active', 'paused'] },
  createdAt: { type: 'string', required: true },
} as const

/** Array item for one stack frame. */
const FRAME_ITEM = { type: 'object', additionalProperties: false, properties: FRAME_PROPERTIES } as const

/** Property map of one completed frame. */
const HISTORY_PROPERTIES = {
  id: { type: 'string', required: true },
  description: { type: 'string', required: true },
  conclusion: { type: 'string', required: true },
  completedAt: { type: 'string', required: true },
} as const

/** Array item for one completed frame. */
const HISTORY_ITEM = { type: 'object', additionalProperties: false, properties: HISTORY_PROPERTIES } as const

/** Array item for one state warning. */
const WARNING_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

/**
 * Resolve the calling session.
 *
 * @param agent - the execution's owning agent, if any.
 * @returns the session id and workspace directory.
 * @throws {Error} when the call has no owning agent (a contract violation, not a domain outcome).
 */
function requireCaller(agent: Agent | undefined): CallerSession {
  if (agent === undefined) {
    throw new Error('dsh-task-stack: this tool requires an owning agent session (exec.agent was undefined)')
  }
  return {
    sessionId: String(agent.session.id),
    cwd: agent.session.header.cwd ?? process.cwd(),
  }
}

/** Project a stored frame. */
function toFrameView(frame: TaskFrame): StackFrameView {
  return { id: frame.id, description: frame.description, status: frame.status, createdAt: frame.createdAt }
}

/** Project a stored history record. */
function toHistoryView(entry: TaskHistoryEntry): HistoryEntryView {
  return {
    id: entry.id,
    description: entry.description,
    conclusion: entry.conclusion,
    completedAt: entry.completedAt,
  }
}

/** Project a store warning. */
function toWarningView(warning: StoreWarning): WarningView {
  return { code: warning.code, message: warning.message }
}

/**
 * Markdown list of the stack, deepest first so the ACTIVE (top) task is the
 * last line. Depth N means "N tasks are open, this one is the Nth from the top";
 * the active task always renders as depth 1 with the `**active**` marker.
 */
function renderStack(stack: readonly StackFrameView[]): string {
  if (stack.length === 0) return '_(no active task)_'
  const lines: string[] = []
  stack.forEach((frame, index) => {
    const depth = stack.length - index
    const marker = frame.status === 'active' ? '**active**' : 'paused'
    lines.push(`${depth}. ${marker} — ${frame.description}  \n   \`${frame.id}\``)
  })
  return lines.join('\n')
}
/** Markdown list of recent completed tasks, newest first; never empty. */
function renderHistory(history: readonly HistoryEntryView[]): string {
  const heading = `### Recent history (${history.length})`
  if (history.length === 0) return `${heading}\n\n_(nothing completed yet)_`
  const items = [...history]
    .reverse()
    .map((entry) => `- ${entry.description} → ${entry.conclusion}`)
    .join('\n')
  return `${heading}\n\n${items}`
}

/** Extra lines describing non-fatal state problems. */
function renderWarnings(warnings: readonly WarningView[]): string[] {
  if (warnings.length === 0) return []
  return ['', '> State file warnings:', ...warnings.map((warning) => `> - \`${warning.code}\`: ${warning.message}`)]
}

/**
 * Narrow the success branch's frame for rendering.
 *
 * The declared schema marks `top`/`pushed` optional because a refusal carries
 * neither, so the renderer must prove presence before reading. A success value
 * without a frame is a contract bug, not a runtime state to paper over.
 */
function requireFrame(frame: StackFrameView | undefined): StackFrameView {
  if (frame === undefined) throw new Error('dsh-task-stack: a successful result must carry its top frame')
  return frame
}

/** Narrow the success branch's completed record for rendering. */
function requireHistory(entry: HistoryEntryView | undefined): HistoryEntryView {
  if (entry === undefined) throw new Error('dsh-task-stack: a successful focus_complete must carry its completed record')
  return entry
}
