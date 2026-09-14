/**
 * The panel's live channel: Chrome screencast frames out, human input in.
 *
 * One screencast loop per browser page is fanned out to every connected panel;
 * input messages are replayed into the same CDP session the AI uses, which is
 * what makes the browser genuinely shared rather than merely mirrored.
 *
 * @module dsh-browser-panel/screencast
 */

import { sleep } from './browser.js'

/** Drop frames (rather than queue them) once a socket is this far behind. */
const MAX_BUFFERED_BYTES = 3 * 1024 * 1024

/** How often the panel is told about URL/title changes. */
const STATE_POLL_MS = 2500

/** CDP modifier bitmask values. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

/** Translate the panel's modifier list into the CDP bitmask. */
function modifierMask(list) {
  if (!Array.isArray(list)) return 0
  let mask = 0
  for (const name of list) mask |= MODIFIERS[name] ?? 0
  return mask
}

/**
 * Bridges one page session to any number of panel connections.
 */
export class ScreencastHub {
  /**
   * @param options - browser manager, logger, metrics config, human broker.
   */
  constructor({ manager, logger, viewport, quality, maxWidth, maxHeight, human }) {
    this.manager = manager
    this.logger = logger
    this.viewport = viewport
    this.quality = quality
    this.maxWidth = maxWidth
    this.maxHeight = maxHeight
    this.human = human
    this.connections = new Set()
    this.streaming = false
    this.page = undefined
    this.detach = []
    this.stateTimer = undefined
    this.lastState = undefined
    this.lastFrame = undefined
    this.framesDropped = 0
  }

  /** Send one control message to every open panel. */
  broadcast(message) {
    for (const connection of this.connections) connection.sendJson(message)
  }

  /** Broadcast a fresh URL/title pair when it changed. */
  async pushState({ force = false } = {}) {
    const status = await this.manager.status().catch(() => undefined)
    if (status === undefined) return
    const next = { url: status.url, title: status.title, running: status.running, viewport: status.viewport }
    const changed =
      force ||
      this.lastState === undefined ||
      this.lastState.url !== next.url ||
      this.lastState.title !== next.title ||
      this.lastState.running !== next.running
    this.lastState = next
    if (changed) this.broadcast({ type: 'state', ...next, human: this.human.snapshot() })
  }

  /** Accept a panel connection and start streaming when it is the first one. */
  async attach(connection) {
    this.connections.add(connection)
    connection.on('close', () => {
      this.connections.delete(connection)
      if (this.connections.size === 0) void this.stopStreaming()
    })
    connection.on('message', (message) => {
      if (message.type !== 'text') return
      let payload
      try {
        payload = JSON.parse(message.data)
      } catch {
        return
      }
      void this.handleMessage(connection, payload).catch((error) => {
        this.logger?.debug?.(`panel message failed: ${error.message}`)
      })
    })
    connection.sendJson({
      type: 'hello',
      viewport: this.viewport,
      human: this.human.snapshot(),
      state: this.lastState,
      quality: this.quality,
    })
    await this.startStreaming()
    // Chrome only emits screencast frames when the page changes, so a static
    // page would leave a freshly opened panel blank: capture one now.
    await this.seedFrame(connection)
    await this.pushState({ force: true })
  }

