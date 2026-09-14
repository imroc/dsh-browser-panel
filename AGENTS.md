# AGENTS.md — instructions for AI agents working in this repository

You are contributing to **dsh-browser-panel**, a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profile bundle: a browser that lives on the DSH host, where **every DSH session owns one tab**, driven by the AI through `browser_panel_*` tools and by the human through the session's panel inside the DSH Web UI.

This file is the project-facing companion to `README.md`: the README explains the plugin to users, this file explains the repository to you.

## Layout

```
lib/index.js        host half: config, wiring, session-tab lifecycle, prompt hint
lib/browser.js      Chrome lifecycle (Xvfb + spawn + CDP) and the sessionId -> tab registry
lib/cdp.js          dependency-free Chrome DevTools Protocol client
lib/ws.js           dependency-free RFC 6455 server (one upgrade route)
lib/screencast.js   per-session stream hub: which tab owns the screencast, pollers for the
                    rest, and input replay into the panel's own session
lib/human.js        the ask-human broker (one pending request per session, timeout, resume)
lib/routes.js       /api/dsh-browser-panel routes (all session-scoped) + the stream upgrade
lib/tools.js        the ten model-facing tools, each bound to its calling session
lib/client.js       browser half: the session view tab + the sidebar overview (no build step)
test/smoke.mjs      36-check standalone core test — no DSH needed
test/human-input.mjs real pointer/keyboard events into the panel canvas, verified in the page
cordis.patch.yml    bundle layer: inserts the plugin row (id: browser-panel)
```

## Development loop

```sh
node test/smoke.mjs        # core: per-session tabs, CDP ops, real input, streams, hand-over
node --check lib/client.js # the client half has no build step; syntax-check it
```

- `test/smoke.mjs` drives a **real Chrome** (found the same way the plugin finds it: `browserPath`, `PATH`, then the Playwright/Puppeteer caches; Xvfb is optional) and needs no DSH. Its 36 checks are the definition of "the per-session model still holds": two sessions get two tabs, the tabs do not steer each other, a click-then-type really lands in the field (the focus gate), panel input reaches **its own** session only, the watched session owns the screencast while the other is served by polled frames, a panel reconnect does not kill the next stream, one activation makes a never-activated target accept input, two sessions can wait on a human at the same time, and a login survives a browser restart.
- **Host half changes need a DSH restart** (`bundle` rows are a boot-time composition change, and Cordis' cascaded loader caches modules — editing a linked plugin's `lib/*.js` does *not* hot-reload). On this machine use `~/dev/agents/dsh-agent/scripts/restart-dsh-web-when-idle.sh` (systemd-run, wait-for-idle, `--wake` yourself).
- **Client half changes only need a page refresh**, but the served bundle carries a `rev` — if the rev does not change, restart the instance.
- A plugin row can be hot-inserted through the *profile patch file* (`~/.dsh/profiles/<profile>/cordis.patch.yml`, `patchReload: live`), which is handy for iterating on a live GUI without a restart. Watch for duplicate rows if the package is also in `dsh.profile.bundles`.

## Invariants (learned the hard way — see `references/PITFALLS.md`)

1. Plugin metadata must be attached to the **default-exported function** (`apply.inject`, `apply.Config`); named exports alone are ignored by the loader.
2. Never read `ctx.<service>` unless it is in `inject`. `ctx.get(name)` returns `undefined` while a service is still mounting, so web surfaces are registered inside `ctx.inject(['webServer', 'connection'], …)`.
3. Tool canonical values must be lossless JSON — no `undefined`, no class instances.
4. Tool names are prefixed `browser_panel_*` because another browser plugin owns `browser_*` and duplicate names abort plugin load.
5. Client slot registration needs the slot to be **declared** first: use `ctx.slots.inject(slot, () => ctx.slots.register(…))`.
6. The panel must never be able to take the GUI down: failures in the client half are logged, never thrown, and the host half keeps working without a webserver (the tools simply lose the visual panel).
7. **Session tabs are the model.** One Chrome per host process, one tab per DSH session, created lazily by `BrowserManager.ensureSession(sessionId)`. There is no shared-page fallback, and 0.2.0 removed the one that existed — do not reintroduce it.
8. Every session tab is **activated once** at creation (#11). A never-activated target silently discards every injected input event for the rest of its life, and the repair is permanent. Do not "optimise" the activation away, and do not gate behaviour on `document.visibilityState` — it is not a predictor of input delivery (typing is gated on renderer focus, #12).
9. Only the **hub** decides which tab is in front, and only because Chrome streams the active tab alone (#13). The AI path must never activate a tab for its own convenience: a session's tab accepts injected input while it is in the background.
10. The panel component's mount/unmount **is** the focus protocol; unmounting hands the foreground back and must never close the tab. A tab belongs to the session, not to the panel.
11. Tools take their session from `exec.agent.id` inside the handler (`sessionOf`). Never add a `sessionId` tool parameter, and never fall back to a host-wide page: a call without an owning session is an error.
12. Every HTTP route and the stream upgrade carry a session id, and every route runs `connection.requestRejection`. A new route without either is a bug.
13. The profile — and therefore the identity — is shared by every session **on purpose**; per-session isolation covers page state only. Do not "fix" cross-session cookie sharing.

## House rules

- Zero runtime dependencies: CDP and the WebSocket server are implemented in-tree. Keep it that way unless there is a very good reason.
- Comments explain *why* (a protocol quirk, a lifecycle trap), not *what*.
- Documentation stays bilingual: `README.md` (English, default) and `README.zh.md`, cross-linked at the top of both, and faithful translations of each other.
- No machine-specific facts (paths, ports, hostnames, credentials) in this repository.

## Knowledge routing

Deeper DSH mechanism notes live in the author's harness knowledge base (`~/dev/agents/dsh-agent/knowledge/`), notably:

- `concepts/` — Cordis composition, slot system, service injection rules;
- `howto/20260914-无GUI容器内浏览器与人类登录.md` — the research that produced this plugin (Xvfb/TigerVNC, CDP screencast, what works without a display);
- `dev/` — plugin development practice (bundle install, restart orchestration, client bundle rules).
