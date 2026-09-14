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

Two mapping bugs shipped in the same fix: pointer coordinates now map through the canvas' **intrinsic size** (so they stay correct even when the emulated viewport changes underneath the panel), and stopping the stream no longer clears the device-metrics override (which used to flip the page between 1439×756 and 1440×900 on every reconnect).

## 11. Chrome silently drops injected input in a background tab

**Symptom**: the panel shows a live page, and every `Input.dispatchMouseEvent` / `Input.insertText` call through CDP returns success — but no click lands and no character appears. Nothing is logged, on either side.

**Cause**: Chrome discards CDP-injected input for a page that is not the active tab. The shared page loses the foreground whenever anything else takes it — a stray tab left behind in the persistent profile, or a page that opened one itself (`window.open`, `target="_blank"`). The panel streams the *background* page quite happily, and a background page looks exactly like a working one in a JPEG.

**Fix**: own the foreground, and take it back when it is lost:

- `Target.activateTarget` on the attached page right after launch;
- expose `hidden` (`document.visibilityState === 'hidden'`) on the status object;
- on the 2.5s state poll, if the page reports `hidden`, call `ensureActive()` again — self-healing matters because the thief is often the page itself;
- regression test: steal the foreground with another tab and assert the shared page returns to visible.

**Generalization**: for any "the human sees a live page but the injected input vanishes" report, check `document.visibilityState` *first* — before suspecting coordinates, event synthesis, or the frontend. The CDP calls will keep reporting success either way.
