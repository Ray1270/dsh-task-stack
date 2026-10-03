/**
 * HTTP surface test over a REAL `@deepseek-ai/dsh-host-webserver` instance.
 *
 * A stub handler would prove nothing here: the point is that the route composes
 * with the shipped web server, binds a real socket, and answers real requests.
 * The test therefore
 *
 *   1. mounts the real WebServer on an OS-assigned port,
 *   2. registers the snapshot route through the plugin's own entry point,
 *   3. drives it with `fetch`, checking status, headers, and body, and
 *   4. stands in for the `connection` service so the fence can be exercised both
 *      ways (a Host the fence rejects must not leak state).
 *
 * Usage: `pnpm test:http` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

const { buildSnapshotDocument, registerSnapshotRoute, SNAPSHOT_PATH } = await import('../lib/http.js')
const { Store } = await import('../lib/store.js')
const { resolveConfig } = await import('../lib/types.js')

let passed = 0
const check = async (label, fn) => {
  await fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

const warnings = []
const logger = { info: () => {}, warn: (format, ...rest) => warnings.push(`${String(format)} ${rest.map(String).join(' ')}`) }

const root = await mkdtemp(join(tmpdir(), 'dsh-task-stack-http-'))
const workspace = join(root, 'workspace')
const sessionId = 'session-http-test'
const store = new Store(resolveConfig({ maxStackDepth: 10, historyLimit: 10 }), logger)

/**
 * Stand-in for the `connection` service: it rejects a Host the real fence would
 * reject (a non-loopback authority not in `trustedHosts`) and allows the rest.
 * The real implementation lives in `@deepseek-ai/dsh-client-connection`; copying
 * its behaviour here keeps this suite independent of that package's internals
 * while still exercising both branches of the route.
 */
const gate = {
  requestRejection(request) {
    const host = request.headers.host ?? ''
    const hostname = host.split(':')[0] ?? ''
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
    return loopback ? undefined : 403
  },
}

process.stdout.write('http surface tests\n')

// --- pure document shaping ----------------------------------------------------
await check('buildSnapshotDocument projects frames, history and warnings', async () => {
  const location = store.locate(sessionId, workspace)
  await store.pushTask(location, 'first task')
  await store.pushTask(location, 'second task')
  const snapshot = await store.getSnapshot(location)

  const document = buildSnapshotDocument(snapshot, sessionId, workspace)
  assert.equal(document.sessionId, sessionId)
  assert.equal(document.cwd, workspace)
  assert.equal(document.depth, 2)
  assert.equal(document.top?.description, 'second task')
  assert.deepEqual(
    document.stack.map((frame) => [frame.description, frame.status]),
    [
      ['first task', 'paused'],
      ['second task', 'active'],
    ],
  )
  assert.deepEqual(document.history, [])
  assert.deepEqual(document.warnings, [])
})

// --- a real server ------------------------------------------------------------
const ctx = new Context()
ctx.provide('connection', gate)
const fiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await fiber.await()

const server = ctx.get('webServer')
assert.ok(server, 'the composition must expose the webServer service')
const port = server.port
assert.ok(typeof port === 'number' && port > 0, `expected a bound port, got ${String(port)}`)
const base = `http://127.0.0.1:${String(port)}`

const dispose = registerSnapshotRoute(server, store, () => gate, logger)
assert.equal(typeof dispose, 'function', 'the route must register')
process.stdout.write(`  server on ${base}\n`)

await check('the snapshot endpoint answers and matches the state file', async () => {
  const response = await fetch(`${base}${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(workspace)}`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.equal(response.headers.get('cache-control'), 'no-store')

  const body = await response.json()
  assert.equal(body.sessionId, sessionId)
  assert.equal(body.depth, 2)
  assert.equal(body.top.description, 'second task')

  // Cross-check against the file the tools actually wrote.
  const onDisk = JSON.parse(await readFile(join(workspace, '.dsh', 'task-stack', `${sessionId}.json`), 'utf8'))
  assert.deepEqual(
    body.stack.map((frame) => frame.id),
    onDisk.stack.map((frame) => frame.id),
    'the endpoint must report the ids the state file holds',
  )
  assert.equal(body.stack.length, onDisk.stack.length)
})

await check('a rejected Host is refused and leaks no state', async () => {
  // `fetch` silently ignores a `host` header (it is a forbidden request header in
  // the Fetch spec), so the fence can only be exercised through node:http with
  // `setHost: false`.
  const { request } = await import('node:http')
  const result = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: `${SNAPSHOT_PATH}?sessionId=${encodeURIComponent(sessionId)}`,
        method: 'GET',
        setHost: false,
        headers: { host: 'evil.example.com' },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })

  assert.equal(result.status, 403)
  const body = JSON.parse(result.body)
  assert.equal(body.error, 'forbidden')
  assert.ok(!result.body.includes('second task'), 'a rejected request must not carry stack data')
})

