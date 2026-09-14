# Pitfalls hit while building this plugin

Every entry is a real failure observed while developing `dsh-browser-panel` against DSH `0.1.5-rc.2`. They are written down because each one presents as something else entirely.

## 1. Plugin metadata on the wrong export

**Symptom**: the plugin mounts, but every `ctx.tools.register(...)` throws `cannot get property "tools" without inject`, and boot fails with `plugin tree failed to load`.

**Cause**: the module exported `inject` / `Config` as *named* exports and a bare `export default apply`. The loader reads metadata from the default-exported function.

**Fix**:

```js
export const inject = ['tools']
export const Config = z.object({ … })
export function apply(ctx, config) { … }

apply.inject = inject      // ← the loader reads these two
apply.Config = Config
export default apply
```

## 2. `ctx.get()` at apply time misses services that mount later

**Symptom**: the WebSocket route answers `404` (the shared `/api` handler), the HTTP route answers `400` (the webserver's catch-all for a throwing handler), and the plugin's own log line never appears.

**Cause**: `const webServer = ctx.get('webServer')` ran before the webserver service existed, so `webServer === undefined` and the routes were silently skipped.

**Fix**: wait for declarations with dynamic injection — the pattern the shipped API gateway uses:

```js
ctx.inject(['webServer', 'connection'], (webCtx) => {
  webCtx.effect(() => webCtx.webServer.register(route), 'label')
})
```

## 3. Reaching a service through the context proxy

**Symptom**: an HTTP route answers `400` with an empty body (the webserver turns handler errors into `400`), and nothing is logged anywhere useful.

**Cause**: the handler called `ctx.connection.requestRejection(req)` while `connection` was not in the plugin's `inject` list. Cordis throws on property access.

**Fix**: keep web services optional and pass the *service object* into route factories instead of the context.

## 4. Tool outputs that are not lossless JSON

**Symptom**: a tool call fails with a serialization error while its body clearly returned an object.

**Cause**: `{ running: false, mode: undefined, … }` — `undefined` has no JSON representation, and the tool registry validates the canonical value before rendering.

**Fix**: run every canonical return through a `JSON.parse(JSON.stringify(value ?? null))` cleaner, and prefer `null` over absent fields in status objects.

## 5. Slot registration before the slot is declared

**Symptom**: the client half runs (its `<style>` tag is in the DOM) but no sidebar entry appears. Console: `slot "sidebar.panellist" is not declared (a parent entry's children table must declare it)`.

**Cause**: `ctx.slots.register({ name: 'sidebar.panellist', … })` executed before the sidebar plugin declared that slot.

**Fix**:

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, label }, Icon))
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id }, Panel))
```

## 6. Module caching makes "hot reload" a lie for host code

**Symptom**: after editing a linked plugin's host file and letting the profile patch reload, behaviour does not change.

**Cause**: Cordis' cascaded loader caches module jobs; re-adding the row re-applies the plugin but not necessarily a fresh module evaluation.

**Consequence**: treat host changes as restart-requiring; treat client changes as page-refresh-requiring (and watch the served `rev`).

## 7. `ws` frames vs. a stalled reader

**Symptom**: after leaving the panel open on a busy page, frames lag by seconds.

**Cause**: queueing every JPEG frame for a slow reader.

**Fix**: the hub drops frames above a 3 MiB socket backlog instead of buffering, and always acknowledges the frame to Chrome so the screencast keeps flowing.

## 8. Killing Chrome loses the login

**Symptom**: the human logs in, the host restarts the browser, and the session is gone.

**Cause**: cookies flush on graceful shutdown; a hard kill loses the write.

**Fix**: `Browser.close` over CDP first, then wait for the process to exit, and only then `SIGKILL` as a fallback.

## 9. Repainting a static page

**Symptom**: a freshly opened panel shows a blank canvas although the browser is running.

**Cause**: `Page.startScreencast` only emits frames when the page changes.

**Fix**: seed a fresh `Page.captureScreenshot` frame on connect (and on an explicit `play` request from the toolbar).

## 10. An informational overlay that keeps eating every click

**Symptom**: the page streams in the panel and looks completely alive, but clicking an input does nothing — no console error, no failed request, nothing. Reported as "I can see the login form but I cannot click it".

**Cause**: two client-side bugs compounding. The overlay that reports `starting` / `stopped` / `empty` (`.dbp-overlay`) had no `pointer-events: none`, so it stayed a full-canvas click target sitting on top of the page; and the flag meant to unmount it once frames arrive lived in a **ref**, and a ref does not re-render — so the overlay stayed mounted forever, transparent-looking but click-blocking.

**Fix**: make every overlay click-through, and keep the first-frame gate in React state:

```js
// style — the overlay must never intercept the pointer
.dbp-overlay { … ; pointer-events: none }

