/**
 * dsh-browser-panel — host half.
 *
 * Owns one Chrome instance for the whole DSH host, exposes it to the AI as
 * `browser_panel_*` tools, and streams it into the DSH Web UI so the human can
 * watch and take over on the same page. Because the browser lives in the host,
 * it works on a machine with no display at all, and every login the human
 * performs stays in the persistent profile.
 *
 * @module dsh-browser-panel
 */

import z from '@deepseek-ai/schemastery'
import { BrowserManager } from './browser.js'
import { HumanBroker } from './human.js'
import { ScreencastHub } from './screencast.js'
import { BASE_PATH, makeRoutes, makeUpgradeRoute } from './routes.js'
import { defineTools } from './tools.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-panel'

/** Hard dependency: the tool registry. Web services are resolved optionally. */
export const inject = ['tools']

/** Version reported by the panel header and the health route. */
export const VERSION = '0.1.0'

/** Plugin configuration, overridable per row in `cordis.patch.yml`. */
export const Config = z.object({
  /** Explicit Chrome/Chromium path; empty means auto-detect. */
  browserPath: z.string().default(''),
  /** Persistent Chrome profile directory; empty means `$DSH_HOME/browser-panel/profile`. */
  profileDir: z.string().default(''),
  /** auto = headed on a private Xvfb when available, otherwise headless. */
  mode: z.union([z.const('auto'), z.const('headed'), z.const('headless')]).default('auto'),
  /** Virtual display geometry for the private Xvfb (WxHxD). */
  screen: z.string().default('1440x900x24'),
  /** Chrome window size, used in headed mode. */
  windowSize: z.string().default('1440x900'),
  /** Emulated page viewport, also the panel canvas coordinate space. */
  viewport: z.string().default('1440x900'),
  /** Preferred X display number for the private Xvfb. */
  xvfbDisplay: z.string().default(':99'),
  /** Fixed DevTools port; 0 picks a free one. */
  port: z.number().default(0),
  /** First URL of a fresh browser. */
  startUrl: z.string().default('about:blank'),
  /** Extra Chrome command-line switches. */
  extraArgs: z.array(z.string()).default([]),
  /** Characters of page text returned by browser_panel_snapshot. */
  snapshotMaxChars: z.number().default(4000),
  /** Maximum interactive elements listed per snapshot. */
  maxElements: z.number().default(80),
  /** JPEG quality of the screencast stream (1-100). */
  screencastQuality: z.number().default(60),
  /** Maximum streamed frame width. */
  screencastMaxWidth: z.number().default(1440),
  /** Default budget of browser_panel_ask_human, in seconds. */
  askHumanTimeoutSeconds: z.number().default(600),
  /** Stop the browser after this many idle minutes; 0 keeps it running. */
  idleShutdownMinutes: z.number().default(0),
  /** Start the browser together with the host, without waiting for a first call. */
  autoStart: z.boolean().default(false),
  /** How long to wait for the DevTools endpoint after launching Chrome. */
  startTimeoutMs: z.number().default(20_000),
})