await check('a missing sessionId is a 400, not an empty success', async () => {
  const response = await fetch(`${base}${SNAPSHOT_PATH}`)
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /sessionId/)
})

await check('a relative cwd is rejected', async () => {
  const response = await fetch(`${base}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=relative/path`)
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /absolute/)
})

await check('a POST is refused with 405 and an allow header', async () => {
  const response = await fetch(`${base}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=${encodeURIComponent(workspace)}`, {
    method: 'POST',
  })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, HEAD')
})

await check('an unknown session reads as an empty stack, not a 404', async () => {
  const response = await fetch(`${base}${SNAPSHOT_PATH}?sessionId=session-nobody&cwd=${encodeURIComponent(workspace)}`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.depth, 0)
  assert.deepEqual(body.stack, [])
  assert.equal(body.top, undefined)
})

await check('a missing connection service fails closed with 503', async () => {
  // A second server with no gate: the route must still register, then refuse to
  // serve, rather than answering unauthenticated.
  const other = new Context()
  const otherFiber = other.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await otherFiber.await()
  const otherServer = other.get('webServer')
  const otherDispose = registerSnapshotRoute(otherServer, store, () => undefined, logger)
  assert.equal(typeof otherDispose, 'function')

  const response = await fetch(
    `http://127.0.0.1:${String(otherServer.port)}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=${encodeURIComponent(workspace)}`,
  )
  assert.equal(response.status, 503)
  assert.equal((await response.json()).error, 'authentication unavailable')

  otherDispose?.()
  await other.fiber.dispose()
})

await check('disposing the route unregisters it', async () => {
  dispose?.()
  const response = await fetch(`${base}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=${encodeURIComponent(workspace)}`)
  // No route, no fallback seat: the server answers 404.
  assert.equal(response.status, 404)
})

await check('a duplicate registration is reported, not thrown at the plugin', async () => {
  const first = registerSnapshotRoute(server, store, () => gate, logger)
  assert.equal(typeof first, 'function')
  const second = registerSnapshotRoute(server, store, () => gate, logger)
  assert.equal(second, undefined, 'the second registration must degrade to undefined')
  assert.ok(warnings.some((line) => line.includes(SNAPSHOT_PATH)), 'and it must be logged')
  first?.()
})

await check('the plugin entry point registers the route when the host has an HTTP surface', async () => {
  // The plugin's own `apply` adds the route through `ctx.get('webServer')`, so
  // this mounts the real plugin on a context that already provides the real
  // server and the gate.
  const { apply } = await import('../lib/index.js')
  const composed = new Context()
  composed.provide('connection', gate)
  composed.provide('tools', { register: () => () => {} })
  composed.provide('commands', { register: () => () => {} })
  const composedFiber = composed.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await composedFiber.await()
  const composedServer = composed.get('webServer')

  const pluginFiber = composed.plugin(
    { name: 'dsh-task-stack', inject: ['tools', 'commands'], apply },
    { stateDir: '.dsh/task-stack', maxStackDepth: 10, historyLimit: 10, statePruneDays: 0 },
  )
  await pluginFiber.await()

  const response = await fetch(
    `http://127.0.0.1:${String(composedServer.port)}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=${encodeURIComponent(workspace)}`,
  )
  assert.equal(response.status, 200, 'the plugin must have registered the endpoint')
  assert.equal((await response.json()).sessionId, sessionId)

  // Unloading the plugin must withdraw the route with it.
  await pluginFiber.dispose()
  const after = await fetch(
    `http://127.0.0.1:${String(composedServer.port)}${SNAPSHOT_PATH}?sessionId=${sessionId}&cwd=${encodeURIComponent(workspace)}`,
  )
  assert.equal(after.status, 404, 'the route must be disposed with the plugin')
  await composed.fiber.dispose()
})

await ctx.fiber.dispose()
await store.release()
await rm(root, { recursive: true, force: true })
process.stdout.write(`http surface tests: ${passed} passed\n`)
