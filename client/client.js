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
				// Split by the frame's own status, not by identity with `top`: the wire
				// document carries `top` as a *second* view object for the same frame, so
				// `frame !== active` is true for every row and the active task would be
				// listed as paused as well.
				const paused = stack.filter((frame) => frame.status === 'paused')
				const history = snapshot === null ? [] : (snapshot.history ?? [])

				/** `HH:MM`, in the reader's own locale and clock. */
				const clock = (iso) => {
					const at = new Date(iso)
					return Number.isNaN(at.getTime())
						? ''
						: at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
				}

				/** How long ago a frame started, phrased for a trailing "…· <this>". */
				const elapsed = (iso) => {
					const at = new Date(iso).getTime()
					if (Number.isNaN(at)) return ''
					const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
					if (minutes < 1) return '刚刚'
					if (minutes < 60) return `${String(minutes)} 分钟前`
					const hours = Math.round(minutes / 60)
					if (hours < 24) return `${String(hours)} 小时前`
					return `${String(Math.round(hours / 24))} 天前`
				}

				/** One small grey heading with an optional trailing hint. */
				const heading = (key, text, hint) =>
					h(
						'div',
						{
							key,
							// A flex row with `gap`: an inline span's margin-left is easy to lose
							// against the surrounding text, and this heading is the only place the
							// two labels sit side by side.
							style: { display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 6px' },
						},
						h('span', { style: { color: colors.secondary, fontSize: 11, fontWeight: 600 } }, text),
						hint === undefined
							? null
							: h('span', { style: { color: colors.tertiary, fontSize: 11 } }, hint),
					)

				const body = []
				if (sessionId === undefined || sessionId === null || sessionId === '') {
					body.push(
						h(
							'p',
							{ key: 'nosession', style: { color: colors.secondary, margin: 0, lineHeight: 1.7 } },
							'当前没有选中会话，所以没有栈可读。',
						),
					)
				} else if (snapshot === null) {
					body.push(
						h('p', { key: 'loading', style: { color: colors.tertiary, margin: 0 } }, '读取中…'),
					)
				} else if (stack.length === 0) {
					body.push(
						h(
							'div',
							{ key: 'empty', style: { color: colors.secondary, lineHeight: 1.75 } },
							h('p', { style: { margin: '0 0 6px', color: colors.primary } }, '现在没有未完成的任务。'),
							h(
								'p',
								{ style: { margin: 0, fontSize: 12 } },
								'我在对话里遇到多步骤目标时，会把它们压进这个栈；做完一件就弹出去一件。你在这里看到的永远是当前真实状态，不是计划。',
							),
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
									marginBottom: 16,
								},
							},
							h(
								'div',
								{ style: { color: colors.accent, fontSize: 11, fontWeight: 600, marginBottom: 5 } },
								'正在做',
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
										`${clock(active.createdAt)} 开始 · ${elapsed(active.createdAt)}`,
									),
						),
					)

					if (paused.length > 0) {
						body.push(
							heading(
								'pausedlabel',
								`压着的 · ${String(paused.length)} 件`,
								'上面这件做完，依次回来',
							),
						)
						body.push(
							h(
								'ul',
								{
									key: 'paused',
									style: {
										listStyle: 'none',
										margin: '0 0 16px',
										padding: '0 0 0 12px',
										borderLeft: `2px solid ${colors.border}`,
									},
								},
								// The store keeps the stack deepest-first; reading downward must lead
								// back towards the active frame, so the nearest one prints first.
								paused
									.slice()
									.reverse()
									.map((frame) =>
										h(
											'li',
											{
												key: frame.id,
												style: {
													color: colors.secondary,
													lineHeight: 1.5,
													padding: '5px 0',
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
						heading(
							'historylabel',
							`最近做完 · ${String(recent.length)} 件`,
							history.length > recent.length ? `共 ${String(history.length)} 件` : undefined,
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
										style: { fontSize: 12, color: colors.tertiary, lineHeight: 1.5, marginBottom: 8 },
									},
									h(
										'div',
										null,
										h('span', { style: { color: colors.tertiary, marginRight: 5 } }, '✓'),
										h('span', { style: { textDecoration: 'line-through' } }, entry.description),
									),
									entry.conclusion === ''
										? null
										: h(
												'div',
												{
													style: {
														color: colors.secondary,
														wordBreak: 'break-word',
														marginTop: 2,
														paddingLeft: 16,
													},
												},
												entry.conclusion,
											),
								),
							),
						),
					)
				}

				const problems = []
				if (failure !== '') problems.push(failure)
				if (snapshot !== null && Array.isArray(snapshot.warnings) && snapshot.warnings.length > 0) {
					problems.push(`状态文件有 ${String(snapshot.warnings.length)} 条告警`)
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
					{ style: { padding: 16, fontSize: 13, fontFamily: 'inherit', maxWidth: 720 } },
					h(
						'div',
						{
							style: {
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								marginBottom: 6,
							},
						},
						h(
							'div',
							{ style: { color: colors.primary, fontWeight: 600, fontSize: 14 } },
							'任务栈',
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
												padding: '1px 8px',
											},
										},
										`未完成 ${String(stack.length)}`,
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
							'刷新',
						),
					),
					h(
						'p',
						{
							key: 'legend',
							style: {
								color: colors.secondary,
								fontSize: 11,
								lineHeight: 1.7,
								margin: '0 0 14px',
							},
						},
						'一个栈：最上面是我此刻正在做的；下面压着的，等它做完才回来；做完的会弹出去。',
					),
					body,
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
