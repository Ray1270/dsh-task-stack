/**
 * Pre-publish gate: typecheck, build, then every suite — driven by Node alone.
 *
 * Why not a shell one-liner (`pnpm build && pnpm test`): `npm publish` runs the
 * pre-publish script with the shell and PATH of whoever invoked npm. On this
 * machine the `pnpm` on that PATH is Electron's bundled pnpm, which writes a
 * crashpad file into `%LOCALAPPDATA%` and exits non-zero when that write is
 * denied — so the gate failed for a reason unrelated to this package, with the
 * child output swallowed by npm. Calling `node` and the local `tsc` keeps the
 * gate reproducible regardless of which package manager happens to be on PATH.
 *
 * Exits non-zero with the failing step's own output, so `npm publish` reports
 * what actually broke.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The package root: this script lives in `scripts/`, so the parent URL is the
 * package directory. `fileURLToPath` keeps its trailing separator, and `dirname`
 * on it would strip the last segment away — read the directory URL directly.
 */
const here = fileURLToPath(new URL('..', import.meta.url))
process.chdir(here)

/**
 * TypeScript's compiler is a Node script, so drive it through `process.execPath`.
 * Spawning the `.bin/tsc.cmd` shim instead would need a shell on Windows, and a
 * shell is exactly the PATH dependency this gate exists to avoid.
 */
const tsc = join(here, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  process.stderr.write(`release-check FAILED: TypeScript is not installed at ${tsc}; run the install first\n`)
  process.exit(1)
}

const steps = [
  { name: 'typecheck', command: process.execPath, args: [tsc, '-p', 'tsconfig.json', '--noEmit'] },
  { name: 'build', command: process.execPath, args: [tsc, '-p', 'tsconfig.json'] },
  { name: 'check-build', command: process.execPath, args: ['scripts/check-build.mjs'] },
  { name: 'probe', command: process.execPath, args: ['scripts/probe-load.mjs'] },
  { name: 'test:store', command: process.execPath, args: ['scripts/test-store.mjs'] },
  { name: 'test:tools', command: process.execPath, args: ['scripts/test-tools.mjs'] },
  { name: 'test:config', command: process.execPath, args: ['scripts/test-config.mjs'] },
  { name: 'test:commands', command: process.execPath, args: ['scripts/test-commands.mjs'] },
  { name: 'test:lifecycle', command: process.execPath, args: ['scripts/test-lifecycle.mjs'] },
  { name: 'demo', command: process.execPath, args: ['scripts/demo.mjs'] },
]

process.stdout.write(`release-check: ${steps.length} steps via ${process.version}\n`)

for (const step of steps) {
  const started = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: here,
    stdio: 'inherit',
    // `shell: false` is the point: no cmd.exe, no PATH lookups for pnpm.
    shell: false,
  })
  const elapsed = Date.now() - started
  if (result.error !== undefined) {
    process.stderr.write(`\nrelease-check FAILED at ${step.name}: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.stderr.write(`\nrelease-check FAILED at ${step.name} (exit ${String(result.status)}, ${elapsed}ms)\n`)
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`release-check: ok ${step.name} (${elapsed}ms)\n`)
}

process.stdout.write('release-check: all steps passed\n')
