/**
 * Persistent state for the task stack: path resolution, tolerant reads, atomic
 * writes, and a per-file async lock.
 *
 * Concurrency contract: every public operation is a read-modify-write over one
 * file, serialized through {@link Store.withLock}. The lock key is the resolved
 * absolute file path, so two sessions in one workspace never block each other. A
 * write goes to `<file>.<pid>.<counter>.tmp`, is `fsync`ed, and is then renamed
 * over the target, so a reader never observes a half-written document and a
 * crash leaves either the old or the new file, never a truncated one.
 *
 * Failure contract: a missing, unreadable, unparseable, or malformed state file
 * is never an exception. It degrades to an empty stack plus a {@link StoreWarning}
 * that the tool layer surfaces to the model.
 *
 * @module dsh-task-stack/store
 */

import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  STATE_VERSION,
  type PluginConfig,
  type PopResult,
  type PushResult,
  type StackSnapshot,
  type StoreWarning,
  type TaskFrame,
  type TaskHistoryEntry,
  type TaskStackState,
} from './types.ts'

/** Minimal logger surface the store needs; satisfied by `ctx.logger(name)`. */
export interface StoreLogger {
  warn: (format: unknown, ...params: unknown[]) => void
}

/** A state file path plus the identity it belongs to. */
export interface StateLocation {
  /** Absolute path of the JSON state file. */
  readonly path: string
  /** Owning session id, used as the document's identity field. */
  readonly sessionId: string
}

/** Failure codes returned by stack operations (never thrown). */
export type StoreFailureCode = 'stack-full' | 'stack-empty' | 'no-session'

/** Discriminated result of a mutating operation. */
export type StoreResult<T> = { ok: true; value: T } | { ok: false; code: StoreFailureCode; message: string }

/** Outcome of one {@link Store.prune} pass. */
export interface PruneResult {
  /** Session files deleted. */
  removed: string[]
  /** Session files left in place (including the caller's own file). */
  kept: number
  /** Session files that could not be examined or deleted. */
  failed: number
}

/** Arguments for one {@link Store.prune} pass. */
export interface PruneOptions {
  /** Absolute session workspace directory. */
  cwd: string
  /** State file of the session running the prune; never deleted. */
  currentSessionId?: string | undefined
  /** Maximum age in days; `0` disables pruning. */
  days: number
}

/** Highest resolution of the module is {@link Store}; these are its helpers. */

/** Counter feeding unique temporary-file names within one process. */
let tempCounter = 0

/**
 * Validate a resolved plugin configuration.
 *
 * @param config - the configuration to check.
 * @returns the same configuration, narrowed.
 * @throws {RangeError} when a value cannot produce a usable state file.
 */
export function assertConfig(config: PluginConfig): PluginConfig {
  if (typeof config.stateDir !== 'string' || config.stateDir.trim().length === 0) {
    throw new RangeError('dsh-task-stack: config.stateDir must be a non-empty string')
  }
  if (isAbsolute(config.stateDir)) {
    throw new RangeError(
      `dsh-task-stack: config.stateDir must be relative to the session workspace, got ${JSON.stringify(config.stateDir)}`,
    )
  }
  if (!Number.isSafeInteger(config.maxStackDepth) || config.maxStackDepth < 1) {
    throw new RangeError('dsh-task-stack: config.maxStackDepth must be a positive integer')
  }
  if (!Number.isSafeInteger(config.historyLimit) || config.historyLimit < 1) {
    throw new RangeError('dsh-task-stack: config.historyLimit must be a positive integer')
  }
  if (!Number.isSafeInteger(config.statePruneDays) || config.statePruneDays < 0) {
    throw new RangeError('dsh-task-stack: config.statePruneDays must be a non-negative integer (0 disables pruning)')
  }
  return config
}

