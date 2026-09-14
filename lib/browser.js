/**
 * Browser lifecycle and page operations.
 *
 * One Chrome instance per DSH host process, launched against a persistent
 * `--user-data-dir`, so a human login survives restarts. The AI drives the same
 * instance over CDP that the DSH Web UI's browser panel streams to the human.
 *
 * @module dsh-browser-panel/browser
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Cdp, fetchVersion } from './cdp.js'

/** Folders searched for a Chromium-family binary, in order. */
const PATH_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
]

/** Cache roots of the two Node browser drivers, searched when no system Chrome exists. */
const CACHE_ROOTS = [
  join(homedir(), '.cache', 'ms-playwright'),
  join(homedir(), '.cache', 'puppeteer'),
  join(homedir(), 'Library', 'Caches', 'ms-playwright'),
]

/** Keys understood by {@link BrowserManager#press}. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  EscapeSequence: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
}

/** Sleep helper. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Ask the OS for a currently free TCP port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Resolve a Chromium-family executable: explicit config first, then PATH, then caches. */
export function resolveBrowserPath(configured) {
  if (configured !== undefined && configured !== '') {
    if (!existsSync(configured)) throw new Error(`browser executable not found: ${configured}`)
    return configured
  }
  for (const name of PATH_CANDIDATES) {
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (dir === '') continue
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  for (const root of CACHE_ROOTS) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root).sort().reverse()) {
      if (!entry.startsWith('chromium') && !entry.startsWith('chrome')) continue
      for (const inner of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = join(root, entry, inner)
        if (existsSync(candidate) && !candidate.endsWith('headless_shell')) return candidate
      }
    }
  }
  throw new Error(
    'no Chrome/Chromium binary found — install google-chrome-stable, or set browserPath in the plugin config',
  )
}

/** Whether an XVFB display lock is free. */
function displayAvailable(display) {
  const number = display.replace(/^:/, '').split('.')[0]
  return !existsSync(`/tmp/.X${number}-lock`)
}

/** Find Xvfb on PATH (any directory). */
function resolveXvfb() {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'Xvfb')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Owns the Chrome process, its virtual display, and the attached page session.
 */
export class BrowserManager {
  /**
   * @param options - resolved plugin config plus a logger and a change notifier.
   */
  constructor({ config, logger, onEvent }) {
    this.config = config
    this.logger = logger
    this.onEvent = onEvent ?? (() => {})
    this.cdp = undefined
    this.page = undefined
    this.chrome = undefined
    this.xvfb = undefined
    this.display = undefined
    this.port = undefined
    this.executable = undefined
    this.mode = undefined
    this.startedAt = undefined
    this.lastUsedAt = Date.now()
    this.starting = undefined
    this.stopping = false
    this.idleTimer = undefined
  }

  /** Everything the panel needs to render a status line. */
  async status() {
    if (this.page === undefined) {
      return {
        running: false,
        mode: this.mode ?? null,
        executable: this.executable ?? null,
        profileDir: this.profileDir(),
        url: null,
        title: null,
        viewport: null,
      }
    }
    let url
    let title
    let viewport
    try {
      const info = await this.page.evaluate(
        'JSON.stringify({url: location.href, title: document.title, w: innerWidth, h: innerHeight})',
      )
      const parsed = JSON.parse(info)
      url = parsed.url
      title = parsed.title
      viewport = { width: parsed.w, height: parsed.h }
    } catch {
      /* the page may be navigating; report the shell state only */
    }
    return {
      running: true,
      mode: this.mode ?? null,
      executable: this.executable ?? null,
      profileDir: this.profileDir(),
      port: this.port ?? null,
      display: this.display ?? null,
      startedAt: this.startedAt ?? null,
      url: url ?? null,
      title: title ?? null,
      viewport: viewport ?? null,
    }
  }

