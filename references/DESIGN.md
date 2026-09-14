# Design notes

## The model: one browser, one tab per session, one shared identity

Three shapes were on the table once the plugin had to serve more than one conversation at a time:

| Approach | Page state | Identity (cookies, logins) | Verdict |
|---|---|---|---|
| One shared page for the whole host (0.1.x) | Shared — two conversations trample each other's page | Shared | Shipped first, then removed: a browser is a *place*, and two sessions working in different places is the normal case |
| One Chrome per session | Isolated | Isolated, unless cookies are transplanted | Rejected: N browsers' worth of memory, and the login-once property dies with it — copying cookies/`storageState` is exactly the fragile thing this plugin exists to avoid |
| **One Chrome, one tab per session** | Isolated per tab | Shared — one profile | **Chosen** |

The plugin's core promise is unchanged and now precise: the session the human creates *is* the session the AI uses, and the isolation that sessions get is **page state**, not identity. Logging in once is the whole point, so the identity is deliberately shared; what a session must not share is the page it is standing on.

Per-tab isolation is only possible because of a measured property of the browser, not by assumption: a target that has been activated once accepts injected input for the rest of its life, even while it is in the background (`references/PITFALLS.md` #11), and each tab gets its own renderer. Without #11's fix, a background session's tab would be deaf and the design would collapse back into "whoever is in front is the only usable session".

## Why every tab is activated once, at creation

Measured (#11): a target created in the background and never activated since the browser started has **no input routing at all** — every `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` returns success (`{}`) and does nothing, with no error on either side, while `Page.captureScreenshot` still returns a live picture and the page reports `visible`. One `Target.activateTarget` repairs it **permanently**, after which a hidden, unfocused tab accepts every input method normally.

So `BrowserManager.ensureSession()` activates the tab the moment it creates it. What that buys is the whole design:

- the AI's tab works while the human is looking at a different session;
- therefore the AI never has to steal the foreground, and a watching human's panel keeps its full-rate stream;
- therefore the hub — not the AI — is the single owner of "which tab is in front".

Honesty about the measurement: the pre-activation drop did not reproduce in *every* context (a background tab reusing an existing renderer accepted input in one run of the suite), so `test/smoke.mjs` only *reports* the pre-activation half and *asserts* the half that must hold unconditionally — after one activation the target accepts input. The activation is cheap, so the plugin takes the safe side.

Related and orthogonal (#12): text insertion is gated on the renderer having a **text-accepting element focused**, not on visibility. That is why every typing path clicks the field first, and why the AI's `browser_panel_type` description says the click is not decoration. Nothing about activation changes this gate.

## Why two picture paths: screencast for the watched tab, polling for the rest

Measured (#13): Chrome only emits `Page.startScreencast` frames for the **active** tab. Over 10 s the active tab produced 34 distinct frames, a hidden tab running a continuously animating page produced **1**, and a never-activated tab produced **0**; two concurrent screencasts did not help (active 34, hidden 0). `Page.captureScreenshot` polling, by contrast, works on hidden *and* never-activated targets at roughly 130–150 ms per capture (~7 fps) with fresh content, and Chrome throttles timers in hidden tabs (~0.6–1 tick/s versus ~3.3), so "let every session keep its own screencast" is not a viable design.

Hence the hub has exactly two paths:

- the session whose panel the human is actually looking at sends `focus`; that session is activated and owns the real `Page.startScreencast` (full frame rate, `everyNthFrame: 1`);
- every other attached session is served by a per-session poller at `pollFrameMs` (default 140 ms ≈ 7 fps), with `optimizeForSpeed: true` — the flag matters: on a backgrounded tab the default capture path measured ~190 ms against ~59 ms with it. Absolute numbers are host-dependent (on the development container the local test page polls in 20–100 ms), and what is being bought is the flag, not the coefficient.

Costs, stated plainly: a polled panel is a still-picture stream, not full motion, and its **first** frame can be cold — seconds — while another tab owns the screencast; the smoke suite budgets for that instead of pretending it is instant. Input latency is untouched by any of this, because both mouse and keyboard events go straight into the panel's own target over the same WebSocket. And a newly attached panel is always seeded with one `Page.captureScreenshot` frame, because a static page emits no frames of its own (#9).

The measured alternative — giving each session its own non-overlapping window, which _does_ stream live while unfocused — needs a virtual screen larger than the window and explicit tiling, and turns every session into a window the human has to find. It is recorded in #13 as the fallback if polled stills ever prove insufficient.

## Why the panel lives in the session page

The canvas must be per session, and that decides the surface: a root-scoped `main` panel has one instance for the whole host and cannot know which conversation is on screen. `conversation.view` is the session-scoped view strip, and a registration there can declare `inject: (sessionId) => ({ sessionId })`, which hands the component exactly the session whose tab it renders. The precedent is `dsh-change-review` (id `review`, order 5); this plugin registers id `browser-panel` at order 40 (`trajectory` is 10). Every session therefore shows a 浏览器 / Browser tab, and each renders its own browser.

The component's mount/unmount lifetime **is** the focus protocol:

- mounting (the human selects the tab) opens the session's WebSocket, sends `focus`, and thereby asks the hub to activate that tab and stream it at full rate;
- unmounting sends `blur` and gives the foreground back to whoever else is watching;
- unmounting **never closes the tab** — the browser belongs to the session, not to the panel. Leaving the tab is not closing the browser, exactly as leaving a conversation does not end it.

The sidebar entry (`sidebar.panellist`) kept its place but changed its body. It is root-scoped, which is precisely right for a host-wide **overview**: one row per session tab (title, URL, last used, a 待接管 badge while that session waits for a person, and 结束并清理 per row). A keyed `main` entry is still required — `ctx.layout.selectPanel(id)` refuses an id without one — so `main` is registered as that overview rather than as a browser canvas. The old central canvas is gone; there is deliberately no "current browser" for the whole host.

## Why the tools carry no session parameter

`browser_panel_*` handlers read the calling session from their execution context (`exec.agent.id`) and resolve their tab from it. Tool names and parameter schemas are unchanged from 0.1.x, so no prompt or habit had to change, and three properties fall out for free:

- the model never has to know that sessions, tabs, or ids exist;
- a session cannot steer another session's tab — there is no parameter through which to ask;
- an agentless dispatch (service-internal, UI, or command paths, where `exec.agent` is absent) is an **error** rather than a silent fallback to a host-wide page, because that fallback would quietly recreate the 0.1.x model.

## Why human take-over is per session

The broker is keyed by session (`sessionId -> pending request`). Two conversations can therefore wait on two different humans simultaneously, a request is broadcast only to the panels of its own session, and the overview still reports every pending request so the sidebar dot can attract attention to a session the human is not currently reading. Cancellation is per session as well: superseded by a newer request, session disposed (`agent/disposed`), browser stopped, or the panel closed.

## Why screencast instead of VNC

The obvious way to show a container browser to a human is a virtual display plus VNC plus a web viewer (Xvfb + x11vnc + noVNC). It works, but it costs a second protocol stack, a second port, a second authentication story, and (on this host) `x11vnc` would not even complete an RFB handshake.

The screencast path gives the same pixels through a channel the plugin already controls:

- one WebSocket on the DSH webserver's own origin, behind the Web UI's own session authentication;
- no second port, no tunnel, no mixed-content problem;
- input is replayed through `Input.dispatch*` into the very CDP target the AI drives — now "the panel's own session's tab", which makes the shared-surface property structural rather than something to keep in sync.

The costs are honest ones: JPEG frames are heavier than a region-based VNC encoding (mitigated by dropping frames above a socket backlog), and file upload/download gestures inside the page are not proxied (the AI can still upload via CDP if it gets a path).

## Why headed on a private Xvfb by default

`--headless=new` is the same Chrome binary with no window, so it renders — but a browser that reports `HeadlessChrome` in its user agent, or that never has a window, is a weaker signal than one that does. `mode: auto` therefore prefers headed-on-Xvfb when `Xvfb` exists (no display hardware required, and on the development container it does) and falls back to headless when it does not. Nothing in the panel cares which one is running.

## Why zero dependencies

A profile plugin is linked into a running host process, and a bare `import` of a package that is not resolvable from the plugin's real path takes the whole plugin tree down with it. The two things needed — CDP over WebSocket and an RFC 6455 server — are a few hundred lines each and have no moving parts worth outsourcing. The result installs without a dependency tree and cannot break because an upstream package changed shape.

## Why the panel is where the human works

`browser_panel_ask_human` deliberately does *not* ask the human to paste a code into the conversation. It opens the panel of the asking session, states the instruction, and waits for a 我已完成 / Done click. The human then does exactly what they would do in any browser — password manager autofill, phone QR scan, SMS code, CAPTCHA — while the AI keeps the page state and continues the moment they finish.

## Deliberate limitations

- **One Chrome per host process.** A browser crash, a stop, or `idleShutdownMinutes` takes every session's tab with it. Sessions are isolated in page state, not in process lifetime; per-session *browsers* were rejected above.
- **Identity is shared by design.** A login performed in one session is a login in every session, and any session's AI can reach any site the shared profile is logged into. That is the feature; it is not a bug, and it is not a security boundary.
- **One viewport per instance**, shared by every tab, so the panel canvas maps 1:1 onto page coordinates with no resize plumbing. The emulated viewport is applied per tab and is deliberately *not* cleared when a stream stops, so coordinates never shift between two sizes mid-mapping (#10).
- **A polled session is ~7 fps**, and its first frame can be cold while another tab owns the screencast.
- **File upload by the human is not proxied** through the canvas; the AI can upload via CDP when it has a path.
- **The panel is not a general remote desktop**: it shows the session's browser tab, nothing else.
- **No shared-browser mode.** 0.2.0 removed it rather than keeping it behind a flag; the plugin had no users yet, and a host-wide page is the wrong default for a multi-session harness.