/**
 * Resolve the absolute state-file path for one session.
 *
 * @param sessionId - owning session id; also the file's basename.
 * @param cwd - absolute session workspace directory.
 * @param config - resolved plugin configuration.
 * @returns the normalized absolute path.
 * @throws {RangeError} when `sessionId` or `cwd` cannot form a safe path.
 */
export function resolveStatePath(sessionId: string, cwd: string, config: PluginConfig): string {
  assertConfig(config)
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new RangeError('dsh-task-stack: sessionId must be a non-empty string')
  }
  if (typeof cwd !== 'string' || cwd.trim().length === 0 || !isAbsolute(cwd)) {
    throw new RangeError(`dsh-task-stack: session cwd must be an absolute path, got ${JSON.stringify(cwd)}`)
  }
  // Join (never string-concatenate) so Windows and POSIX separators both work.
  return normalize(join(cwd, config.stateDir, `${safeFileComponent(sessionId)}.json`))
}

/** Replace characters a filesystem could reject, keeping the id recognizable. */
function safeFileComponent(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
  return cleaned.length > 0 ? cleaned : 'session'
}

/** An empty document for one session. */
function emptyState(sessionId: string): TaskStackState {
  return { version: STATE_VERSION, sessionId, stack: [], history: [] }
}

/**
 * Per-session task stack backed by one JSON file.
 *
 * Construct one per plugin instance; it holds only the lock map, which is
 * released by {@link Store.release}.
 */
export class Store {
  readonly #config: PluginConfig
  readonly #logger: StoreLogger
  /** Tail promise of the serialized chain for each file path. */
  readonly #locks = new Map<string, Promise<unknown>>()

  /**
   * @param config - already-resolved plugin configuration.
   * @param logger - logger used for non-fatal read problems.
   */
  constructor(config: PluginConfig, logger: StoreLogger) {
    this.#config = assertConfig(config)
    this.#logger = logger
  }

  /** The resolved configuration this store was built with. */
  get config(): PluginConfig {
    return this.#config
  }

  /** Number of files with a live or queued lock; diagnostics and tests. */
  get lockCount(): number {
    return this.#locks.size
  }

