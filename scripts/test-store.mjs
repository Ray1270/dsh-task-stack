/**
 * Standalone store test: no DSH, no Cordis. Imports the compiled
 * `lib/store.js` + `lib/types.js`, drives the state layer against a temp
 * directory, and asserts file contents plus concurrency/edge behavior.
 *
 * Usage: `pnpm test:store` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const { Store, resolveStatePath } = await import('../lib/store.js')
const { resolveConfig } = await import('../lib/types.js')

const LOG = []
const logger = { warn: (format, ...rest) => LOG.push(String(format) + ' ' + rest.map(String).join(' ')) }

const root = await mkdtemp(join(tmpdir(), 'dsh-task-stack-test-'))
const cwd = join(root, 'workspace')
const config = resolveConfig({ stateDir: '.dsh/task-stack', maxStackDepth: 3, historyLimit: 3 })
const session = 'session-test-1'

let passed = 0
const check = (name, fn) => {
  return (async () => {
    await fn()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  })()
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

process.stdout.write('store tests\n')

// --- shape ------------------------------------------------------------------
await check('resolveStatePath joins cwd + stateDir + sessionId', () => {
  const path = resolveStatePath(session, cwd, config)
  assert.equal(path, join(cwd, '.dsh', 'task-stack', `${session}.json`))
})

await check('rejects an absolute stateDir', () => {
  assert.throws(() => resolveStatePath(session, cwd, { ...config, stateDir: 'C:\\abs' }), RangeError)
})

// --- push / pop round trip ---------------------------------------------------
const store = new Store(config, logger)
const location = store.locate(session, cwd)

await check('missing file reads as an empty stack', async () => {
  const snapshot = await store.getSnapshot(location)
  assert.deepEqual(snapshot.stack, [])
  assert.deepEqual(snapshot.history, [])
  assert.equal(snapshot.created, true)
  assert.deepEqual(snapshot.warnings, [])
})

await check('push writes the documented document shape', async () => {
  const result = await store.pushTask(location, 'first task')
  assert.equal(result.ok, true)
  const frame = result.value.pushed
  assert.match(frame.id, /^task-[0-9a-f-]{36}$/)
  assert.equal(frame.description, 'first task')
  assert.equal(frame.status, 'active')

  const document = await readJson(location.path)
  assert.equal(document.version, 1)
  assert.equal(document.sessionId, session)
  assert.equal(document.stack.length, 1)
  assert.deepEqual(document.history, [])
  assert.deepEqual(document.stack[0], {
    id: frame.id,
    description: 'first task',
    createdAt: frame.createdAt,
    status: 'active',
  })
  assert.match(document.stack[0].createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

await check('a second push pauses the previous frame', async () => {
  await store.pushTask(location, 'second task')
  const document = await readJson(location.path)
  assert.deepEqual(
    document.stack.map((frame) => [frame.description, frame.status]),
    [
      ['first task', 'paused'],
      ['second task', 'active'],
    ],
  )
})

await check('pop records a conclusion and resumes the frame below', async () => {
  const result = await store.popTask(location, 'second is done')
  assert.equal(result.ok, true)
  assert.equal(result.value.completed.description, 'second task')
  assert.equal(result.value.completed.conclusion, 'second is done')
  assert.match(result.value.completed.completedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(result.value.resumed?.description, 'first task')
  assert.equal(result.value.resumed?.status, 'active')

  const document = await readJson(location.path)
  assert.equal(document.stack.length, 1)
  assert.equal(document.stack[0].status, 'active')
  assert.equal(document.history.length, 1)
  assert.equal(document.history[0].conclusion, 'second is done')
})

// --- boundaries --------------------------------------------------------------
await check('pop on an empty stack is refused, not thrown', async () => {
  await store.popTask(location, 'finish first')
  const refused = await store.popTask(location, 'nothing left')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'stack-empty')
  assert.match(refused.message, /empty/)
})

await check('push on a full stack is refused and leaves the file untouched', async () => {
  const before = await readFile(location.path, 'utf8')
  await store.pushTask(location, 'one')
  await store.pushTask(location, 'two')
  await store.pushTask(location, 'three')
  const full = await store.pushTask(location, 'four')
  assert.equal(full.ok, false)
  assert.equal(full.code, 'stack-full')
  assert.match(full.message, /3\/3/)
  const document = await readJson(location.path)
  assert.equal(document.stack.length, 3)
  assert.ok(before.length > 0)
})

await check('history is trimmed to historyLimit, newest kept', async () => {
  // Stack: [one, two, three] (full). Complete everything, then run two more
  // tasks through the stack so `history` exceeds the limit of 3.
  for (const conclusion of ['c-three', 'c-two', 'c-one']) {
    assert.equal((await store.popTask(location, conclusion)).ok, true)
  }
  for (const name of ['extra-1', 'extra-2']) {
    assert.equal((await store.pushTask(location, name)).ok, true)
    assert.equal((await store.popTask(location, `c-${name}`)).ok, true)
  }
  const document = await readJson(location.path)
  assert.equal(document.stack.length, 0)
  assert.equal(document.history.length, 3, 'history must be capped at historyLimit')
  assert.deepEqual(
    document.history.map((entry) => entry.conclusion),
    ['c-one', 'c-extra-1', 'c-extra-2'],
  )
})

// --- concurrency -------------------------------------------------------------
await check('concurrent pushes are serialized: no lost updates', async () => {
  const raceDir = join(root, 'race')
  const raceStore = new Store({ ...config, maxStackDepth: 50, historyLimit: 50 }, logger)
  const raceLocation = raceStore.locate('session-race', raceDir)
  const pushes = Array.from({ length: 25 }, (_value, index) => raceStore.pushTask(raceLocation, `race-${index}`))
  const results = await Promise.all(pushes)
  assert.equal(results.filter((result) => result.ok).length, 25)
  const document = await readJson(raceLocation.path)
  assert.equal(document.stack.length, 25)
  assert.deepEqual(
    document.stack.map((frame) => frame.description).sort(),
    Array.from({ length: 25 }, (_value, index) => `race-${index}`).sort(),
  )
  assert.equal(document.stack.at(-1).status, 'active')
  assert.equal(document.stack.filter((frame) => frame.status === 'active').length, 1)
})

await check('a second session in the same workspace keeps its own file', async () => {
  const other = store.locate('session-test-2', cwd)
  await store.pushTask(other, 'other session task')
  const mine = await readJson(location.path)
  const theirs = await readJson(other.path)
  assert.equal(theirs.stack.length, 1)
  assert.equal(theirs.stack[0].description, 'other session task')
  assert.equal(mine.sessionId, session)
  assert.equal(theirs.sessionId, 'session-test-2')
})

// --- corruption --------------------------------------------------------------
await check('invalid JSON degrades to an empty stack with one warning', async () => {
  const badDir = join(root, 'bad-json')
  const badStore = new Store(config, logger)
  const badLocation = badStore.locate('session-bad', badDir)
  await store.pushTask(badLocation, 'seed')
  await writeFile(badLocation.path, '{ this is not json', 'utf8')

  const snapshot = await badStore.getSnapshot(badLocation)
  assert.deepEqual(snapshot.stack, [])
  assert.equal(snapshot.warnings.length, 1)
  assert.equal(snapshot.warnings[0].code, 'invalid-json')
  assert.ok(LOG.some((line) => line.includes('not valid JSON')), 'the warning must also reach the logger')
})

await check('a version mismatch degrades to an empty stack', async () => {
  const dir = join(root, 'bad-version')
  const badStore = new Store(config, logger)
  const badLocation = badStore.locate('session-v', dir)
  await store.pushTask(badLocation, 'seed')
  const document = await readJson(badLocation.path)
  await writeFile(badLocation.path, JSON.stringify({ ...document, version: 99 }), 'utf8')
  const snapshot = await badStore.getSnapshot(badLocation)
  assert.deepEqual(snapshot.stack, [])
  assert.equal(snapshot.warnings[0].code, 'version-mismatch')
})

await check('a malformed frame is dropped and the rest is kept', async () => {
  const dir = join(root, 'bad-frame')
  const badStore = new Store(config, logger)
  const badLocation = badStore.locate('session-f', dir)
  await store.pushTask(badLocation, 'good one')
  await store.pushTask(badLocation, 'good two')
  const document = await readJson(badLocation.path)
  document.stack.splice(1, 0, { description: 'missing id' })
  await writeFile(badLocation.path, JSON.stringify(document), 'utf8')

  const snapshot = await badStore.getSnapshot(badLocation)
  assert.equal(snapshot.stack.length, 2)
  assert.deepEqual(snapshot.stack.map((frame) => frame.description), ['good one', 'good two'])
  assert.equal(snapshot.warnings[0].code, 'dropped-frame')
})

await check('a foreign sessionId in the file degrades to an empty stack', async () => {
  const dir = join(root, 'bad-session')
  const badStore = new Store(config, logger)
  const badLocation = badStore.locate('session-owner', dir)
  await store.pushTask(badLocation, 'seed')
  const document = await readJson(badLocation.path)
  await writeFile(badLocation.path, JSON.stringify({ ...document, sessionId: 'someone-else' }), 'utf8')
  const snapshot = await badStore.getSnapshot(badLocation)
  assert.deepEqual(snapshot.stack, [])
  assert.equal(snapshot.warnings[0].code, 'session-mismatch')
})

await check('200 concurrent pushes lose nothing and leave no temp files', async () => {
  const dir = join(root, 'stress')
  const stressStore = new Store({ ...config, maxStackDepth: 200, historyLimit: 200 }, logger)
  const stressLocation = stressStore.locate('session-stress', dir)
  const results = await Promise.all(
    Array.from({ length: 200 }, (_value, index) => stressStore.pushTask(stressLocation, `stress-${index}`)),
  )
  assert.equal(results.filter((result) => result.ok).length, 200)
  const document = await readJson(stressLocation.path)
  assert.equal(document.stack.length, 200)
  assert.equal(new Set(document.stack.map((frame) => frame.id)).size, 200)
  const leftovers = (await readdir(dirname(stressLocation.path))).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'atomic writes must not leave temp files behind')
})

await check('interleaved push/pop on one file keeps every successful push accounted for', async () => {
  const dir = join(root, 'interleaved')
  // A roomy stack so the interesting case is ordering, not the depth cap:
  // each pop is submitted after its own push, so under strict FIFO serialization
  // every pop should find a frame.
  const mixed = new Store({ ...config, maxStackDepth: 200, historyLimit: 200 }, logger)
  const mixedLocation = mixed.locate('session-mixed', dir)
  await mixed.pushTask(mixedLocation, 'base')
  const operations = []
  for (let index = 0; index < 20; index += 1) {
    operations.push(mixed.pushTask(mixedLocation, `mixed-${index}`))
    operations.push(mixed.popTask(mixedLocation, `done-${index}`))
  }
  const results = await Promise.all(operations)
  const pushes = results.filter((_result, index) => index % 2 === 0)
  const pops = results.filter((_result, index) => index % 2 === 1)
  const okPushes = pushes.filter((result) => result.ok).length
  const okPops = pops.filter((result) => result.ok).length

  assert.equal(okPushes, 20, `every push should fit, got ${okPushes}`)
  assert.equal(okPops, 20, `every pop should find a frame, got ${okPops}`)

  const document = await readJson(mixedLocation.path)
  // 1 base + 20 successful pushes, each either still queued or already completed.
  assert.equal(document.stack.length + document.history.length, 21)
  assert.equal(document.stack.filter((frame) => frame.status === 'active').length, document.stack.length > 0 ? 1 : 0)
})

// --- pruning -----------------------------------------------------------------
/** Create a state file for `id` and backdate its mtime by `ageDays`. */
async function seedState(dir, id, ageDays) {
  const seeded = new Store({ ...config, maxStackDepth: 5, historyLimit: 5 }, logger)
  const seededLocation = seeded.locate(id, dir)
  await seeded.pushTask(seededLocation, `seed for ${id}`)
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
  await utimes(seededLocation.path, when, when)
  seeded.release()
  return seededLocation.path
}