  /** Absolute path of the persistent Chrome profile. */
  profileDir() {
    const configured = this.config.profileDir
    if (configured !== undefined && configured !== '') return configured.replace(/^~(?=\/)/, homedir())
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'browser-panel', 'profile')
  }

  /** Start (or reuse) the browser and return the live page session. */
  async ensure() {
    this.lastUsedAt = Date.now()
    if (this.page !== undefined) return this.page
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async start() {
    this.executable = resolveBrowserPath(this.config.browserPath)
    const profileDir = this.profileDir()
    mkdirSync(profileDir, { recursive: true })

    const wanted = this.config.mode ?? 'auto'
    const xvfb = resolveXvfb()
    let mode = 'headless'
    let display = process.env.DISPLAY
    if (wanted === 'auto' || wanted === 'headed') {
      if (display !== undefined && display !== '') {
        mode = 'headed'
      } else if (xvfb !== undefined) {
        const base = Number((this.config.xvfbDisplay ?? ':99').replace(/^:/, '')) || 99
        for (let offset = 0; offset < 12; offset += 1) {
          const candidate = `:${base + offset}`
          if (!displayAvailable(candidate)) continue
          await this.startXvfb(xvfb, candidate)
          display = candidate
          mode = 'headed'
          break
        }
        if (mode !== 'headed' && wanted === 'headed') throw new Error('no free X display for the headed browser')
      } else if (wanted === 'headed') {
        throw new Error('headed mode requested but neither $DISPLAY nor Xvfb is available')
      }
    }

    const port = this.config.port !== undefined && this.config.port > 0 ? this.config.port : await freePort()
    const args = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-features=Translate,OptimizationHints,MediaRouter',
      '--password-store=basic',
      '--use-mock-keychain',
      '--hide-crash-restore-bubble',
      `--window-size=${(this.config.windowSize ?? '1440x900').replace('x', ',')}`,
      '--window-position=0,0',
    ]
    if (mode === 'headless') args.push('--headless=new')
    if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox')
    if (Array.isArray(this.config.extraArgs)) args.push(...this.config.extraArgs)
    args.push(this.config.startUrl ?? 'about:blank')

    const env = { ...process.env }
    if (mode === 'headed' && display !== undefined) env.DISPLAY = display
    this.chrome = spawn(this.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.chrome.stdout.on('data', (chunk) => this.logger?.debug?.(`chrome: ${String(chunk).trim()}`))
    this.chrome.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.debug?.(`chrome: ${text}`)
    })
    this.chrome.on('exit', (code, signal) => {
      this.logger?.info?.(`chrome exited (code=${code} signal=${signal})`)
      this.cdp?.close()
      this.cdp = undefined
      this.page = undefined
      this.chrome = undefined
      this.onEvent({ type: 'browser-stopped' })
    })

    this.port = port
    this.mode = mode
    this.display = mode === 'headed' ? display : undefined

    const version = await fetchVersion(port, this.config.startTimeoutMs ?? 20_000)
    this.cdp = await Cdp.connect(port, { version })
    this.cdp.onClose(() => {
      this.page = undefined
    })
    this.page = await this.cdp.attachAnyPage()
    await this.page.enable()
    this.startedAt = Date.now()
    this.logger?.info?.(`browser ready (mode=${mode} port=${port} profile=${profileDir})`)
    this.scheduleIdleShutdown()
    this.onEvent({ type: 'browser-started' })
    return this.page
  }

  async startXvfb(xvfb, display) {
    const screen = this.config.screen ?? '1440x900x24'
    this.xvfb = spawn(xvfb, [display, '-screen', '0', screen, '-nolisten', 'tcp', '-noreset'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.xvfb.stderr.on('data', (chunk) => this.logger?.debug?.(`xvfb: ${String(chunk).trim()}`))
    this.xvfb.on('exit', () => {
      this.xvfb = undefined
    })
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (existsSync(`/tmp/.X${display.replace(/^:/, '')}-lock`)) {
        await sleep(150)
        return
      }
      await sleep(100)
    }
    this.logger?.warn?.(`xvfb ${display} did not report a lock file; continuing`)
  }

  /** Stop Chrome (and the private Xvfb) and clear the session. */
  async stop({ keepProfile = true } = {}) {
    this.stopping = true
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const page = this.page
    this.page = undefined
    if (page !== undefined) await page.close().catch(() => {})
    if (this.cdp !== undefined) {
      // Ask Chrome to exit gracefully: cookies and storage only flush on a clean
      // shutdown, and a lost flush would log the human out.
      await this.cdp.send('Browser.close', undefined, 3000).catch(() => {})
      this.cdp.close()
      this.cdp = undefined
    }
    if (this.chrome !== undefined) {
      const chrome = this.chrome
      const exited = new Promise((resolve) => chrome.once('exit', resolve))
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 4000)
      await exited.catch(() => {})
      clearTimeout(timer)
      this.chrome = undefined
    }
    if (this.xvfb !== undefined) {
      this.xvfb.kill('SIGTERM')
      this.xvfb = undefined
    }
    if (!keepProfile) {
      const dir = this.profileDir()
      rmSync(dir, { recursive: true, force: true })
    }
    this.stopping = false
    this.startedAt = undefined
    this.onEvent({ type: 'browser-stopped' })
  }

  /** Restart the browser process, keeping the profile (and every login in it). */
  async restart() {
    await this.stop()
    return this.ensure()
  }

  scheduleIdleShutdown() {
    const minutes = this.config.idleShutdownMinutes ?? 0
    clearTimeout(this.idleTimer)
    if (!(minutes > 0)) return
    this.idleTimer = setTimeout(() => {
      const idleFor = Date.now() - this.lastUsedAt
      if (idleFor >= minutes * 60_000) void this.stop()
      else this.scheduleIdleShutdown()
    }, Math.min(minutes * 60_000, 5 * 60_000))
    this.idleTimer.unref?.()
  }

  /** Record activity so the idle timer does not fire mid-use. */
  touch() {
    this.lastUsedAt = Date.now()
    this.scheduleIdleShutdown()
  }

  // ---------------------------------------------------------------- page ops

  /** Evaluate an expression in the shared page and return its value. */
  async evaluate(expression) {
    const page = await this.ensure()
    this.touch()
    return page.evaluate(expression)
  }

  /** Navigate the shared page. */
  async navigate(url, options) {
    const page = await this.ensure()
    this.touch()
    await page.navigate(url, options)
    return this.status()
  }

  async goBack() {
    const page = await this.ensure()
    await page.evaluate('history.back()')
    await sleep(600)
    return this.status()
  }

  async goForward() {
    const page = await this.ensure()
    await page.evaluate('history.forward()')
    await sleep(600)
    return this.status()
  }

  async reload() {
    const page = await this.ensure()
    await page.send('Page.reload')
    await sleep(600)
    return this.status()
  }

  /** Structured page read: text plus a numbered inventory of actionable elements. */
  async snapshot({ maxChars, maxElements } = {}) {
    const page = await this.ensure()
    this.touch()
    const textLimit = maxChars ?? this.config.snapshotMaxChars ?? 4000
    const elementLimit = maxElements ?? this.config.maxElements ?? 80
    const raw = await page.evaluate(`(() => {
      const limit = ${elementLimit};
      const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable="true"],[onclick]';
      for (const stale of document.querySelectorAll('[data-dsh-bp-index]')) stale.removeAttribute('data-dsh-bp-index');
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) return false;
        const style = getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };
      const label = (el) => {
        const raw = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('name') || '';
        return String(raw).replace(/\\s+/g, ' ').trim().slice(0, 100);
      };
      const elements = [...document.querySelectorAll(selector)].filter(visible).slice(0, limit);
      elements.forEach((el, index) => el.setAttribute('data-dsh-bp-index', String(index)));
      return JSON.stringify({
        title: document.title,
        url: location.href,
        text: String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, ${textLimit}),
        elements: elements.map((el, index) => ({
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          label: label(el),
          value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value || '').slice(0, 100) : undefined,
          disabled: el.disabled === true ? true : undefined,
        })),
      });
    })()`)
    return JSON.parse(raw)
  }

  /** Screen-space centre of an indexed element, scrolled into view. */
  async locate(index) {
    const page = await this.ensure()
    const raw = await page.evaluate(`(() => {
      const el = document.querySelector('[data-dsh-bp-index="${index}"]');
      if (!el) return JSON.stringify({ found: false });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        tag: el.tagName.toLowerCase(),
        label: String(el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      });
    })()`)
    const located = JSON.parse(raw)
    if (located.found !== true) throw new Error(`element #${index} is gone — call browser_panel_snapshot again`)
    return located
  }

  /** Click one indexed element with real input events. */
  async click(index) {
    const page = await this.ensure()
    this.touch()
    const located = await this.locate(index)
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: located.x, y: located.y, buttons: 0 })
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await sleep(30)
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(120)
    return located
  }

  /** Click by visible text — a convenience for stable, human-readable targets. */
  async clickText(text) {
    const page = await this.ensure()
    const snapshot = await this.snapshot({ maxChars: 0 })
    const needle = text.trim().toLowerCase()
    const match =
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase() === needle) ??
      snapshot.elements.find((element) => (element.label ?? '').toLowerCase().includes(needle))
    if (match === undefined) throw new Error(`no clickable element matching ${JSON.stringify(text)}`)
    const located = await this.click(match.index)
    return { ...located, index: match.index }
  }

  /** Focus an indexed field and insert text (works with React/Vue controlled inputs). */
  async type(index, text, { submit = false } = {}) {
    const page = await this.ensure()
    this.touch()
    const located = await this.locate(index)
    const base = { x: located.x, y: located.y, button: 'left', clickCount: 1 }
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
    await sleep(60)
    if (text !== undefined && text !== '') await page.send('Input.insertText', { text })
    await sleep(60)
    if (submit) await this.press('Enter')
    return { ...located, submitted: submit === true }
  }

  /** Dispatch one named key press. */
  async press(key) {
    const page = await this.ensure()
    this.touch()
    const spec = KEYS[key]
    if (spec === undefined) throw new Error(`unsupported key ${JSON.stringify(key)}; use one of ${Object.keys(KEYS).join(', ')}`)
    const common = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    }
    await page.send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, text: spec.text })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
    await sleep(80)
    return { key }
  }

  /** Scroll the viewport, either in whole pages or by an explicit delta. */
  async scroll(direction, { pixels } = {}) {
    const page = await this.ensure()
    this.touch()
    const viewport = await page.viewport()
    const step = pixels ?? Math.round(viewport.height * 0.85)
    const deltas = {
      down: { deltaX: 0, deltaY: step },
      up: { deltaX: 0, deltaY: -step },
      left: { deltaX: -step, deltaY: 0 },
      right: { deltaX: step, deltaY: 0 },
      top: { deltaX: 0, deltaY: -1_000_000 },
      bottom: { deltaX: 0, deltaY: 1_000_000 },
    }
    const delta = deltas[direction]
    if (delta === undefined) throw new Error(`unsupported direction ${JSON.stringify(direction)}`)
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(viewport.width / 2),
      y: Math.round(viewport.height / 2),
      ...delta,
    })
    await sleep(350)
    return this.status()
  }

  /** PNG screenshot as raw bytes. */
  async screenshot({ format = 'png', fullPage = false } = {}) {
    const page = await this.ensure()
    this.touch()
    const result = await page.send('Page.captureScreenshot', { format, captureBeyondViewport: fullPage })
    return { data: Buffer.from(result.data, 'base64'), mediaType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }
  }

  /** Current cookies (names and domains only — values are truncated). */
  async cookies() {
    const page = await this.ensure()
    const result = await page.send('Network.getAllCookies')
    return (result.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      session: cookie.session,
    }))
  }

  /** Open a URL in a new tab and make it the shared page the panel shows. */
  async openTab(url) {
    await this.ensure()
    this.touch()
    const previous = this.page
    this.page = await this.cdp.newPage(url)
    await this.page.enable()
    await this.cdp.activate(this.page.targetId)
    if (previous !== undefined) await previous.close().catch(() => {})
    return this.status()
  }
}
