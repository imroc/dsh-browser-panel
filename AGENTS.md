# AGENTS.md — instructions for AI agents working in this repository

You are contributing to **dsh-browser-panel**, a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) profile bundle: a browser that lives on the DSH host, driven by the AI through `browser_panel_*` tools and by the human through a live panel inside the DSH Web UI.

This file is the project-facing companion to `README.md`: the README explains the plugin to users, this file explains the repository to you.

## Layout

```
lib/index.js        host half: config, wiring, service injection, prompt hint
lib/browser.js      Chrome lifecycle (Xvfb + spawn + CDP) and page operations
lib/cdp.js          dependency-free Chrome DevTools Protocol client
lib/ws.js           dependency-free RFC 6455 server (one upgrade route)
lib/screencast.js   screencast fan-out + human input replay
lib/human.js        the ask-human broker (one pending request, timeout, resume)
lib/routes.js       /api/dsh-browser-panel routes + the stream upgrade route
lib/tools.js        the ten model-facing tools
lib/client.js       browser half: sidebar entry + canvas panel (no build step)
test/smoke.mjs      standalone core test — no DSH needed
test/gui-check.sh   headless-GUI check for a running instance
test/human-input.mjs real pointer/keyboard events into the panel, verified in the page
cordis.patch.yml    bundle layer: inserts the plugin row (id: browser-panel)
```

## Development loop

```sh
node test/smoke.mjs        # core: browser lifecycle, CDP ops, WS frames, input, hand-over
node --check lib/client.js # the client half has no build step; syntax-check it
```

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

## House rules

- Zero runtime dependencies: CDP and the WebSocket server are implemented in-tree. Keep it that way unless there is a very good reason.
- Comments explain *why* (a protocol quirk, a lifecycle trap), not *what*.
- Documentation stays bilingual: `README.md` (English, default) and `README.zh.md`, cross-linked at the top of both.
- No machine-specific facts (paths, ports, hostnames, credentials) in this repository.

## Knowledge routing

Deeper DSH mechanism notes live in the author's harness knowledge base (`~/dev/agents/dsh-agent/knowledge/`), notably:

- `concepts/` — Cordis composition, slot system, service injection rules;
- `howto/20260914-无GUI容器内浏览器与人类登录.md` — the research that produced this plugin (Xvfb/TigerVNC, CDP screencast, what works without a display);
- `dev/` — plugin development practice (bundle install, restart orchestration, client bundle rules).
