/**
 * The model-facing tool set.
 *
 * Names are prefixed `browser_panel_` on purpose: other DSH browser plugins own
 * `browser_*`, and a duplicate tool name aborts plugin load.
 *
 * @module dsh-browser-panel/tools
 */

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Canonical values must be lossless JSON: drop `undefined` and functions. */
const clean = (value) => JSON.parse(JSON.stringify(value ?? null))

/** Render one canonical value as a single text block. */
const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, undefined, 1) }]

/** Unconstrained JSON output plus the plugin's own text projection. */
const jsonOutput = () => ({ schema: { type: 'json' }, render: (_args, value) => asText(value) })

/** Human-readable snapshot: header, numbered inventory, then page text. */
function formatSnapshot(value) {
  const lines = []
  if (value.title !== undefined || value.url !== undefined) lines.push(`${value.title ?? ''}`.trim(), `${value.url ?? ''}`.trim(), '')
  if (Array.isArray(value.elements) && value.elements.length > 0) {
    lines.push(`可交互元素 (${value.elements.length}):`)
    for (const element of value.elements) {
      const bits = [`[${element.index}]`, `<${element.tag}>`]
      if (element.type !== undefined) bits.push(`type=${element.type}`)
      if (element.label !== undefined && element.label !== '') bits.push(`"${element.label}"`)
      if (element.value !== undefined && element.value !== '') bits.push(`值="${element.value}"`)
      if (element.disabled === true) bits.push('(disabled)')
      lines.push(`  ${bits.join(' ')}`)
    }
    lines.push('')
  }
  if (typeof value.text === 'string' && value.text !== '') lines.push('页面正文:', value.text)
  return lines.join('\n')
}

/**
 * Build every tool this plugin registers.
 *
 * @param deps - browser manager, human broker, screencast hub, config, and the
 *   optional attachment service used to hand screenshots back to the model.
 * @returns tool definitions to register inside one effect.
 */