// component — a ref does not re-render, so the overlay never unmounted
const [hasFrame, setHasFrame] = useState(false)
// … in the frame painter: setHasFrame(true)
// … render gate: !hasFrame && connection === 'connected' ? overlay : null
```

**How to find it next time**: in the GUI page, evaluate `document.elementFromPoint(x, y)` at the point you clicked. It names the element actually swallowing the event, which is rarely the one you suspected.

**It is the head of a chain, not a standalone bug.** A swallowed click means nothing gains focus, and the *next* `Input.insertText` then dies silently in the focus gate (#12) — with success-shaped responses all the way down. That chain reproduces the original report verbatim ("I can see the login form but I cannot click it"), and it was reproduced on the production binary with a screenshot to prove it.

Two mapping bugs shipped in the same fix: pointer coordinates now map through the canvas' **intrinsic size** (so they stay correct even when the emulated viewport changes underneath the panel), and stopping the stream no longer clears the device-metrics override (which used to flip the page between 1439×756 and 1440×900 on every reconnect). A stale frame is still dangerous on its own: coordinates read off a frozen picture missed by ~144 px once the page had scrolled underneath (#13).

## 11. A tab that was never activated silently discards *all* injected input

> **Corrected 2026-09-14.** This entry previously claimed *"Chrome silently drops CDP-injected input in a background tab"*. A controlled experiment on the exact production binary (`chromium-1243` = Chrome for Testing 153.0.8010.12, Xvfb, no window manager) could **not** reproduce that claim, and this repo's own regression test only ever asserted that `visibilityState` returns to `visible` — it never asserted that input was lost. The claim was never true as written. What *was* measured is narrower, and is below.

**Symptom**: every `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` against a target returns success (`{}`) and nothing happens — no click, no character, no focus change, no error, on either side.

**Cause**: a target created in the background (`Target.createTarget { background: true }`) and **never activated since the browser started** has no input routing at all. Every `Input.*` call is a silent no-op, *regardless of `document.visibilityState`* — and such a page typically reports `visible`, because without a window manager Chrome's visibility signal does not come from X mapping. `Page.startScreencast` yields **zero** frames for it, while `Page.captureScreenshot` still returns a live, correct picture — so a panel can look perfectly alive while the target is deaf.

**Fix**: activate each target **once**, right after creating or attaching it (`Target.activateTarget` / `Page.bringToFront`). The repair is **permanent**: afterwards a hidden tab (`visibilityState=hidden`, `hasFocus=false`) accepts every input method normally. Do **not** poll `visibilityState` to decide whether input will land — it is not a predictor (see #12 for what actually gates typing).

**Latent, not established**: the production plugin was never observed creating background tabs (it attaches to a page and activates it at launch), so this was a trap waiting to be stepped on rather than the cause of a shipped failure.

## 12. Text insertion is gated on renderer *focus*, not on visibility

**Symptom**: `Input.insertText` returns `{}` and the field stays empty — while `Input.dispatchKeyEvent` still delivers `keydown` to the document but types nothing. Clicking a `<button>` also leaves `document.activeElement === body` on this build.

**Cause**: `Input.insertText` is a silent no-op unless the target's renderer has a **text-accepting element focused**. This is orthogonal to visibility — measured: it drops on a *visible, focused* tab and lands on a *hidden* one.

**Fix**: click the field first (`Input.dispatchMouseEvent`), then type. And watch for the trap that makes this so hard to read: after a click that was swallowed by something else (#10) the page still flips `document.hasFocus()` to `true`, so every "obvious" focus check reports that all is well.

## 13. `Page.startScreencast` only streams the **active** tab

**Symptom**: with more than one target driven, most panels show a frozen picture (or a single stale frame) while one of them updates at full rate.

**Cause**: measured on the production binary — over 10 s the active tab produced 34 distinct frames, a hidden tab running a continuously animating page produced **1**, and a never-activated tab produced **0**. Concurrent screencasts do not help: active 34, hidden 0.

**Measured alternatives** (same run):

- **Polled `Page.captureScreenshot` works on hidden *and* never-activated targets**, at ~130–150 ms per capture (~7 fps), and the content stays fresh. This plugin already uses that call to seed a frame; a per-target poll can serve any number of panels without caring which tab is active. (CPU cost was not measured.)
- **Separate, non-overlapping windows stream live even when unfocused** (27 + 27 frames / 8 s side by side on a 2880×900 screen); a fully covered window freezes and recovers when uncovered. This needs a virtual screen larger than the window and explicit non-overlapping placement.

**Consequence for per-session designs**: "one Chrome, one tab per session, one live screencast per session" is **not viable**. Either activate the tab whose panel is actually being watched, or poll `captureScreenshot` per panel, or give each session its own window (tiled) or its own browser process.

Also measured: hidden tabs throttle `setInterval` to roughly 0.6–1 tick/s versus ~3.3 on the active tab, so anything on a shared page that depends on fast timers behaves differently once it is not the visible tab.
