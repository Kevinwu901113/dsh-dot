window.__ModuleLoader__.load({
	id: "@kevinwu901113/dsh-dot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0dsh-css:/home/claude/dsh-rc2/packages/client/dsh-computer-ui/src/client/view.module.css.mjs
		const css = "._7viN-G_root{flex-direction:column;width:100%;height:100%;min-height:0;display:flex;position:relative}._7viN-G_bar{border-bottom:1px solid var(--dsh-color-border,#7f7f7f33);flex:none;align-items:center;gap:6px;padding:4px 8px;font-size:12px;display:flex}._7viN-G_dot{background:#9aa0a6;border-radius:50%;flex:none;width:7px;height:7px}._7viN-G_dotReady{background:#3fb950}._7viN-G_dotStarting{background:#d29922}._7viN-G_label{text-overflow:ellipsis;white-space:nowrap;opacity:.8;flex:1;min-width:0;overflow:hidden}._7viN-G_frame{background:#1e1e1e;border:0;flex:1;width:100%;min-height:0}._7viN-G_empty{text-align:center;opacity:.85;flex-direction:column;flex:1;justify-content:center;align-items:center;gap:12px;padding:24px;font-size:13px;display:flex}._7viN-G_actions{flex-wrap:wrap;justify-content:center;gap:8px;display:flex}._7viN-G_icon{display:inline-flex}";
		const tagId = "@kevinwu901113/dsh-dot/view.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@kevinwu901113/dsh-dot";
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
		* noVNC page relayed by dsh-dot/computer on dsh's own web server (same origin, behind dsh's
		* login); the VNC socket goes through the same relay. The gateway port is never addressed.
		* @param _endpoint - unused; the live view is same-origin.
		* @returns the live view URL.
		*/
		function liveViewUrl(_endpoint) {
			const base = (() => {
				try {
					return window.location.origin;
				} catch {
					return "";
				}
			})();
			return `${base}/dsh-dot/computer/vnc/index.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&path=dsh-dot%2Fcomputer%2Fwebsockify`;
		}
		/**
		* Whether the computer's desktop answers: its status, served by the relay for the signed-in owner.
		* @param _endpoint - unused; the status is same-origin.
		* @param signal - aborts the probe.
		* @returns `true` when the computer's web services are ready.
		*/
		async function probe(_endpoint, signal) {
			const timeout = AbortSignal.timeout(3e3);
			try {
				const res = await fetch("/dsh-dot/computer/status", {
					cache: "no-store",
					credentials: "same-origin",
					signal: AbortSignal.any([signal, timeout])
				});
				if (!res.ok) return false;
				return (await res.json()).state === "ready";
			} catch {
				return false;
			}
		}
		/**
		* The phone's live view page served by dsh-dot/phone.
		* @param endpoint - live view host and port.
		* @returns the page URL.
		*/
		function phoneLiveViewUrl(_endpoint) {
			try {
				return `${window.location.origin}/dsh-dot/phone/`;
			} catch {
				return "/dsh-dot/phone/";
			}
		}
		/**
		* Whether the phone answers (its live view reports `ready`).
		* @param endpoint - live view host and port.
		* @param signal - aborts the probe.
		* @returns `true` when the phone is booted.
		*/
		async function probePhone(endpoint, signal) {
			const timeout = AbortSignal.timeout(3e3);
			try {
				return (await (await fetch(`${phoneLiveViewUrl(endpoint)}status`, {
					cache: "no-store",
					signal: AbortSignal.any([signal, timeout])
				})).json()).ready === true;
			} catch {
				return false;
			}
		}
		/** The dot panel, served by dsh-dot/dot on dsh's own web server (same origin as the client). */
		function panelUrl() {
			try {
				return `${window.location.origin}/dsh-dot/panel/`;
			} catch {
				return "/dsh-dot/panel/";
			}
		}
		/** Whether the panel answers (dsh-dot/dot is loaded and its route is mounted). */
		async function probePanel(_endpoint, signal) {
			const timeout = AbortSignal.timeout(3e3);
			try {
				return (await fetch(`${panelUrl()}api/state`, {
					cache: "no-store",
					signal: AbortSignal.any([signal, timeout])
				})).ok;
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
		function ComputerView({ useTabInfo, t, endpoint, url: urlProp, probe: probeProp }) {
			const { tab } = useTabInfo();
			const [status, setStatus] = (0, react.useState)("checking");
			const [revision, setRevision] = (0, react.useState)(0);
			const url = urlProp ?? liveViewUrl(endpoint);
			const probeFn = probeProp ?? probe;
			const check = (0, react.useCallback)(async (signal) => {
				const ok = await probeFn(endpoint, signal);
				if (!signal.aborted) setStatus(ok ? "ready" : "offline");
			}, [endpoint, probeFn]);
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
								endpoint.port ? ` · ${endpoint.host}:${endpoint.port}` : ""
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
		/** Guide artwork: a phone, in the same style as the monitor. */
		const PhoneArtwork = ({ size = 36, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 36 36",
			fill: "none",
			"aria-hidden": "true",
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "11.5",
					y: "5.5",
					width: "13",
					height: "25",
					rx: "3",
					stroke: "#5BB98C",
					strokeWidth: "2.5"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M16 9.5H20",
					stroke: "#5BB98C",
					strokeWidth: "2.5",
					strokeLinecap: "round"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "18",
					cy: "26",
					r: "1.5",
					fill: "#5BB98C"
				})
			]
		});
		/** Guide artwork: dot herself — a filled dot with a ring, same palette. */
		const DotArtwork = ({ size = 36, className }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: size,
			height: size,
			className,
			viewBox: "0 0 36 36",
			fill: "none",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "18",
				cy: "18",
				r: "11",
				stroke: "#5BB98C",
				strokeWidth: "2.5"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "18",
				cy: "18",
				r: "4",
				fill: "#5BB98C"
			})]
		});
		/** Sixteen-pixel dot glyph in the surrounding text color. */
		const DotIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: "16",
			height: "16",
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "5.25",
				stroke: "currentColor",
				strokeWidth: "1.2"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "8",
				r: "2",
				fill: "currentColor"
			})]
		});
		/** Sixteen-pixel phone glyph in the surrounding text color. */
		const PhoneIcon = () => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
			width: "16",
			height: "16",
			viewBox: "0 0 16 16",
			fill: "none",
			"aria-hidden": "true",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "4.75",
				y: "1.75",
				width: "6.5",
				height: "12.5",
				rx: "1.5",
				stroke: "currentColor",
				strokeWidth: "1.2"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M7 3.75H9",
				stroke: "currentColor",
				strokeWidth: "1.2",
				strokeLinecap: "round"
			})]
		});
		//#endregion
		//#region src/client/HeaderButton.tsx
		/** Session header control that shows or hides the computer tab. */
		/**
		* One compact button beside the header utilities.
		* @param props - copy and the toggle action.
		* @returns the button.
		*/
		function HeaderButton({ t, toggle, icon = MonitorIcon }) {
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
					children: (0, react.createElement)(icon)
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
			starting: "启动中",
			phoneTitle: "手机",
			phoneOpen: "手机",
			phoneDescription: "查看并操作 agent 的手机",
			phoneToggle: "手机画面",
			phoneChecking: "正在连接手机…",
			phoneOffline: "手机还没有就绪（第一次要先在对话里发 /phone accept，下载约 2 GB）。",
			dotTitle: "dot",
			dotOpen: "dot",
			dotDescription: "她现在在干什么、今天做了什么、记得什么",
			dotToggle: "dot 面板",
			dotChecking: "正在连接 dot…",
			dotOffline: "dot 还没有加载（dsh-dot/dot 组件未启用，或 dsh 还在启动）。",
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
			starting: "Starting",
			phoneTitle: "Phone",
			phoneOpen: "Phone",
			phoneDescription: "View and control the agent's phone",
			phoneToggle: "Phone screen",
			phoneChecking: "Connecting to the phone…",
			phoneOffline: "The phone is not ready yet (first time: send /phone accept in a chat; it downloads about 2 GB).",
			dotTitle: "dot",
			dotOpen: "dot",
			dotDescription: "What she is doing now, today, and what she remembers",
			dotToggle: "dot panel",
			dotChecking: "Connecting to dot…",
			dotOffline: "dot is not loaded (the dsh-dot/dot component is off, or dsh is still starting).",
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
		const PHONE_ID = "dsh-phone";
		const PHONE_KIND = "dsh-phone";
		const DOT_ID = "dsh-dot-panel";
		const DOT_KIND = "dsh-dot-panel";
		function endpoint() {
			return {
				host: "127.0.0.1",
				port: 0
			};
		}
		function phoneEndpoint() {
			let port = 18090;
			try {
				const override = Number(new URLSearchParams(window.location.search).get("dshPhonePort"));
				if (Number.isInteger(override) && override > 0 && override < 65536) port = override;
			} catch {}
			return {
				host: "127.0.0.1",
				port
			};
		}
		/** Copy accessor for the phone tab: phone-specific keys first, shared status keys as they are. */
		const phoneCopy = (t) => (key) => {
			return t({
				title: "phoneTitle",
				open: "phoneOpen",
				description: "phoneDescription",
				toggle: "phoneToggle",
				checking: "phoneChecking",
				offline: "phoneOffline"
			}[key] ?? key);
		};
		/** Copy accessor for the dot panel tab. */
		const dotCopy = (t) => (key) => {
			const own = {
				title: "dotTitle",
				open: "dotOpen",
				description: "dotDescription",
				toggle: "dotToggle",
				checking: "dotChecking",
				offline: "dotOffline"
			};
			return t(own[key] ?? key);
		};
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
			const tp = phoneCopy(t);
			const phoneAt = {
				host: "",
				port: 0
			};
			ctx.effect(() => c.sidebarRightTabs.register({
				id: PHONE_ID,
				kind: PHONE_KIND,
				priority: "extension",
				keepMounted: true,
				title: () => tp("title"),
				guide: [{
					id: "open",
					order: 41,
					title: () => tp("open"),
					description: () => tp("description"),
					icon: PhoneArtwork
				}]
			}), "dsh-phone.type");
			const PhoneBody = (props) => (0, react.createElement)(ComputerView, {
				...props,
				t: tp,
				endpoint: phoneAt,
				url: phoneLiveViewUrl(phoneAt),
				probe: probePhone
			});
			ctx.effect(() => c.slots.inject("sidebar.right.pane.tab", () => c.slots.register({
				name: "sidebar.right.pane.tab",
				key: PHONE_ID,
				locale: NS
			}, PhoneBody)), "dsh-phone.body");
			const togglePhone = () => {
				const sidebar = c.sidebarRight;
				if (sidebar.isExpanded() && sidebar.active()?.kind === PHONE_KIND) sidebar.toggleExpanded();
				else sidebar.openTab(PHONE_KIND);
			};
			const PhoneHeader = (props) => (0, react.createElement)(HeaderButton, {
				t: phoneCopy(props.t),
				toggle: togglePhone,
				icon: PhoneIcon
			});
			ctx.effect(() => c.slots.inject("conversation.session.header.utilities", () => c.slots.register({
				name: "conversation.session.header.utilities",
				id: PHONE_ID,
				order: -19,
				locale: NS
			}, PhoneHeader)), "dsh-phone.header");
			const td = dotCopy(t);
			const panelAt = {
				host: "",
				port: 0
			};
			ctx.effect(() => c.sidebarRightTabs.register({
				id: DOT_ID,
				kind: DOT_KIND,
				priority: "extension",
				keepMounted: true,
				title: () => td("title"),
				guide: [{
					id: "open",
					order: 42,
					title: () => td("open"),
					description: () => td("description"),
					icon: DotArtwork
				}]
			}), "dsh-dot-panel.type");
			const DotBody = (props) => (0, react.createElement)(ComputerView, {
				...props,
				t: td,
				endpoint: panelAt,
				url: panelUrl(),
				probe: probePanel
			});
			ctx.effect(() => c.slots.inject("sidebar.right.pane.tab", () => c.slots.register({
				name: "sidebar.right.pane.tab",
				key: DOT_ID,
				locale: NS
			}, DotBody)), "dsh-dot-panel.body");
			const toggleDot = () => {
				const sidebar = c.sidebarRight;
				if (sidebar.isExpanded() && sidebar.active()?.kind === DOT_KIND) sidebar.toggleExpanded();
				else sidebar.openTab(DOT_KIND);
			};
			const DotHeader = (props) => (0, react.createElement)(HeaderButton, {
				t: dotCopy(props.t),
				toggle: toggleDot,
				icon: DotIcon
			});
			ctx.effect(() => c.slots.inject("conversation.session.header.utilities", () => c.slots.register({
				name: "conversation.session.header.utilities",
				id: DOT_ID,
				order: -18,
				locale: NS
			}, DotHeader)), "dsh-dot-panel.header");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map