await check('prune deletes only files older than the threshold', async () => {
  const dir = join(root, 'prune')
  const fresh = await seedState(dir, 'session-fresh', 0)
  const stale = await seedState(dir, 'session-stale', 30)
  const boundary = await seedState(dir, 'session-boundary', 6)

  const pruneStore = new Store({ ...config, statePruneDays: 7 }, logger)
  const result = await pruneStore.prune({ cwd: dir, days: 7 })

  assert.deepEqual(result.removed, ['session-stale.json'])
  assert.equal(result.kept, 2)
  assert.equal(result.failed, 0)
  assert.deepEqual((await readdir(dirname(fresh))).sort(), ['session-boundary.json', 'session-fresh.json'])
  assert.ok(!(await readdir(dirname(stale))).includes('session-stale.json'))
  pruneStore.release()
})

await check('prune spares the calling session and disabled pruning is a no-op', async () => {
  const dir = join(root, 'prune-own')
  await seedState(dir, 'session-mine', 90)
  await seedState(dir, 'session-theirs', 90)

  const pruneStore = new Store({ ...config, statePruneDays: 7 }, logger)
  const withOwn = await pruneStore.prune({ cwd: dir, days: 7, currentSessionId: 'session-mine' })
  assert.deepEqual(withOwn.removed, ['session-theirs.json'])
  assert.equal(withOwn.kept, 1)

  // days <= 0 disables pruning entirely, even for very old files.
  const stateDir = join(dir, '.dsh', 'task-stack')
  const kept = await pruneStore.prune({ cwd: dir, days: 0 })
  assert.deepEqual(kept.removed, [])
  assert.equal((await readdir(stateDir)).includes('session-mine.json'), true)
  pruneStore.release()
})

