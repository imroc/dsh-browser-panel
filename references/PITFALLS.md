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
