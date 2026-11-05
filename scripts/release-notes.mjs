/**
 * Release notes for one tag: the matching `CHANGELOG.md` section.
 *
 * Why a script instead of `generate_release_notes: true`: the auto-generated body
 * is a commit list, and a commit list is not release notes — `v0.3.0` shipped with
 * nothing but `Full Changelog: v0.2.0...v0.3.0` on its page while the actual change
 * (a GUI panel, a silent-skip fix) stayed invisible to anyone browsing releases.
 * The changelog is written once, reviewed with the code, and read by three
 * consumers: this script (for the Release body), `release-check` (which refuses to
 * publish a version that has no section), and people.
 *
 * The fallback exists so a tag with no section still produces a readable page
 * instead of an empty one; it is deliberately labelled as automatic.
 *
 * Usage:
 *   node scripts/release-notes.mjs --tag v0.3.0              # print to stdout
 *   node scripts/release-notes.mjs --tag v0.3.0 --out f.md   # write to a file
 *   node scripts/release-notes.mjs --check                   # gate: section must exist
 */
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
process.chdir(here)

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const tagArgument = flagValue('--tag')
const outArgument = flagValue('--out')
const checkOnly = argv.includes('--check')

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const version = (tagArgument ?? `v${manifest.version}`).replace(/^v/u, '')
const tag = `v${version}`
/** `git+https://…/repo.git` → `https://…/repo`, for the compare link. */
const repoUrl = String(manifest.repository?.url ?? '')
  .replace(/^git\+/u, '')
  .replace(/\.git$/u, '')

/**
 * The body of the `## <version>` section, without its heading.
 *
 * @param markdown - whole changelog file.
 * @param wanted - version without the `v` prefix.
 * @returns the section body, or `undefined` when the file has no such section.
 */
function sectionOf(markdown, wanted) {
  const lines = markdown.split(/\r?\n/u)
  const start = lines.findIndex((line) => {
    const heading = /^##\s+(.+)$/u.exec(line)
    if (heading === null) return false
    const token = heading[1].trim().split(/\s+/u)[0]
    return token === wanted || token === `v${wanted}`
  })
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/u.test(lines[index])) {
      end = index
      break
    }
  }
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body.length === 0 ? undefined : body
}

/** The tag before `tag`, or `undefined` when the local repository cannot say. */
function previousTag() {
  const result = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${tag}^`], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return undefined
  const found = result.stdout.trim()
  return found.length === 0 ? undefined : found
}

/** One bullet per non-merge commit in `range`, or `[]` when git cannot say. */
function commitBullets(range) {
  const result = spawnSync('git', ['log', '--no-merges', '--pretty=format:- %s (%h)', range], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('- '))
}

/** Build a readable body when the changelog has no section for this version. */
function automaticBody() {
  const previous = previousTag()
  const bullets = commitBullets(previous === undefined ? tag : `${previous}..${tag}`)
  const lines = ['_CHANGELOG.md has no section for this version, so this body is a summary of the commits._', '']
  lines.push(...(bullets.length > 0 ? bullets : ['- (no commits found for this tag)']))
  if (previous !== undefined && repoUrl.length > 0) {
    lines.push('', `**Full Changelog**: ${repoUrl}/compare/${previous}...${tag}`)
  }
  return lines.join('\n')
}

let changelog
try {
  changelog = await readFile('CHANGELOG.md', 'utf8')
} catch (error) {
  changelog = undefined
}

const section = changelog === undefined ? undefined : sectionOf(changelog, version)

if (checkOnly) {
  if (section === undefined) {
    process.stderr.write(
      `release-notes FAILED: CHANGELOG.md has no "${version}" section.\n` +
        `Add one before publishing, with a heading exactly like:\n\n  ## ${version} — YYYY-MM-DD\n\n`,
    )
    process.exit(1)
  }
  const lines = section.split('\n').length
  process.stdout.write(`release-notes: ok ${version} (${lines} line${lines === 1 ? '' : 's'} in CHANGELOG.md)\n`)
} else {
  const body = section ?? automaticBody()
  if (outArgument !== undefined) {
    await writeFile(outArgument, `${body}\n`, 'utf8')
    process.stdout.write(
      `release-notes: wrote ${body.split('\n').length} lines for ${tag} to ${outArgument}` +
        `${section === undefined ? ' (automatic fallback: no changelog section)' : ''}\n`,
    )
  } else {
    process.stdout.write(`${body}\n`)
  }
}
