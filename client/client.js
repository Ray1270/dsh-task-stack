/**
 * Browser half of dsh-task-stack: a read-only sidebar entry that renders the
 * current session's task stack.
 *
 * Shipped as written rather than compiled. The DSH client loader does not import an
 * ES module: it evaluates a bundle that calls `window.__ModuleLoader__.load`, and
 * receives `react` through the injected `require`. Hand-writing `createElement`
 * calls keeps this file both the source and the artefact, so there is no build step
 * that can drift from it and no JSX transform to configure.
 *
 * The panel is deliberately read-only. Mutations stay with the model tools and
 * `/focus`: a GUI write path would need its own approval story, and the host route
 * exposes only `getSnapshot`.
 */
window.__ModuleLoader__.load({
	id: '@ray1270/dsh-task-stack',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement

		/** Seat id, shared by the sidebar row and the main page it opens. */
		const PANEL_ID = 'dsh-task-stack'
		/** Sort key among sidebar panels; after the built-in session panels. */
		const PANEL_ORDER = 40
		const ENDPOINT = '/api/dsh-task-stack/snapshot'
		/** The host answers from disk on every request, so a short poll is cheap. */
		const POLL_MS = 4000

		const colors = {
			primary: 'var(--dsw-alias-label-primary, #1f2328)',
			secondary: 'var(--dsw-alias-label-secondary, #656d76)',
			tertiary: 'var(--dsw-alias-label-tertiary, #8b949e)',
			border: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))',
			surface: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03))',
			accent: 'var(--dsw-alias-state-info-primary, #0969da)',
			warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
		}

		/**
		 * Sidebar glyph: three stacked bars, the front one filled.
		 * @param props - framework style props.
		 * @returns the icon element.
		 */
		function TaskStackIcon({ size }) {
			const dimension = typeof size === 'number' ? size : 16
			return h(
				'svg',
				{
					width: dimension,
					height: dimension,
					viewBox: '0 0 16 16',
					fill: 'none',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('rect', { x: 2, y: 3.5, width: 9, height: 1.5, rx: 0.75, fill: 'currentColor', opacity: 0.4 }),
				h('rect', { x: 3.5, y: 7.25, width: 9, height: 1.5, rx: 0.75, fill: 'currentColor', opacity: 0.7 }),
				h('rect', { x: 5, y: 11, width: 9, height: 1.5, rx: 0.75, fill: 'currentColor' }),
			)
		}

		/**
		 * Subscribe to a reactive source without assuming a React version.
		 *
		 * `useSyncExternalStore` would be shorter, but it only exists from React 18 and
		 * a missing hook would break the whole panel; this form works on any version
		 * that has hooks and keeps the initial value read synchronous.
		 *
		 * @param source - object with `value` and `subscribe`.
		 * @returns the current value.
		 */
		function useSource(source) {
			const [value, setValue] = React.useState(() => (source === undefined ? undefined : source.value))
			React.useEffect(() => {
				if (source === undefined) return undefined
				setValue(source.value)
				return source.subscribe(() => setValue(source.value))
			}, [source])
			return value
		}

		/**
		 * Build the panel component bound to one client context.
		 *
		 * @param ctx - client root context (services: slots, uiSession).
		 * @returns the panel component.
		 */
		function makePanel(ctx) {
			return function TaskStackPanel() {
				// The current session binding is a reactive source; `key` is the session id
				// the host state file is named after.
				const current = ctx.uiSession === undefined ? undefined : ctx.uiSession.current
				const binding = useSource(current)
				const sessionId = binding === undefined ? undefined : (binding.key ?? binding.props?.sessionId)

				const [snapshot, setSnapshot] = React.useState(null)
				const [failure, setFailure] = React.useState('')
				const [tick, setTick] = React.useState(0)

				React.useEffect(() => {
					if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
					let live = true

					const load = async () => {
						try {
							// No `cwd`: the host resolves the session's workspace from its own
							// registry, which is the only trustworthy source for it.
							const response = await fetch(
								`${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`,
								{ credentials: 'same-origin', headers: { accept: 'application/json' } },
							)
							if (!live) return
							if (!response.ok) {
								setFailure(`HTTP ${String(response.status)}`)
								return
							}
							setFailure('')
							setSnapshot(await response.json())
						} catch (error) {
							if (live) setFailure(error instanceof Error ? error.message : String(error))
						}
					}

					load()
					const timer = setInterval(load, POLL_MS)
					return () => {
						live = false
						clearInterval(timer)
					}
				}, [sessionId, tick])

				const refresh = () => setTick((value) => value + 1)
				const stack = snapshot === null ? [] : (snapshot.stack ?? [])
				const active = snapshot === null ? undefined : snapshot.top
				const paused = stack.filter((frame) => frame !== active)
				const history = snapshot === null ? [] : (snapshot.history ?? [])

				const body = []
				if (sessionId === undefined || sessionId === null || sessionId === '') {
					body.push(
						h(
							'p',
							{ key: 'nosession', style: { color: colors.secondary, margin: 0 } },
							'No session is selected, so there is no stack to read.',
						),
					)
				} else if (snapshot === null) {
					body.push(
						h('p', { key: 'loading', style: { color: colors.secondary, margin: 0 } }, 'Loading…'),
					)
				} else if (stack.length === 0) {
					body.push(
						h(
							'p',
							{ key: 'empty', style: { color: colors.secondary, margin: 0, lineHeight: 1.6 } },
							'This session has no open task. The model pushes one by calling ',
							h('code', { style: { fontSize: '0.92em' } }, 'focus_task'),
							' when a multi-step objective appears.',
						),
					)
				} else {
					body.push(
						h(
							'div',
							{
								key: 'active',
								style: {
									borderLeft: `3px solid ${colors.accent}`,
									background: colors.surface,
									borderRadius: 8,
									padding: '10px 12px',
									marginBottom: 12,
								},
							},
							h(
								'div',
								{
									style: {
										fontSize: 11,
										letterSpacing: '0.04em',
										textTransform: 'uppercase',
										color: colors.accent,
										marginBottom: 4,
									},
								},
								'Active',
							),
							h(
								'div',
								{ style: { color: colors.primary, lineHeight: 1.55, wordBreak: 'break-word' } },
								active === undefined ? '' : active.description,
							),
							active === undefined
								? null
								: h(
										'div',
										{ style: { color: colors.tertiary, fontSize: 11, marginTop: 6 } },
										new Date(active.createdAt).toLocaleTimeString(),
									),
						),
					)

					if (paused.length > 0) {
						body.push(
							h(
								'div',
								{ key: 'pausedlabel', style: { color: colors.secondary, fontSize: 11, marginBottom: 6 } },
								`Paused (${String(paused.length)})`,
							),
						)
						body.push(
							h(
								'ul',
								{ key: 'paused', style: { listStyle: 'none', margin: '0 0 12px', padding: 0 } },
								// The store keeps the stack deepest-first, and so does the wire.
								paused.map((frame) =>
									h(
										'li',
										{
											key: frame.id,
											style: {
												color: colors.secondary,
												lineHeight: 1.5,
												padding: '6px 0 6px 10px',
												borderLeft: `2px solid ${colors.border}`,
												marginBottom: 4,
												wordBreak: 'break-word',
											},
										},
										frame.description,
									),
								),
							),
						)
					}
				}

				if (history.length > 0) {
					const recent = history.slice(-3).reverse()
					body.push(
						h(
							'div',
							{ key: 'historylabel', style: { color: colors.tertiary, fontSize: 11, marginBottom: 6 } },
							`Recently completed (${String(history.length)})`,
						),
					)
					body.push(
						h(
							'ul',
							{ key: 'history', style: { listStyle: 'none', margin: 0, padding: 0 } },
							recent.map((entry) =>
								h(
									'li',
									{
										key: entry.id,
										style: { fontSize: 12, color: colors.tertiary, lineHeight: 1.5, marginBottom: 6 },
									},
									h('div', { style: { textDecoration: 'line-through' } }, entry.description),
									entry.conclusion === ''
										? null
										: h('div', { style: { color: colors.secondary, wordBreak: 'break-word' } }, entry.conclusion),
								),
							),
						),
					)
				}

				const problems = []
				if (failure !== '') problems.push(failure)
				if (snapshot !== null && Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0) {
					problems.push(`${String(snapshot.warnings.length)} state warning(s)`)
				}
				if (problems.length > 0) {
					body.push(
						h(
							'p',
							{ key: 'problems', style: { color: colors.warn, fontSize: 11, margin: '12px 0 0' } },
							problems.join(' · '),
						),
					)
				}

				return h(
					'div',
					{ style: { padding: 16, fontSize: 13, fontFamily: 'inherit' } },
					h(
						'div',
						{
							style: {
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								marginBottom: 12,
							},
						},
						h(
							'div',
							{ style: { color: colors.primary, fontWeight: 600, fontSize: 14 } },
							'Task stack',
							stack.length === 0
								? null
								: h(
										'span',
										{
											style: {
												marginLeft: 8,
												fontWeight: 500,
												fontSize: 11,
												color: colors.secondary,
												border: `1px solid ${colors.border}`,
												borderRadius: 999,
												padding: '1px 7px',
											},
										},
										String(stack.length),
									),
						),
						h(
							'button',
							{
								type: 'button',
								onClick: refresh,
								style: {
									appearance: 'none',
									border: `1px solid ${colors.border}`,
									background: 'transparent',
									color: colors.secondary,
									borderRadius: 6,
									padding: '3px 9px',
									fontSize: 11,
									cursor: 'pointer',
								},
							},
							'Refresh',
						),
					),
					body,
					sessionId === undefined || sessionId === null || sessionId === ''
						? null
						: h(
								'p',
								{
									style: {
										color: colors.tertiary,
										fontSize: 10,
										margin: '14px 0 0',
										fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
										wordBreak: 'break-all',
									},
								},
								sessionId,
							),
				)
			}
		}

		/**
		 * Register the sidebar row and the page it opens.
		 *
		 * Both seats belong to shell plugins this package does not depend on at
		 * runtime, so each registration goes through `slots.inject`: the callback runs
		 * once the owning plugin declares the seat, and a shell that never declares it
		 * leaves the row simply absent instead of breaking boot.
		 *
		 * @param ctx - client root context.
		 * @returns disposer releasing both registrations.
		 */
		function registerPanel(ctx) {
			const slots = ctx.slots
			const Panel = makePanel(ctx)
			const disposers = [
				slots.inject('sidebar.panellist', () =>
					slots.register(
						{
							name: 'sidebar.panellist',
							id: PANEL_ID,
							order: PANEL_ORDER,
							label: () => '任务栈',
						},
						TaskStackIcon,
					),
				),
				slots.inject('main', () =>
					slots.register({ name: 'main', key: PANEL_ID, inject: () => ({}) }, Panel),
				),
			]
			return () => {
				for (const dispose of disposers.splice(0)) {
					try {
						dispose()
					} catch {
						// A seat disposed before us must not turn unload into a failure.
					}
				}
			}
		}

		/**
		 * Client plugin entry.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => registerPanel(ctx), 'dsh-task-stack: sidebar panel')
		}

		exports.apply = apply
		exports.inject = ['slots', 'uiSession']
		return module.exports
	},
})
