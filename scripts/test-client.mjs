/**
 * Client-bundle contract test.
 *
 * The browser half cannot be rendered here (no DOM, and React is supplied by the
 * shell), so this asserts the contract the shell actually relies on:
 *
 *   1. evaluating the bundle calls `window.__ModuleLoader__.load` exactly once, with
 *      the package id and a factory;
 *   2. the factory returns `apply` and `inject`;
 *   3. `apply` routes both registrations through `slots.inject`, so a shell that
 *      never declares a seat leaves the panel absent instead of breaking boot;
 *   4. the sidebar row and the page share one id, which is what makes clicking the
 *      row open that page.
 *
 * Rendering itself is checked by looking at the panel in the running GUI.
 *
 * Usage: `node scripts/test-client.mjs` (after `pnpm build`).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const here = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8')

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  process.stdout.write(`  ok  ${label}\n`)
}

process.stdout.write('client bundle tests\n')

/** Evaluate the bundle against stubs and return what the shell would see. */
function loadBundle() {
  const loads = []
  const context = {
    window: {
      __ModuleLoader__: {
        load: (spec) => {
          loads.push(spec)
        },
      },
    },
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.reject(new Error('not used')),
    URLSearchParams,
    Date,
    Symbol,
    Object,
    Array,
    JSON,
    Math,
    String,
    Number,
    Boolean,
    Error,
    encodeURIComponent,
  }
  context.globalThis = context
  vm.createContext(context)
  new vm.Script(source, { filename: 'client.js' }).runInContext(context)

  assert.equal(loads.length, 1, 'the bundle must register exactly one module')
  const spec = loads[0]

  // A stub React: `createElement` is enough for module evaluation, because no
  // component body runs until the shell renders it. `useState` does honour the
  // initial value, so a component built here starts in the state it really starts in
  // (a stub that answered `undefined` would hide an initial-state branch).
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }

  return { spec, exported: spec.factory(require) }
}

const { spec, exported } = loadBundle()

check('registers under the package name, which is also the served path', () => {
  assert.equal(spec.id, pkg.name)
  assert.equal(typeof spec.factory, 'function')
})

check('exposes apply and inject', () => {
  assert.equal(typeof exported.apply, 'function')
  // Spread first: the bundle is evaluated in its own vm realm, so its Array
  // prototype differs and a strict deep-equal would fail on identical contents.
  assert.deepEqual([...exported.inject], ['slots', 'uiSession'])
})

check('package.json advertises the client half to the host', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  // Deliberately no `dsh.client.inject`: that field is the *row id* wait list of the
  // host roster, whose ids ("ui-session", "ui-renderer") are the shell's names, not
  // this package's contract. The module's own service-level `inject` below is what
  // makes Cordis wait for `slots` and `uiSession` instead.
  assert.equal(pkg.dsh.client.inject, undefined)
  assert.ok(pkg.files.includes('lib'), 'the built bundle must be published')
  assert.equal(pkg.exports['./client']?.default, './lib/client.js')
})

check('apply registers the sidebar row and the page through slots.inject', () => {
  const injections = []
  const registrations = []
  const effects = []

  const ctx = {
    slots: {
      inject: (seat, callback) => {
        injections.push(seat)
        // The shell invokes the callback once the seat exists.
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (definition, component) => {
        registrations.push({ definition, component })
        return () => {}
      },
    },
    effect: (fn, label) => {
      effects.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  exported.apply(ctx)

  assert.deepEqual(injections.sort(), ['main', 'sidebar.panellist'])
  assert.equal(effects.length, 1, 'the registration must be owned by a ctx.effect')

  const row = registrations.find((entry) => entry.definition.name === 'sidebar.panellist')
  const page = registrations.find((entry) => entry.definition.name === 'main')
  assert.ok(row, 'the sidebar row must be registered')
  assert.ok(page, 'the page must be registered')

  assert.equal(typeof row.definition.label, 'function', 'the label is locale-aware')
  assert.equal(row.definition.label(), '任务栈')
  assert.equal(typeof row.definition.order, 'number')
  assert.equal(typeof row.component, 'function', 'the row renders its icon')

  // One id links the row to the page; a mismatch makes clicking the row throw.
  assert.equal(page.definition.key, row.definition.id)
  assert.equal(row.definition.id, 'dsh-task-stack')
  assert.equal(typeof page.component, 'function', 'the page renders the panel')
  assert.equal(typeof page.definition.inject, 'function')
})

check('the panel component is constructible without a session', () => {
  // No context services at all: the component must still build its element tree, so a
  // composition without uiSession shows a hint instead of crashing the shell.
  const ctx = { slots: { inject: () => () => {}, register: () => () => {} }, effect: () => {} }
  let panel
  const stubs = {
    inject: (seat, callback) => {
      const dispose = callback()
      return dispose ?? (() => {})
    },
    register: (definition, component) => {
      if (definition.name === 'main') panel = component
      return () => {}
    },
  }
  ctx.slots = stubs
  ctx.effect = (fn) => {
    fn()
  }
  exported.apply(ctx)
  assert.equal(typeof panel, 'function')

  const element = panel({})
  assert.equal(typeof element, 'object')
  assert.equal(element.type, 'div')
})

process.stdout.write(`client bundle tests: ${passed} passed\n`)
