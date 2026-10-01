/**
 * Shared types for the dsh-task-stack plugin.
 *
 * The persisted shape is deliberately small and plain: a version tag, the
 * owning session id, a LIFO `stack` of active/paused work frames, and a
 * `history` of completed frames. Everything is lossless JSON so the file can be
 * read by a human, a test script, or the plugin itself.
 *
 * @module dsh-task-stack/types
 */

/** Current on-disk schema version. A reader refuses anything else. */
export const STATE_VERSION = 1

/** Status of a frame that is still on the stack. */
export type TaskStatus = 'active' | 'paused'

/**
 * Lifecycle of a stack frame: exactly one frame is `active` (the top of the
 * stack); every deeper frame is `paused` until it becomes the top again.
 */
export interface TaskFrame {
  /** Stable identifier, `task-<uuid>`. */
  id: string
  /** One-line description supplied by the model. */
  description: string
  /** Creation time, ISO-8601 with milliseconds. */
  createdAt: string
  /** `active` only for the top frame. */
  status: TaskStatus
}

/** One completed frame, kept for cross-compaction recall. */
export interface TaskHistoryEntry {
  /** Identifier of the frame that was popped. */
  id: string
  /** The description the frame carried. */
  description: string
  /** One-line conclusion supplied at `focus_complete` time. */
  conclusion: string
  /** Creation time of the frame. */
  createdAt: string
  /** Completion time, ISO-8601 with milliseconds. */
  completedAt: string
}

/** The whole persisted document. */
export interface TaskStackState {
  /** Schema version; see {@link STATE_VERSION}. */
  version: number
  /** Owning session id; a mismatch means the file is not ours. */
  sessionId: string
  /** Active + paused frames, oldest first, top of stack last. */
  stack: TaskFrame[]
  /** Completed frames, oldest first. */
  history: TaskHistoryEntry[]
}

/** Resolved plugin configuration. */
export interface PluginConfig {
  /** State directory, relative to the session workspace (default `.dsh/task-stack`). */
  stateDir: string
  /** Maximum number of frames on the stack (default 20). */
  maxStackDepth: number
  /** Maximum number of `history` records kept (default 100). */
  historyLimit: number
  /**
   * Delete state files untouched for more than this many days, once per plugin
   * load (default 0 = never prune). A session file's mtime is its last write, so
   * a workspace that has run many sessions does not accumulate files forever.
   * Only `*.json` session files inside `stateDir` are considered.
   */
  statePruneDays: number
}

/** A non-fatal problem observed while reading or writing state. */
export interface StoreWarning {
  /** Machine-readable discriminator. */
  code: 'unreadable' | 'invalid-json' | 'invalid-shape' | 'version-mismatch' | 'session-mismatch' | 'dropped-frame'
  /** Human-readable explanation, safe to show the model. */
  message: string
}

/** A snapshot of the stack, ready to render. */
export interface StackSnapshot {
  /** The owning session id from the file. */
  sessionId: string
  /** Active + paused frames, oldest first. */
  stack: TaskFrame[]
  /** Completed frames, oldest first. */
  history: TaskHistoryEntry[]
  /** True when the underlying file was absent. */
  created: boolean
  /** Non-fatal problems found while loading. */
  warnings: StoreWarning[]
}

/** Result of a successful push. */
export interface PushResult {
  /** The frame that was pushed. */
  pushed: TaskFrame
  /** Frames now on the stack, depth-first from the bottom. */
  stack: TaskFrame[]
  /** Non-fatal problems found while loading. */
  warnings: StoreWarning[]
}

/** Result of a successful pop. */
export interface PopResult {
  /** The frame that was popped and completed. */
  completed: TaskHistoryEntry
  /** The frame that became active again, if any. */
  resumed: TaskFrame | undefined
  /** Frames still on the stack. */
  stack: TaskFrame[]
  /** Non-fatal problems found while loading. */
  warnings: StoreWarning[]
}

/** Default state directory, relative to the session workspace. */
export const DEFAULT_STATE_DIR = '.dsh/task-stack'
/** Default maximum stack depth. */
export const DEFAULT_MAX_STACK_DEPTH = 20
/** Default maximum number of history records. */
export const DEFAULT_HISTORY_LIMIT = 100
/** Default prune threshold in days; 0 disables pruning. */
export const DEFAULT_STATE_PRUNE_DAYS = 0

/**
 * Merge a partial (possibly empty) config into the resolved defaults.
 *
 * Values still come from the Cordis Config schema at runtime; this is the
 * defensive second pass the tool layer uses so a `undefined` field from a
 * direct (schema-less) construction cannot reach the store.
 *
 * @param config - raw or partial configuration.
 * @returns the fully resolved configuration.
 */
export function resolveConfig(config: Partial<PluginConfig> | undefined): PluginConfig {
  return {
    stateDir: nonEmpty(config?.stateDir) ?? DEFAULT_STATE_DIR,
    maxStackDepth: positiveInt(config?.maxStackDepth) ?? DEFAULT_MAX_STACK_DEPTH,
    historyLimit: positiveInt(config?.historyLimit) ?? DEFAULT_HISTORY_LIMIT,
    statePruneDays: nonNegativeInt(config?.statePruneDays) ?? DEFAULT_STATE_PRUNE_DAYS,
  }
}

/** A trimmed non-empty string, or `undefined`. */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** A positive integer, or `undefined`. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** A non-negative integer (0 allowed), or `undefined`. */
function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