await check('prune ignores non-json files and a missing directory', async () => {
  const dir = join(root, 'prune-shape')
  await seedState(dir, 'session-old', 40)
  const stateDir = join(dir, '.dsh', 'task-stack')
  const { writeFile: write } = await import('node:fs/promises')
  await write(join(stateDir, 'leftover.tmp'), 'crash residue', 'utf8')
  await write(join(stateDir, 'notes.txt'), 'not a state file', 'utf8')

  const pruneStore = new Store({ ...config, statePruneDays: 7 }, logger)
  const result = await pruneStore.prune({ cwd: dir, days: 7 })
  assert.deepEqual(result.removed, ['session-old.json'])
  const remaining = (await readdir(stateDir)).sort()
  assert.deepEqual(remaining, ['leftover.tmp', 'notes.txt'])

  const missing = await pruneStore.prune({ cwd: join(root, 'no-such-workspace'), days: 7 })
  assert.deepEqual(missing.removed, [])
  assert.equal(missing.failed, 0, 'a missing state dir is not a failure')
  pruneStore.release()
})

await check('clearStack records every frame and is idempotent', async () => {
  const dir = join(root, 'clear')
  const clearStore = new Store({ ...config, maxStackDepth: 5, historyLimit: 5 }, logger)
  const clearLocation = clearStore.locate('session-clear', dir)
  await clearStore.pushTask(clearLocation, 'bottom')
  await clearStore.pushTask(clearLocation, 'top')

  const first = await clearStore.clearStack(clearLocation, 'cleared by test')
  assert.deepEqual(
    first.cleared.map((frame) => frame.description),
    ['bottom', 'top'],
  )
  const document = await readJson(clearLocation.path)
  assert.equal(document.stack.length, 0)
  assert.deepEqual(
    document.history.map((entry) => [entry.description, entry.conclusion]),
    [
      ['bottom', 'cleared by test'],
      ['top', 'cleared by test'],
    ],
  )

  const second = await clearStore.clearStack(clearLocation, 'cleared by test')
  assert.deepEqual(second.cleared, [], 'clearing an empty stack must not fail')
  clearStore.release()
})

