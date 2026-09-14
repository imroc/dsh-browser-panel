# Design notes

## Why one browser with two control planes

The requirement is "the AI works in a browser, and a human can log in for it". Three architectures were considered:

| Approach | Human login | Needs the human's machine | Verdict |
|---|---|---|---|
| Drive the human's own browser (extension bridge) | Perfect — it is their browser | Yes: extension installed, browser open | Great when the human sits at their machine; useless for unattended hosts |
| Copy cookies / `storageState` into a headless browser | Not solved — the login still has to happen somewhere | Yes, once | Breaks on device-bound credentials, fingerprints, WebAuthn |
| **One host browser, two control planes** | Full: the human acts in the real page | No: any device that can open the DSH Web UI | **Chosen** |

The decisive property is that the session the human creates *is* the session the AI uses — not a copy of it. Nothing has to be transferred, so nothing can fail to transfer.

## Why screencast instead of VNC

The obvious way to show a container browser to a human is a virtual display plus VNC plus a web viewer (Xvfb + x11vnc + noVNC). It works, but it costs a second protocol stack, a second port, a second authentication story, and (on this host) `x11vnc` would not even complete an RFB handshake.

`Page.startScreencast` gives the same pixels through a channel the plugin already controls:

- one WebSocket on the DSH webserver's own origin, behind the Web UI's own session authentication;
- no second port, no tunnel, no mixed-content problem;
- input is replayed through `Input.dispatch*` into the *same* CDP session the AI uses, so the shared-tab property is structural rather than something to keep in sync.

The costs are honest ones: JPEG frames are heavier than a region-based VNC encoding (mitigated by dropping frames above a socket backlog), and file upload/download gestures inside the page are not proxied (the AI can still upload via CDP if it gets a path).

## Why headed on a private Xvfb by default

`--headless=new` is the same Chrome binary with no window, so it renders — but a browser that reports `HeadlessChrome` in its user agent, or that never has a window, is a weaker signal than one that does. `mode: auto` therefore prefers headed-on-Xvfb when `Xvfb` exists (no display hardware required, and on the development container it does) and falls back to headless when it does not. Nothing in the panel cares which one is running.

## Why zero dependencies

A profile plugin is linked into a running host process, and a bare `import` of a package that is not resolvable from the plugin's real path takes the whole plugin tree down with it. The two things needed — CDP over WebSocket and an RFC 6455 server — are a few hundred lines each and have no moving parts worth outsourcing. The result installs without a dependency tree and cannot break because an upstream package changed shape.

## Why the panel is where the human works

`browser_panel_ask_human` deliberately does *not* ask the human to paste a code into the conversation. It opens the panel, states the instruction, and waits for a 我已完成 / Done click. The human then does exactly what they would do in any browser — password manager autofill, phone QR scan, SMS code, CAPTCHA — while the AI keeps the page state and continues the moment they finish.

## Deliberate limitations

- The emulated viewport is fixed per instance (`viewport`), so the panel canvas maps 1:1 onto page coordinates without resize plumbing.
- One shared browser per host process, not per session: a login is worth sharing, and concurrent sessions would otherwise each pay for a Chrome.
- File upload by the human is not proxied through the canvas; the AI can upload via CDP when it has a path.
- The panel is not a general remote-desktop: it shows browser tabs, nothing else.
