/**
 * dsh-task-stack — a persistent per-session task stack for DeepSeek Harness.
 *
 * This plugin gives an agent three explicit tools — `focus_task`,
 * `focus_complete`, and `read_focus` — that push, pop, and inspect a
 * last-in-first-out stack of multi-step work items, plus one human-facing
 * `/focus` command for inspecting and clearing that stack without spending a
 * model turn. The stack is persisted as a plain-text JSON document under the
 * session workspace (`<session-cwd>/<stateDir>/<sessionId>.json`), so it
 * survives context compaction and is recoverable when the session is resumed.
 *
 * The plugin is deliberately inert: it contributes **no** system-prompt text
 * and no automatic context injection, so it costs zero tokens until the model
 * calls one of its tools or a human types the command.
 *
 * @module dsh-task-stack
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Store } from './store.ts'
import { registerFocusTools } from './tools.ts'
import { registerFocusCommand } from './commands.ts'
import { resolveConfig, type PluginConfig } from './types.ts'

/**
 * Plugin display name; the fiber label and the logger name.
 *
 * Deliberately the SHORT name rather than the scoped package name: the scope
 * belongs to whoever publishes the package, while this label is what a user reads
 * in `[dsh-task-stack]` log lines. `check-build` and the probe derive the expected
 * label from `package.json` (scoped name minus its scope), so the two cannot
 * silently drift apart.
 */
export const name = 'dsh-task-stack'

/**
 * Required services: `tools` for the three model-facing tools, `commands` for
 * the `/focus` slash command. Both are provided by the base bundle of every
 * shipped profile, so the plugin stays loadable everywhere.
 */
export const inject = ['tools', 'commands']

/**
 * Configuration schema, validated by Cordis before {@link apply} runs.
 *
 * Each field is optional with a default, and Cordis's transform means `apply`
 * always receives a fully resolved config — a partial patch layer, an empty
 * `config:` block, and a missing block all behave the same. Out-of-range values
 * fail validation here (the plugin does not activate, and the boot log names the
 * offending field) instead of being silently coerced, because a silently
 * different policy is harder to diagnose than a refused plugin.
 */
export const Config = z.object({
  /** Directory for state files, relative to the session workspace. */
  stateDir: z
    .string()
    .min(1)
    .default('.dsh/task-stack')
    .description('Directory holding one JSON file per session, relative to the session workspace.'),
  /** Maximum number of frames on one stack. */
  maxStackDepth: z
    // `natural()` alone accepts 0, which would make every push fail.
    .natural()
    .min(1)
    .default(20)
    .description('Maximum number of open tasks on the stack; focus_task refuses to push past it.'),
  /** Maximum number of completed records kept per session. */
  historyLimit: z
    .natural()
    .min(1)
    .default(100)
    .description('Maximum number of completed tasks kept in history; the oldest records are trimmed first.'),
  /** Age in days after which an untouched session file is deleted on plugin load. */
  statePruneDays: z
    .natural()
    .default(0)
    .description(
      'Delete session state files not written for this many days, once per plugin load; 0 (the default) keeps every file.',
    ),
})

/**
 * Register the task-stack tools and the `/focus` command.
 *
 * The disposer returned by `ctx.tools.register()` is already Cordis-managed, so
 * unloading the plugin (including a hot reload) unregisters all three tools; the
 * extra effect here additionally releases the store's per-file lock map and
 * cannot leave an "already registered" error behind. Pruning is fire-and-forget:
 * its result only reaches the log, so a slow or failing scan never delays
 * activation or fails the plugin.
 *
 * @param ctx - the plugin context carrying the `tools` and `commands` services.
 * @param config - config resolved by {@link Config}; every field is present.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const logger = ctx.logger(name)
  const resolved = resolveConfig(config)
  const store = new Store(resolved, logger)

  ctx.effect(() => {
    const disposeTools = registerFocusTools(ctx, store)
    const disposeCommand = registerFocusCommand(ctx, store)
    return () => {
      disposeCommand()
      disposeTools()
      // The lock map is plugin state, not a Cordis registration; releasing it
      // here is the one thing the registry's own effects do not do.
      store.release()
    }
  }, 'dsh-task-stack')

  if (resolved.statePruneDays > 0) {
    // Fire-and-forget: pruning is housekeeping, so it never delays activation,
    // and it runs with no known session id — a file that old belongs to no live
    // session.
    void store
      .prune({ cwd: process.cwd(), days: resolved.statePruneDays })
      .then((result) => {
        if (result.removed.length > 0 || result.failed > 0) {
          logger.info(
            '%s',
            `pruned ${result.removed.length} stale state file(s), kept ${result.kept}, failed ${result.failed}`,
          )
        }
      })
      .catch((error: unknown) => {
        logger.warn('%s', `state prune failed: ${error instanceof Error ? error.message : String(error)}`)
      })
  }

  logger.info(
    '%s',
    `loaded — focus_task/focus_complete/read_focus + /focus registered; stateDir=${resolved.stateDir} maxStackDepth=${resolved.maxStackDepth} historyLimit=${resolved.historyLimit} statePruneDays=${resolved.statePruneDays}`,
  )
}
