/**
 * Host-side HTTP surface: one read-only JSON endpoint for the task stack.
 *
 * This is the data plane a Web client panel reads. It is registered on
 * `ctx.webServer` only when the composition provides one, and every request must
 * pass the same `connection.requestRejection()` fence the first-party API uses —
 * a raw WebServer route does **not** inherit that fence, so skipping it would
 * expose session state to any web page the browser visits (CSRF) or to a rebound
 * DNS name.
 *
 * The endpoint is read-only by construction: it exposes `getSnapshot` and nothing
 * that mutates the stack. Closing tasks from a panel is deliberately not here; a
 * write route would need its own approval story.
 *
 * @module dsh-task-stack/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Store } from './store.ts'
import type { StackSnapshot, TaskFrame, TaskHistoryEntry, StoreWarning } from './types.ts'

/** Exact path of the snapshot endpoint. */
export const SNAPSHOT_PATH = '/api/dsh-task-stack/snapshot'

/** Minimal view of the `connection` service this module needs. */
export interface ComplianceGate {
  /** HTTP status to reject with, or `undefined` to allow the request. */
  requestRejection(request: IncomingMessage): number | undefined
}

/** Minimal view of the `webServer` service this module needs. */
export interface WebRouteHost {
  /**
   * Register a named route.
   *
   * @param route - kind, path, and the handler owning the response.
   * @returns the disposer removing the route.
   */
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => void
}

/** A logger surface; satisfied by `ctx.logger(name)`. */
export interface HttpLogger {
  info: (format: unknown, ...params: unknown[]) => void
  warn: (format: unknown, ...params: unknown[]) => void
}

/** The JSON document the endpoint returns. */
export interface SnapshotDocument {
  /** Session the snapshot belongs to. */
  sessionId: string
  /** Absolute workspace the state file was resolved against. */
  cwd: string
  /** Number of open tasks. */
  depth: number
  /** Active task, absent on an empty stack. */
  top?: StackFrameView
  /** Open tasks, deepest first. */
  stack: StackFrameView[]
  /** Completed tasks, oldest first. */
  history: HistoryEntryView[]
  /** Non-fatal state problems. */
  warnings: WarningView[]
}

/** One open task as the endpoint reports it. */
interface StackFrameView {
  id: string
  description: string
  status: 'active' | 'paused'
  createdAt: string
}

/** One completed task as the endpoint reports it. */
interface HistoryEntryView {
  id: string
  description: string
  conclusion: string
  completedAt: string
}

/** One state warning as the endpoint reports it. */
interface WarningView {
  code: string
  message: string
}

/**
 * Build the endpoint document from a snapshot.
 *
 * Split out so it is testable without HTTP: the route handler's only jobs are the
 * fence, the parameters, and serialization.
 *
 * @param snapshot - the store's snapshot.
 * @param sessionId - session the snapshot was requested for.
 * @param cwd - workspace the state file was resolved against.
 * @returns the JSON document.
 */
export function buildSnapshotDocument(snapshot: StackSnapshot, sessionId: string, cwd: string): SnapshotDocument {
  const top = snapshot.stack.at(-1)
  return {
    sessionId,
    cwd,
    depth: snapshot.stack.length,
    ...(top === undefined ? {} : { top: toFrameView(top) }),
    stack: snapshot.stack.map(toFrameView),
    history: snapshot.history.map(toHistoryView),
    warnings: snapshot.warnings.map(toWarningView),
  }
}

/** Project a stored frame for the wire. */
function toFrameView(frame: TaskFrame): StackFrameView {
  return { id: frame.id, description: frame.description, status: frame.status, createdAt: frame.createdAt }
}

/** Project a stored history record for the wire. */
function toHistoryView(entry: TaskHistoryEntry): HistoryEntryView {
  return { id: entry.id, description: entry.description, conclusion: entry.conclusion, completedAt: entry.completedAt }
}

/** Project a store warning for the wire. */
function toWarningView(warning: StoreWarning): WarningView {
  return { code: warning.code, message: warning.message }
}

/**
 * Resolve the fence for one request.
 *
 * The `connection` service is looked up per request rather than captured at
 * registration: in the shipped Web profile both `webserver` and `connection`
 * inject `webRuntime`, so their activation order is not guaranteed and the
 * registration callback may run before `connection` exists. It also survives a
 * `connection` reload, which a captured reference would not.
 *
 * @param resolveGate - reads the current `connection` service.
 * @returns the gate, or `undefined` when the composition has none.
 */
export type GateResolver = () => ComplianceGate | undefined

/**
 * Register the snapshot route.
 *
 * @param host - the `webServer` service.
 * @param store - the plugin's single store instance.
 * @param resolveGate - resolves the `connection` service per request; a missing
 *   gate fails closed with 503 rather than serving unauthenticated.
 * @param logger - plugin logger.
 * @returns the route disposer, or `undefined` when the path is already claimed.
 */
export function registerSnapshotRoute(
  host: WebRouteHost,
  store: Store,
  resolveGate: GateResolver,
  logger: HttpLogger,
): (() => void) | undefined {
  try {
    return host.register({
      kind: 'exact',
      path: SNAPSHOT_PATH,
      handler: (req, res) => handleSnapshot(req, res, store, resolveGate, logger),
    })
  } catch (error) {
    // A duplicate path means another instance of this plugin (or an unrelated one)
    // already claimed it. That is a composition problem, not a reason to fail the
    // whole plugin: the tools still work without a panel.
    logger.warn('%s', `could not register ${SNAPSHOT_PATH}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/** Serve one snapshot request, or a typed rejection. */
async function handleSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  resolveGate: GateResolver,
  logger: HttpLogger,
): Promise<void> {
  // Fail closed: without the Connection fence there is no trustworthy way to tell
  // a legitimate browser from a cross-origin page, so serve nothing.
  const gate = resolveGate()
  if (gate === undefined) {
    sendJson(res, 503, { error: 'authentication unavailable' })
    return
  }
  const rejection = gate.requestRejection(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }

  let url: URL
  try {
    url = new URL(req.url ?? SNAPSHOT_PATH, 'http://localhost')
  } catch {
    sendJson(res, 400, { error: 'invalid request url' })
    return
  }

  const sessionId = url.searchParams.get('sessionId')?.trim() ?? ''
  if (sessionId.length === 0) {
    sendJson(res, 400, { error: 'sessionId query parameter is required' })
    return
  }
  const cwd = url.searchParams.get('cwd')?.trim() ?? process.cwd()
  if (!isAbsolute(cwd)) {
    sendJson(res, 400, { error: 'cwd must be an absolute path' })
    return
  }

  try {
    const snapshot = await store.getSnapshot(store.locate(sessionId, cwd))
    const document = buildSnapshotDocument(snapshot, sessionId, cwd)
    sendJson(res, 200, document)
  } catch (error) {
    // A malformed `cwd`/`sessionId` throws from path resolution; report it as a
    // client error instead of letting the HTTP layer turn it into a 400 with no body.
    logger.warn('%s', `snapshot request failed: ${error instanceof Error ? error.message : String(error)}`)
    sendJson(res, 400, { error: 'invalid session or workspace' })
  }
}

/** Whether a path looks absolute on this platform (POSIX or Windows). */
function isAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}

/** Send a JSON response with the headers this surface always uses. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Session state must never be cached by a browser or an intermediary.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}