  /** Start (or reuse) the shared screencast loop. */
  async startStreaming() {
    if (this.streaming) return
    this.streaming = true
    try {
      const page = await this.manager.ensure()
      this.page = page
      await page
        .send('Emulation.setDeviceMetricsOverride', {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        })
        .catch(() => {})
      this.detach.push(
        page.on('Page.screencastFrame', (params) => {
          void this.onFrame(params)
        }),
        page.on('Page.frameNavigated', () => {
          void this.pushState()
        }),
      )
      await page.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.quality,
        maxWidth: this.maxWidth,
        maxHeight: this.maxHeight,
        everyNthFrame: 1,
      })
      this.stateTimer = setInterval(() => void this.pushState(), STATE_POLL_MS)
      this.stateTimer.unref?.()
      this.logger?.debug?.('screencast started')
    } catch (error) {
      this.streaming = false
      this.logger?.warn?.(`screencast failed to start: ${error.message}`)
      this.broadcast({ type: 'error', message: error.message })
    }
  }

  /** Stop the screencast loop once the last panel disconnects. */
  async stopStreaming() {
    if (!this.streaming) return
    this.streaming = false
    clearInterval(this.stateTimer)
    this.stateTimer = undefined
    for (const off of this.detach) off()
    this.detach = []
    const page = this.page
    this.page = undefined
    if (page !== undefined) {
      await page.send('Page.stopScreencast').catch(() => {})
      await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
    }
    this.logger?.debug?.('screencast stopped')
  }

  /** Fan one JPEG frame out to every panel and acknowledge it to Chrome. */
  async onFrame(params) {
    const page = this.page
    if (page === undefined) return
    let payload
    try {
      payload = Buffer.from(params.data, 'base64')
    } catch {
      return
    }
    this.lastFrame = payload
    const metadata = params.metadata ?? {}
    for (const connection of this.connections) {
      if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.framesDropped += 1
        continue
      }
      connection.sendBinary(payload)
    }
    if (params.sessionId !== undefined) {
      await page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
    }
    void metadata
  }

  /** Replay one panel message into the browser. */
  async handleMessage(connection, message) {
    if (message.type === 'human-done') {
      this.human.done(message.requestId, message.note !== undefined ? { note: message.note } : {})
      return
    }
    if (message.type === 'human-reply') {
      this.human.done(message.requestId, { reply: typeof message.text === 'string' ? message.text : '' })
      return
    }
    if (message.type === 'nav') {
      const action = message.action
      if (action === 'back') await this.manager.goBack()
      else if (action === 'forward') await this.manager.goForward()
      else if (action === 'reload') await this.manager.reload()
      await this.pushState({ force: true })
      return
    }
    if (message.type === 'open') {
      if (typeof message.url === 'string' && message.url !== '') await this.manager.openTab(message.url)
      await this.pushState({ force: true })
      for (const client of this.connections) {
        if (client !== connection) client.sendJson({ type: 'reconnect' })
      }
      return
    }
    if (message.type === 'play') {
      // A fresh frame for a static page: Chrome only emits frames on change.
      await this.seedFrame(connection)
      return
    }
    if (message.type !== 'input') return
    const page = await this.manager.ensure()
    this.manager.touch()
    const input = message
    const mask = modifierMask(input.modifiers)
    if (input.kind === 'mouse') {
      const event = input.event
      const type = event === 'move' ? 'mouseMoved' : event === 'down' ? 'mousePressed' : 'mouseReleased'
      await page.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(input.x),
        y: Math.round(input.y),
        button: input.button ?? 'left',
        buttons: type === 'mouseReleased' || type === 'mouseMoved' ? 0 : 1,
        clickCount: input.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
        modifiers: mask,
      })
      return
    }
    if (input.kind === 'wheel') {
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(input.x),
        y: Math.round(input.y),
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: mask,
      })
      return
    }
    if (input.kind === 'text') {
      if (typeof input.text === 'string' && input.text !== '') await page.send('Input.insertText', { text: input.text })
      return
    }
    if (input.kind === 'key') {
      const down = input.event !== 'up'
      const common = {
        key: input.key,
        code: input.code ?? undefined,
        windowsVirtualKeyCode: input.keyCode ?? undefined,
        nativeVirtualKeyCode: input.keyCode ?? undefined,
        modifiers: mask,
      }
      if (down) {
        const printable = typeof input.text === 'string' && input.text !== '' && mask === 0
        await page.send('Input.dispatchKeyEvent', {
          type: printable ? 'keyDown' : 'rawKeyDown',
          ...common,
          ...(printable ? { text: input.text, unmodifiedText: input.text } : {}),
        })
      } else {
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common })
      }
    }
  }

  /** Send one freshly captured frame to a single panel (fills a blank canvas). */
  async seedFrame(connection) {
    try {
      const page = await this.manager.ensure()
      const shot = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: this.quality })
      const payload = Buffer.from(shot.data, 'base64')
      this.lastFrame = payload
      connection.sendBinary(payload)
    } catch (error) {
      this.logger?.debug?.(`seed frame failed: ${error.message}`)
    }
  }

  /** Stop streaming and release every listener (plugin dispose). */
  async close() {
    await this.stopStreaming()
    for (const connection of this.connections) connection.close(1001, 'plugin unloading')
    this.connections.clear()
    await sleep(0)
  }
}
