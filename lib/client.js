window.__ModuleLoader__.load({
	id: "dsh-dot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:/home/claude/dsh-rc2/packages/client/dsh-computer-ui/src/client/view.module.css.mjs
		const css = "._7viN-G_root{flex-direction:column;width:100%;height:100%;min-height:0;display:flex;position:relative}._7viN-G_bar{border-bottom:1px solid var(--dsh-color-border,#7f7f7f33);flex:none;align-items:center;gap:6px;padding:4px 8px;font-size:12px;display:flex}._7viN-G_dot{background:#9aa0a6;border-radius:50%;flex:none;width:7px;height:7px}._7viN-G_dotReady{background:#3fb950}._7viN-G_dotStarting{background:#d29922}._7viN-G_label{text-overflow:ellipsis;white-space:nowrap;opacity:.8;flex:1;min-width:0;overflow:hidden}._7viN-G_frame{background:#1e1e1e;border:0;flex:1;width:100%;min-height:0}._7viN-G_empty{text-align:center;opacity:.85;flex-direction:column;flex:1;justify-content:center;align-items:center;gap:12px;padding:24px;font-size:13px;display:flex}._7viN-G_actions{flex-wrap:wrap;justify-content:center;gap:8px;display:flex}._7viN-G_icon{display:inline-flex}";
		const tagId = "dsh-dot/view.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-dot";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var view_module_css_default = {
			"actions": "_7viN-G_actions",
			"bar": "_7viN-G_bar",
			"dot": "_7viN-G_dot",
			"dotReady": "_7viN-G_dotReady",
			"dotStarting": "_7viN-G_dotStarting",
			"empty": "_7viN-G_empty",
			"frame": "_7viN-G_frame",
			"icon": "_7viN-G_icon",
			"label": "_7viN-G_label",
			"root": "_7viN-G_root"
		};
		//#endregion
		//#region src/client/endpoint.ts
		/**
		* noVNC page that scales the remote desktop to the panel and reconnects after VM restarts.
		* @param endpoint - computer host and port.
		* @returns the live view URL.
		*/
		function liveViewUrl(endpoint) {
			return `http://${endpoint.host}:${endpoint.port}/vnc/index.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000`;
		}
		/**
		* Whether the computer's sandbox API accepts a connection. An opaque `no-cors`
		* response still proves the listener is up; a refused connection rejects.
		* @param endpoint - computer host and port.
		* @param signal - aborts the probe.
		* @returns `true` when the computer answered within three seconds.
		*/
		async function probe(endpoint, signal) {
			const timeout = AbortSignal.timeout(3e3);
			try {
				await fetch(`http://${endpoint.host}:${endpoint.port}/v1/sandbox`, {
					mode: "no-cors",
					cache: "no-store",
					signal: AbortSignal.any([signal, timeout])
				});
				return true;
			} catch {
				return false;
			}
		}
		//#endregion
		//#region src/client/view.tsx
		/** Sidebar tab body: the computer's live desktop (noVNC) with a status bar. */
		/**
		* Render the live view once the computer answers; poll while it does not.
		* @param props - tab info, copy, and the computer endpoint.
		* @returns the status bar and the embedded desktop, or a waiting panel.
		*/
		function ComputerView({ useTabInfo, t, endpoint }) {
			const { tab } = useTabInfo();
			const [status, setStatus] = (0, react.useState)("checking");
			const [revision, setRevision] = (0, react.useState)(0);
			const url = liveViewUrl(endpoint);
			const check = (0, react.useCallback)(async (signal) => {
				const ok = await probe(endpoint, signal);
				if (!signal.aborted) setStatus(ok ? "ready" : "offline");
			}, [endpoint]);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				check(controller.signal);
				return () => {
					controller.abort();
				};
			}, [check, revision]);
			(0, react.useEffect)(() => {
				if (status === "ready") return;
				const timer = setInterval(() => {
					setRevision((r) => r + 1);
				}, 4e3);
				return () => {
					clearInterval(timer);
				};
			}, [status]);
			const reload = () => {
				setStatus("checking");
				setRevision((r) => r + 1);
			};
			const openBuiltin = () => {
				tab.actions.openTab("browser", { params: { url } });
			};
			const openExternal = () => {
				window.open(url, "_blank", "noopener");
			};
			const dotClass = status === "ready" ? `${view_module_css_default.dot} ${view_module_css_default.dotReady}` : status === "checking" ? `${view_module_css_default.dot} ${view_module_css_default.dotStarting}` : view_module_css_default.dot;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: view_module_css_default.root,
				"data-dsh-computer-view": true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: view_module_css_default.bar,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: dotClass,
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: view_module_css_default.label,
							children: [
								status === "ready" ? t("ready") : t("starting"),
								" · ",
								endpoint.host,
								":",
								endpoint.port
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("reload"),
							side: "bottom",
							delayMs: 400,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								"aria-label": t("reload"),
								onClick: reload,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, {})
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
							label: t("external"),
							side: "bottom",
							delayMs: 400,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "ghost",
								"aria-label": t("external"),
								onClick: openExternal,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRightUpOutlineRegular, {})
							})
						})
					]
				}), status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("iframe", {
					className: view_module_css_default.frame,
					src: url,
					title: t("title"),
					allow: "clipboard-read; clipboard-write; fullscreen"
				}, revision) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: view_module_css_default.empty,
					role: "status",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: status === "checking" ? t("checking") : t("offline") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: view_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							onClick: reload,
							children: t("retry")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							size: "sm",
							variant: "outline",
							onClick: openBuiltin,
							children: t("builtin")
						})]
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/icons.tsx
		/** Guide artwork: a monitor with a pointer, sized like the built-in plugin artwork. */
		const ComputerArtwork = ({ size = 36, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 36 36",
			fill: "none",
			"aria-hidden": "true",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "6.5",
					y: "8.5",
					width: "23",
					height: "15",
					rx: "2.5",
					stroke: "#5BB98C",
					strokeWidth: "2.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M14 28.5H22M18 23.5V28.5",
					stroke: "#5BB98C",
					strokeWidth: "2.5",
					strokeLinecap: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M16 12.5L21.5 16L18.8 16.6L17.6 19.2L16 12.5Z",
					fill: "#5BB98C"
				})
			]
		});
		/** Sixteen-pixel monitor glyph in the surrounding text color. */
		const MonitorIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: "16",
			height: "16",
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "1.75",
				y: "2.75",
				width: "12.5",
				height: "8.5",
				rx: "1.5",
				stroke: "currentColor",
				strokeWidth: "1.2"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M5.5 13.75H10.5M8 11.25V13.75",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinecap: "round"
			})]
		});
		//#endregion
		//#region src/client/HeaderButton.tsx
		/**
		* One compact button beside the header utilities.
		* @param props - copy and the toggle action.
		* @returns the button.
		*/
		function HeaderButton({ t, toggle }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("toggle"),
				side: "bottom",
				delayMs: 500,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					size: "sm",
					variant: "ghost",
					"aria-label": t("toggle"),
					"data-dsh-computer-toggle": true,
					onClick: toggle,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MonitorIcon, {})
				})
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** Copy for the agent's computer view. */
		const NS = "dshComputer";
		const zh = {
			title: "虚拟机",
			open: "虚拟机",
			description: "查看并操作 agent 的电脑",
			toggle: "虚拟机画面",
			checking: "正在连接虚拟机…",
			offline: "虚拟机还没有就绪（首次启动可能需要几分钟）。",
			retry: "重试",
			reload: "刷新画面",
			external: "在系统浏览器中打开",
			builtin: "用内置浏览器打开",
			ready: "运行中",
			starting: "启动中"
		};
		const en = {
			title: "Computer",
			open: "Computer",
			description: "View and control the agent's computer",
			toggle: "Computer screen",
			checking: "Connecting to the computer…",
			offline: "The computer is not ready yet (the first start can take a few minutes).",
			retry: "Retry",
			reload: "Reload screen",
			external: "Open in system browser",
			builtin: "Open in built-in browser",
			ready: "Running",
			starting: "Starting"
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-computer client: a right-Sidebar tab showing the agent's computer (noVNC)
		* and a Session header button that shows or hides it.
		*/
		/** Services the tab and the header button use. */
		const inject = [
			"slots",
			"locale",
			"sidebarRight",
			"sidebarRightTabs"
		];
		const ID = "dsh-computer";
		const KIND = "dsh-computer";
		function endpoint() {
			let port = 18080;
			try {
				const override = Number(new URLSearchParams(window.location.search).get("dshComputerPort"));
				if (Number.isInteger(override) && override > 0 && override < 65536) port = override;
			} catch {}
			return {
				host: "127.0.0.1",
				port
			};
		}
		/**
		* Register the computer tab type, its body, and the header toggle.
		* @param ctx - Client root Context with slot and sidebar services.
		*/
		function apply(ctx) {
			const c = ctx;
			const t = c.locale.bind(NS);
			const at = endpoint();
			ctx.effect(() => c.locale.register(NS, {
				zh,
				en
			}), "dsh-computer.copy");
			ctx.effect(() => c.sidebarRightTabs.register({
				id: ID,
				kind: KIND,
				priority: "extension",
				keepMounted: true,
				title: () => t("title"),
				guide: [{
					id: "open",
					order: 40,
					title: () => t("open"),
					description: () => t("description"),
					icon: ComputerArtwork
				}]
			}), "dsh-computer.type");
			const Body = (props) => (0, react.createElement)(ComputerView, {
				...props,
				endpoint: at
			});
			ctx.effect(() => c.slots.inject("sidebar.right.pane.tab", () => c.slots.register({
				name: "sidebar.right.pane.tab",
				key: ID,
				locale: NS
			}, Body)), "dsh-computer.body");
			const toggle = () => {
				const sidebar = c.sidebarRight;
				if (sidebar.isExpanded() && sidebar.active()?.kind === KIND) sidebar.toggleExpanded();
				else sidebar.openTab(KIND);
			};
			const Header = (props) => (0, react.createElement)(HeaderButton, {
				t: props.t,
				toggle
			});
			ctx.effect(() => c.slots.inject("conversation.session.header.utilities", () => c.slots.register({
				name: "conversation.session.header.utilities",
				id: ID,
				order: -20,
				locale: NS
			}, Header)), "dsh-computer.header");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map