  /**
   * Resolve the state file for a session.
   *
   * @param sessionId - owning session id.
   * @param cwd - absolute session workspace directory.
   * @returns the file path plus the identity it must carry.
   */
  locate(sessionId: string, cwd: string): StateLocation {
    return { path: resolveStatePath(sessionId, cwd, this.#config), sessionId }
  }

  /**
   * Serialize one read-modify-write against the lock for `path`.
   *
   * The lock is a promise chain: each caller appends to the chain and awaits the
   * previous tail, so work for one file is strictly ordered. Different paths use
   * different chains and never block each other. A settled chain with no waiters
   * is removed, so the map cannot grow without bound.
   *
   * @param path - absolute state-file path acting as the lock key.
   * @param fn - critical section; its result is returned to the caller.
   * @returns the critical section's result.
   */
  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(path) ?? Promise.resolve()
    // Swallow the predecessor's rejection: this caller must still run, and the
    // predecessor's own caller already observed its error.
    const next = previous.then(fn, fn)
    this.#locks.set(path, next.catch(() => undefined))
    try {
      return await next
    } finally {
      // Compare-and-delete only: a later operation may already own the slot, and
      // removing its entry would let a third call skip the queue and lose an
      // update.
      if (this.#locks.get(path) === next) this.#locks.delete(path)
    }
  }

  /**
   * Release all lock bookkeeping. Safe to call more than once.
   *
   * In-flight operations still complete; only the map is dropped, so a disposed
   * plugin leaves no retained promise chains behind.
   */
  release(): void {
    this.#locks.clear()
  }

  /**
   * Delete state files that have not been written for a while.
   *
   * A session file's mtime is its last write, so an old mtime means the session
   * has not touched its stack since. Only `*.json` files directly inside
   * `stateDir` are considered — a stray `.tmp` from a crashed write is left for
   * a human to notice — and an unreadable or absent directory is not an error,
   * because pruning is best-effort.
   *
   * `withLock` wraps each deletion so a prune can never interleave with an
   * in-flight read-modify-write of the same file.
   *
   * @param options - absolute session workspace directory, the calling session's
   *   own file to spare, and the maximum age in days; `days <= 0` disables pruning.
   * @returns what was removed, kept, and could not be handled.
   */
  async prune(options: PruneOptions): Promise<PruneResult> {
    const result: PruneResult = { removed: [], kept: 0, failed: 0 }
    if (!Number.isFinite(options.days) || options.days <= 0) return result

    const directory = normalize(join(options.cwd, this.#config.stateDir))
    const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000
    const ownFile =
      options.currentSessionId === undefined ? undefined : normalize(join(directory, `${safeFileComponent(options.currentSessionId)}.json`))

    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (isNotFound(error)) return result
      this.#logger.warn('%s', `dsh-task-stack: could not scan ${directory} for stale state files: ${messageOf(error)}`)
      result.failed += 1
      return result
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = normalize(join(directory, entry))
      if (path === ownFile) {
        result.kept += 1
        continue
      }
      try {
        const info = await stat(path)
        if (!info.isFile() || info.mtimeMs > cutoff) {
          result.kept += 1
          continue
        }
      } catch {
        result.failed += 1
        continue
      }
      try {
        await this.withLock(path, async () => {
          await rm(path, { force: true })
        })
        result.removed.push(entry)
      } catch {
        result.failed += 1
      }
    }

    return result
  }

  /**
   * Read the current stack without modifying it.
   *
   * @param location - resolved state-file location.
   * @returns the snapshot, empty when the file is absent or unusable.
   */
  async getSnapshot(location: StateLocation): Promise<StackSnapshot> {
    return this.withLock(location.path, async () => {
      const { state, created, warnings } = await this.#read(location)
      return {
        sessionId: state.sessionId,
        stack: state.stack,
        history: state.history,
        created,
        warnings,
      }
    })
  }

  /**
   * Push one frame onto the top of the stack.
   *
   * The previously active frame becomes `paused`; the new frame becomes
   * `active`. Pushing onto a full stack is refused by policy, not by an
   * exception.
   *
   * @param location - resolved state-file location.
   * @param description - one-line task description, already trimmed by the caller.
   * @returns the pushed frame and the new stack, or a refusal.
   */
  async pushTask(location: StateLocation, description: string): Promise<StoreResult<PushResult>> {
    return this.withLock(location.path, async () => {
      const { state, warnings } = await this.#read(location)
      if (state.stack.length >= this.#config.maxStackDepth) {
        return {
          ok: false as const,
          code: 'stack-full' as const,
          message: `the task stack is full (${state.stack.length}/${this.#config.maxStackDepth} tasks); complete the current task with focus_complete before pushing another`,
        }
      }
      const frame: TaskFrame = {
        id: `task-${randomUUID()}`,
        description,
        createdAt: new Date().toISOString(),
        status: 'active',
      }
      for (const existing of state.stack) existing.status = 'paused'
      state.stack.push(frame)
      state.history = trimHistory(state.history, this.#config.historyLimit)
      await this.#write(location.path, state)
      return { ok: true as const, value: { pushed: frame, stack: state.stack, warnings } }
    })
  }

  /**
   * Pop every frame, recording each one in history.
   *
   * Used by the human-facing `/focus clear`. Frames are recorded rather than
   * dropped so a stack a human cleared is still visible to the model through
   * `read_focus`'s history — deleting someone's open tasks silently would be the
   * more surprising outcome. One write, under one lock.
   *
   * Clearing an empty stack succeeds with an empty `cleared` list: "clear" is an
   * idempotent cleanup, not a step that can be out of order, so a second
   * invocation must not read as a failure.
   *
   * @param location - resolved state-file location.
   * @param conclusion - conclusion recorded for every cleared frame.
   * @returns the cleared frames (bottom first) plus any read warnings.
   */
  async clearStack(location: StateLocation, conclusion: string): Promise<{ cleared: TaskFrame[]; warnings: StoreWarning[] }> {
    return this.withLock(location.path, async () => {
      const { state, warnings } = await this.#read(location)
      if (state.stack.length === 0) return { cleared: [], warnings }
      const cleared = [...state.stack]
      const completedAt = new Date().toISOString()
      const records: TaskHistoryEntry[] = cleared.map((frame) => ({
        id: frame.id,
        description: frame.description,
        conclusion,
        createdAt: frame.createdAt,
        completedAt,
      }))
      state.stack = []
      state.history = trimHistory([...state.history, ...records], this.#config.historyLimit)
      await this.#write(location.path, state)
      return { cleared, warnings }
    })
  }

  /**
   * Pop the top frame, record its conclusion, and resume the frame below it.
   *
   * @param location - resolved state-file location.
   * @param conclusion - one-line conclusion, already trimmed by the caller.
   * @returns the completed record plus the resumed frame, or a refusal.
   */
  async popTask(location: StateLocation, conclusion: string): Promise<StoreResult<PopResult>> {
    return this.withLock(location.path, async () => {
      const { state, warnings } = await this.#read(location)
      const frame = state.stack.pop()
      if (frame === undefined) {
        return {
          ok: false as const,
          code: 'stack-empty' as const,
          message: 'the task stack is already empty — there is no active task to complete',
        }
      }
      const completedAt = new Date().toISOString()
      const completed: TaskHistoryEntry = {
        id: frame.id,
        description: frame.description,
        conclusion,
        createdAt: frame.createdAt,
        completedAt,
      }
      state.history = trimHistory([...state.history, completed], this.#config.historyLimit)
      const resumed = state.stack.at(-1)
      if (resumed !== undefined) resumed.status = 'active'
      await this.#write(location.path, state)
      return { ok: true as const, value: { completed, resumed, stack: state.stack, warnings } }
    })
  }

  /**
   * Load, validate, and normalize one document.
   *
   * @param location - resolved state-file location.
   * @returns the usable document, whether it had to be created, and any warnings.
   */
  async #read(location: StateLocation): Promise<{ state: TaskStackState; created: boolean; warnings: StoreWarning[] }> {
    const warnings: StoreWarning[] = []
    let text: string
    try {
      text = await readFile(location.path, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return { state: emptyState(location.sessionId), created: true, warnings }
      return {
        state: emptyState(location.sessionId),
        created: true,
        warnings: this.#warn(warnings, 'unreadable', `could not read ${location.path}: ${messageOf(error)}`),
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        state: emptyState(location.sessionId),
        created: false,
        warnings: this.#warn(
          warnings,
          'invalid-json',
          `state file ${location.path} is not valid JSON (${messageOf(error)}); starting from an empty stack`,
        ),
      }
    }

    return this.#normalize(parsed, location, warnings)
  }

  /** Validate a parsed document, degrading to empty state on any structural problem. */
  #normalize(
    parsed: unknown,
    location: StateLocation,
    warnings: StoreWarning[],
  ): { state: TaskStackState; created: boolean; warnings: StoreWarning[] } {
    const empty = (): { state: TaskStackState; created: boolean; warnings: StoreWarning[] } => ({
      state: emptyState(location.sessionId),
      created: false,
      warnings,
    })

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      pushWarning(warnings, 'invalid-shape', `state file ${location.path} is not a JSON object; starting from an empty stack`)
      return empty()
    }

    const record = parsed as Record<string, unknown>
    if (record['version'] !== STATE_VERSION) {
      pushWarning(
        warnings,
        'version-mismatch',
        `state file ${location.path} has version ${JSON.stringify(record['version'])}, expected ${STATE_VERSION}; starting from an empty stack`,
      )
      return empty()
    }
    if (record['sessionId'] !== location.sessionId) {
      pushWarning(
        warnings,
        'session-mismatch',
        `state file ${location.path} belongs to session ${JSON.stringify(record['sessionId'])}; starting from an empty stack`,
      )
      return empty()
    }

    const stack: TaskFrame[] = []
    for (const candidate of asArray(record['stack'])) {
      const frame = normalizeFrame(candidate)
      if (frame === undefined) {
        pushWarning(warnings, 'dropped-frame', `state file ${location.path} contains a malformed stack frame; it was dropped`)
        continue
      }
      stack.push(frame)
    }
    // Exactly one frame may be active: the top one. Repair anything else.
    stack.forEach((frame, index) => {
      frame.status = index === stack.length - 1 ? 'active' : 'paused'
    })

    const history: TaskHistoryEntry[] = []
    for (const candidate of asArray(record['history'])) {
      const entry = normalizeHistory(candidate)
      if (entry === undefined) {
        pushWarning(warnings, 'dropped-frame', `state file ${location.path} contains a malformed history record; it was dropped`)
        continue
      }
      history.push(entry)
    }

    return {
      state: {
        version: STATE_VERSION,
        sessionId: location.sessionId,
        stack,
        history: trimHistory(history, this.#config.historyLimit),
      },
      created: false,
      warnings,
    }
  }

  /** Record a warning once, log it, and return the array for chaining. */
  #warn(warnings: StoreWarning[], code: StoreWarning['code'], text: string): StoreWarning[] {
    pushWarning(warnings, code, text)
    this.#logger.warn('%s', `dsh-task-stack: ${text}`)
    return warnings
  }

  /**
   * Durably replace the state file.
   *
   * Order matters: create the directory, write and `fsync` a temporary file in
   * the same directory, then `rename` it over the target. `rename` replacing an
   * existing file is atomic on POSIX and on Win32 (`MoveFileEx` semantics), so a
   * concurrent reader sees one complete document.
   */
  async #write(path: string, state: TaskStackState): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.${tempCounter++}.tmp`
    let handle: FileHandle | undefined
    try {
      handle = await open(temp, 'w')
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle?.close()
    }
    try {
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}

/** Append one warning, ignoring an exact duplicate already collected. */
function pushWarning(warnings: StoreWarning[], code: StoreWarning['code'], message: string): void {
  if (warnings.some((warning) => warning.code === code && warning.message === message)) return
  warnings.push({ code, message })
}

/** Keep only the newest `limit` history records. */
function trimHistory(history: TaskHistoryEntry[], limit: number): TaskHistoryEntry[] {
  if (history.length <= limit) return history
  return history.slice(history.length - limit)
}

/** An array value, or an empty array for anything else. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Validate one persisted stack frame. */
function normalizeFrame(value: unknown): TaskFrame | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = stringField(record['id'])
  const description = stringField(record['description'])
  const createdAt = stringField(record['createdAt'])
  if (id === undefined || description === undefined || createdAt === undefined) return undefined
  return {
    id,
    description,
    createdAt,
    status: record['status'] === 'paused' ? 'paused' : 'active',
  }
}

/** Validate one persisted history record. */
function normalizeHistory(value: unknown): TaskHistoryEntry | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = stringField(record['id'])
  const description = stringField(record['description'])
  const conclusion = stringField(record['conclusion'])
  const createdAt = stringField(record['createdAt'])
  const completedAt = stringField(record['completedAt'])
  if (
    id === undefined ||
    description === undefined ||
    conclusion === undefined ||
    createdAt === undefined ||
    completedAt === undefined
  ) {
    return undefined
  }
  return { id, description, conclusion, createdAt, completedAt }
}

/** A non-empty string field, or `undefined`. */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Whether an unknown error is a missing-file error. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Human-readable message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
