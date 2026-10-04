/**
 * Publish this package to npm for a release tag, idempotently.
 *
 * Run by `.github/workflows/release.yml` on a `v*` tag push, and runnable locally
 * to see exactly what CI would do. It exists as a script rather than inline shell
 * because a Windows runner has no bash, and because every decision below needs to
 * be reviewable:
 *
 *   1. the tag must match `package.json` (a mismatch is a release mistake, not a
 *      thing to paper over — it would publish content under the wrong number);
 *   2. an already-published version is a success, not a failure (so a re-run, or a
 *      release that half-succeeded, converges instead of erroring — this package
 *      lost a version number to exactly that in 0.2.0);
 *   3. publishing runs `npm publish`, whose `prepack` is the release gate.
 *
 * Usage:
 *   node scripts/publish-release.mjs --dry-run        # decide only, print the plan
 *   node scripts/publish-release.mjs                  # publish if the version is new
 *   node scripts/publish-release.mjs --tag v0.2.0     # decide for an explicit tag
 *
 * @module dsh-task-stack/scripts/publish-release
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const here = join(import.meta.dirname, '..')

/** Read an argument of the form `--name value`. */
function argument(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const dryRun = process.argv.includes('--dry-run')
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const name = pkg.name
const version = pkg.version

// CI passes the tag; locally, the most recent tag on HEAD is the intent.
const given = argument('tag')
const tag = given ?? mostRecentTag()

if (tag === undefined) {
  // Not a release run: a branch build should never publish.
  process.stdout.write('publish-release: no tag given and HEAD is untagged; nothing to publish\n')
  process.exit(0)
}

// A branch ref means this is a manual `workflow_dispatch` run, whose whole point
// is to validate the pipeline. `GITHUB_REF_NAME` is then the branch name, which can
// never match a release tag — failing on it would make the documented validation
// entry point always red, so a non-tag ref is a validation run instead. A real tag
// that disagrees with the version still fails, because publishing content under the
// wrong number is a release accident, not something to paper over.
const isVersionTag = /^v\d/u.test(tag)
if (!isVersionTag) {
  process.stdout.write(`publish-release: ref ${tag} is not a v* tag; validating without publishing\n`)
  reportCredential()
  process.exit(0)
}

const expected = `v${version}`
if (tag !== expected) {
  process.stderr.write(
    `publish-release: tag ${tag} does not match package.json version ${version} (expected tag ${expected})\n`,
  )
  process.exit(1)
}

process.stdout.write(`publish-release: ${name}@${version} for tag ${tag}\n`)

// `npm view` is the authority on what exists; a 404 comes back as a non-zero exit.
const existing = spawnSync('npm', ['view', `${name}@${version}`, 'version'], {
  cwd: here,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
const published = existing.status === 0 && existing.stdout.trim() === version

if (!published && !dryRun && !hasCredential()) {
  // A missing secret is a configuration mistake with a confusing symptom (a bare
  // 401 from the registry), so name it.
  process.stderr.write(
    'publish-release: no npm credential found. Set the NPM_TOKEN repository secret (Settings -> Secrets and variables -> Actions) to the value of an npm Automation or Publish token.\n',
  )
  process.exit(1)
}

if (!published) {
  process.stdout.write(`publish-release: running the release gate and publishing\n`)
  if (dryRun) {
    process.stdout.write('publish-release: --dry-run, stopping before npm publish\n')
    process.exit(0)
  }
  const result = spawnSync('npm', ['publish', '--access=public'], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.stderr.write(`publish-release: npm publish failed with exit code ${String(result.status)}\n`)
    process.exit(result.status ?? 1)
  }
  process.stdout.write(`publish-release: published ${name}@${version}\n`)
} else {
  process.stdout.write(`publish-release: ${version} is already on the registry; nothing to publish (success)\n`)
}

// Produce the tarball the Release attaches. `npm pack` with `--ignore-scripts`
// would skip `prepack`, but that also skips the build the tarball needs, so the
// gate runs again here; publishing ten seconds slower is cheaper than shipping a
// tarball built differently from the one npm received. The filename is read from
// npm's JSON output rather than guessed, because a scoped name is mangled
// (`@scope/name` → `scope-name`).
if (!dryRun) {
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', here], {
    cwd: here,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (packed.status !== 0) {
    process.stderr.write(`publish-release: npm pack failed\n${packed.stderr ?? ''}`)
    process.exit(packed.status ?? 1)
  }
  const filename = /"filename"\s*:\s*"([^"]+)"/u.exec(packed.stdout)?.[1]
  if (filename === undefined) {
    process.stderr.write(`publish-release: npm pack reported no filename\n${packed.stdout}\n`)
    process.exit(1)
  }
  process.stdout.write(`publish-release: tarball ${filename}\n`)
}

/** The tag pointing at HEAD, or `undefined` when HEAD is untagged. */
function mostRecentTag() {
  const result = spawnSync('git', ['tag', '--points-at', 'HEAD'], { cwd: here, encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const tags = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^v\d/u.test(line))
  return tags[0]
}

/**
 * Whether the environment holds an npm credential.
 *
 * `NODE_AUTH_TOKEN` is what `actions/setup-node` uses; a developer machine may
 * instead have a token in `~/.npmrc`, which `npm whoami` confirms. Checking both
 * keeps the CI-oriented guard from blocking a local run.
 *
 * @returns true when a credential appears to be available.
 */
function hasCredential() {
  if ((process.env.NODE_AUTH_TOKEN ?? '').trim() !== '') return true
  const whoami = spawnSync('npm', ['whoami'], {
    cwd: here,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return whoami.status === 0 && whoami.stdout.trim() !== ''
}

/** Report credential availability without deciding anything. */
function reportCredential() {
  const fromEnv = (process.env.NODE_AUTH_TOKEN ?? '').trim() !== ''
  const available = hasCredential()
  process.stdout.write(
    `publish-release: NODE_AUTH_TOKEN ${fromEnv ? 'is set' : 'is empty'}; npm credential ${available ? 'available' : 'NOT available'}\n`,
  )
  if (!available) {
    process.stderr.write(
      'publish-release: no npm credential found. Set the NPM_TOKEN repository secret (Settings -> Secrets and variables -> Actions) to the value of an npm Automation or Publish token.\n',
    )
  }
}