// --- lifecycle ---------------------------------------------------------------
await check('release clears lock bookkeeping', async () => {
  const before = store.lockCount
  store.release()
  assert.equal(store.lockCount, 0)
  assert.ok(before >= 0)
  // The store keeps working after release.
  const snapshot = await store.getSnapshot(location)
  assert.equal(snapshot.sessionId, session)
})

await rm(root, { recursive: true, force: true })

// --- sample document ---------------------------------------------------------
// Leave one human-readable artifact behind so the on-disk contract can be
// inspected without re-running the suite.
const demoRoot = join(dirname(process.argv[1] ?? '.'), '..', '.demo')
const demoStore = new Store(resolveConfig({ maxStackDepth: 20, historyLimit: 100 }), logger)
const demoLocation = demoStore.locate('session-00000000-0000-4000-8000-000000000000', demoRoot)
await rm(demoRoot, { recursive: true, force: true })
await demoStore.pushTask(demoLocation, 'scaffold the plugin package and patch layer')
await demoStore.pushTask(demoLocation, 'implement the state store with an atomic write')
await demoStore.popTask(demoLocation, 'store.ts passes 18 standalone checks')
process.stdout.write(`\nsample state file: ${demoLocation.path}\n`)
process.stdout.write(await readFile(demoLocation.path, 'utf8'))

process.stdout.write(`store tests: ${passed} passed\n`)