/** Parse `1440x900` into a viewport pair. */
function parseViewport(value) {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(String(value ?? '').trim())
  if (match === null) return { width: 1440, height: 900 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

/**
 * Mount the host half: browser lifecycle, panel routes, tools, prompt hint.
 *
 * @param ctx - host context carrying webserver, connection and tool services.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const log = (level, message) => {
    const line = `browser-panel: ${message}`
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger[level] === 'function') {
        logger[level](line)
        return
      }
    } catch {
      /* an unavailable logger service falls through to the console */
    }
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line)
  }
  const logger = {
    info: (message) => log('info', message),
    warn: (message) => log('warn', message),
    error: (message) => log('error', message),
    debug: (message) => log('debug', message),
  }

  const viewport = parseViewport(settings.viewport ?? settings.windowSize)

  /** Declared before the broker so request events can reach connected panels. */
  let hub
  const human = new HumanBroker({
    onEvent: (event) => {
      if (hub === undefined) return
      if (event.type === 'human-request') hub.broadcast({ type: 'human-request', request: event.request })
      else if (event.type === 'human-done') hub.broadcast({ type: 'human-done', id: event.id })
      else if (event.type === 'human-timeout') hub.broadcast({ type: 'human-timeout', id: event.id })
    },
  })

  const manager = new BrowserManager({
    config: settings,
    logger,
    onEvent: (event) => {
      if (hub === undefined) return
      if (event.type === 'browser-stopped') hub.broadcast({ type: 'browser-stopped' })
      void hub.pushState({ force: true })
    },
  })

  hub = new ScreencastHub({
    manager,
    logger,
    human,
    viewport,
    quality: Math.min(100, Math.max(10, settings.screencastQuality ?? 60)),
    maxWidth: settings.screencastMaxWidth ?? viewport.width,
    maxHeight: viewport.height,
  })

  // Panel surfaces need the host webserver plus the GUI's own request guard.
  // Deployments without a Web UI (a headless CLI profile, the TUI) still get the
  // tools — they simply have no panel to mirror into.
  // `ctx.get` can miss a service that has not mounted yet, and the panel must
  // survive composition order, so the web surfaces wait for both services with
  // `ctx.inject` (the same pattern the shipped API gateway uses).
  let panelAvailable = false
  logger.info(`apply() entered (inject: tools=${ctx.get('tools') !== undefined})`)
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    panelAvailable = true
    for (const route of makeRoutes({ connection: webCtx.connection, manager, human, hub, version: VERSION })) {
      webCtx.effect(() => webCtx.webServer.register(route), `browser-panel: ${route.path}`)
    }
    const upgrade = makeUpgradeRoute({ connection: webCtx.connection, hub })
    webCtx.effect(() => webCtx.webServer.registerUpgrade(upgrade), `browser-panel: ${upgrade.path}`)
    logger.info(`panel surfaces mounted on ${BASE_PATH}/* (stream: ${upgrade.path})`)
  })
  const mountWatchdog = setTimeout(() => {
    if (!panelAvailable) {
      logger.warn('webServer/connection never became available — tools run without the visual panel')
    }
  }, 8000)
  mountWatchdog.unref?.()
  ctx.effect(() => () => clearTimeout(mountWatchdog), 'browser-panel: mount watchdog')

  // Tools: the model's control surface over the same browser.
  // Resolved per call: optional services may mount after this plugin.
  const getAttachments = () => ctx.get('attachments')
  ctx.effect(() => {
    const disposers = defineTools({
      manager,
      human,
      hub,
      config: settings,
      getAttachments,
      logger,
      getPanelAvailable: () => panelAvailable,
    }).map((tool) =>
      ctx.tools.register(tool),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'browser-panel: tools')

  // Browser teardown belongs to this plugin's fiber: unloading must not leak Chrome.
  ctx.effect(
    () => () => {
      human.cancel('plugin unloading')
      void hub.close()
      void manager.stop()
    },
    'browser-panel: browser lifetime',
  )

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'tool:browser-panel',
          order: 109,
          text:
            'A shared browser panel is available in the DSH Web UI (tools prefixed browser_panel_). '
            + 'The human can see and operate the very same browser from that panel, so when a step needs a person '
            + '(credentials, QR code, SMS/2FA code, CAPTCHA, SSO), call browser_panel_ask_human with a clear instruction '
            + 'instead of guessing. Logins persist in the browser profile, so later calls start authenticated.',
        }),
      'browser-panel: system prompt section',
    )
  })

  if (settings.autoStart === true) {
    void manager.ensure().catch((error) => logger.warn(`autoStart failed: ${error.message}`))
  }

  logger.info(`mounted (routes ${BASE_PATH}/*, viewport ${viewport.width}x${viewport.height}, assets from ${manager.profileDir()})`)
}

// The loader reads plugin metadata from the default-exported function, so the
// declarations above are attached to it explicitly: a bare `export default
// apply` would lose `inject` and every `ctx.tools` access would throw.
apply.inject = inject
apply.Config = Config

export default apply