export function defineTools({ manager, human, hub, config, getAttachments, logger, getPanelAvailable = () => true }) {
  const screenshotRefs = new Map()
  let screenshotSequence = 0
  const askHumanTimeoutMs = Math.max(10_000, (config.askHumanTimeoutSeconds ?? 600) * 1000)

  const status = defineTool({
    name: 'browser_panel_status',
    description:
      'Report the shared browser: whether it is running, the current URL/title, the persistent profile directory, and whether the human has a pending action. Call this first when unsure about browser state.',
    parameters: {},
    output: jsonOutput(),
    execute: async () => clean(await manager.status()),
  })

  const navigate = defineTool({
    name: 'browser_panel_navigate',
    description:
      'Open a URL in the shared browser (starting it if needed). The same browser is mirrored in the DSH Web UI panel, so the human can watch or take over at any time. Use newTab to keep the current page open.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL to open.' },
      newTab: { type: 'boolean', description: 'Open in a new tab instead of reusing the visible one.' },
    },
    output: jsonOutput(),
    execute: async (args) => {
      const url = String(args.url)
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      return clean(args.newTab === true ? await manager.openTab(url) : await manager.navigate(url))
    },
  })

  const snapshot = defineTool({
    name: 'browser_panel_snapshot',
    description:
      'Read the current page as structured text: title, URL, a numbered inventory of clickable/typable elements, and the visible text. Pass an element number to browser_panel_click or browser_panel_type.',
    parameters: {
      maxChars: { type: 'number', description: 'Truncate the page text at this many characters.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(formatSnapshot(value)),
    },
    execute: async (args) => clean(await manager.snapshot({ maxChars: args.maxChars })),
  })

  const click = defineTool({
    name: 'browser_panel_click',
    description:
      'Click something in the shared browser: either an element number from browser_panel_snapshot, or a visible text label to match. Real input events are dispatched, so hover/focus behaviour matches a human click.',
    parameters: {
      index: { type: 'number', description: 'Element number from the latest browser_panel_snapshot.' },
      text: { type: 'string', description: 'Visible label of the element to click (exact match first, then substring).' },
    },
    output: jsonOutput(),
    execute: async (args) => {
      if (typeof args.index === 'number') return clean(await manager.click(args.index))
      if (typeof args.text === 'string' && args.text !== '') return clean(await manager.clickText(args.text))
      throw new Error('provide either index or text')
    },
  })

  const type = defineTool({
    name: 'browser_panel_type',
    description:
      'Focus a field by its element number and insert text (works with React/Vue controlled inputs). Set submit=true to press Enter afterwards, e.g. to submit a login form.',
    parameters: {
      index: { type: 'number', required: true, description: 'Field element number from the latest snapshot.' },
      text: { type: 'string', required: true, description: 'Text to insert.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    output: jsonOutput(),
    execute: async (args) => clean(await manager.type(args.index, String(args.text), { submit: args.submit === true })),
  })

  const press = defineTool({
    name: 'browser_panel_press',
    description: 'Press one key in the shared browser (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space).',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name, e.g. Enter.' },
    },
    output: jsonOutput(),
    execute: async (args) => clean(await manager.press(String(args.key))),
  })

  const scroll = defineTool({
    name: 'browser_panel_scroll',
    description: 'Scroll the shared browser viewport: down, up, left, right, top, or bottom.',
    parameters: {
      direction: { type: 'string', required: true, description: 'One of down, up, left, right, top, bottom.' },
      pixels: { type: 'number', description: 'Explicit scroll distance instead of one page.' },
    },
    output: jsonOutput(),
    execute: async (args) => clean(await manager.scroll(String(args.direction), { pixels: args.pixels })),
  })

  const screenshot = defineTool({
    name: 'browser_panel_screenshot',
    description:
      'Capture the current page as an image so you can see the rendering (layout, CAPTCHA, QR codes, charts). Prefer browser_panel_snapshot for reading text.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        try {
          const ref = value.attachmentId !== undefined ? screenshotRefs.get(value.attachmentId) : undefined
          if (ref !== undefined) {
            return [{ type: 'text', text: `屏幕截图 ${value.mediaType} ${value.bytes} 字节` }, { type: 'image', attachment: ref }]
          }
          return asText(value)
        } catch (error) {
          return asText({ error: `screenshot render failed: ${error.message}` })
        }
      },
    },
    execute: async (args) => {
      const shot = await manager.screenshot({ fullPage: args.fullPage === true })
      const attachments = getAttachments?.()
      if (attachments !== undefined) {
        try {
          const ref = await attachments.saveImage({ data: shot.data, mediaType: shot.mediaType })
          const attachmentId = `browser-panel-shot-${++screenshotSequence}`
          screenshotRefs.set(attachmentId, ref)
          if (screenshotRefs.size > 8) screenshotRefs.delete(screenshotRefs.keys().next().value)
          return { attachmentId, bytes: shot.data.length, mediaType: shot.mediaType }
        } catch (error) {
          logger?.debug?.(`attachment save failed: ${error.message}`)
        }
      }
      const file = join(tmpdir(), `dsh-browser-panel-${Date.now()}.png`)
      await writeFile(file, shot.data)
      return { path: file, bytes: shot.data.length, mediaType: shot.mediaType }
    },
  })

  const askHuman = defineTool({
    name: 'browser_panel_ask_human',
    description:
      'Hand the shared browser to the person in front of the DSH Web UI and wait. Use this whenever you hit something only a human can do: entering credentials, scanning a QR code, a one-time passcode from a phone, a CAPTCHA, or a hardware/SSO step. The panel opens on their screen with your instruction; this call returns as soon as they press 完成, or on timeout.',
    parameters: {
      instruction: { type: 'string', required: true, description: 'What the human should do, in their language, e.g. 请在浏览器面板里登录腾讯云控制台（账号密码或扫码），完成后点「我已完成」。' },
      timeoutSeconds: { type: 'number', description: 'How long to wait for the human (default from plugin config).' },
      url: { type: 'string', description: 'Optional URL to open before handing over.' },
    },
    output: jsonOutput(),
    timeoutMs: askHumanTimeoutMs + 60_000,
    execute: async (args, exec) => {
      if (getPanelAvailable() !== true) {
        throw new Error('the browser panel is not available in this deployment (no DSH Web UI); ask the human to supply the value directly')
      }
      const instruction = String(args.instruction ?? '请在浏览器面板里完成操作，然后点「我已完成」。')
      const timeoutMs = args.timeoutSeconds !== undefined ? Math.max(5_000, Number(args.timeoutSeconds) * 1000) : askHumanTimeoutMs
      if (typeof args.url === 'string' && args.url !== '') await manager.navigate(args.url)
      else await manager.ensure()
      await hub.pushState({ force: true })
      const onAbort = () => human.cancel('cancelled')
      exec?.signal?.addEventListener?.('abort', onAbort, { once: true })
      try {
        const outcome = await human.ask(instruction, { timeoutMs })
        const status = await manager.status()
        const view = await manager.snapshot({ maxChars: 1500 }).catch(() => undefined)
        return clean({
          ...outcome,
          url: status.url,
          title: status.title,
          text: view?.text ?? null,
          elements: view?.elements?.slice(0, 40) ?? null,
        })
      } finally {
        exec?.signal?.removeEventListener?.('abort', onAbort)
      }
    },
  })

  const close = defineTool({
    name: 'browser_panel_close',
    description:
      'Stop the browser process. The persistent profile keeps every login, so the next call starts authenticated again. Only use it to free memory.',
    parameters: {},
    output: jsonOutput(),
    execute: async () => {
      await manager.stop()
      return { running: false }
    },
  })

  return [status, navigate, snapshot, click, type, press, scroll, screenshot, askHuman, close]
}
