#!/usr/bin/env node
/**
 * Human-side end-to-end check: dispatch real pointer/keyboard events on the
 * browser panel's canvas inside a running DSH Web UI, then confirm in the shared
 * browser that the human's action actually reached the page.
 *
 *   1. open the DSH Web UI in a browser you can attach to, open the panel
 *   2. node test/human-input.mjs <guiDevToolsPort> <sharedBrowserDevToolsPort>
 *
 * Both ports speak CDP: the first is the browser showing the GUI, the second is
 * the browser the plugin runs (its port is in /api/dsh-browser-panel/state).
 */
import { connectWs } from '../lib/cdp.js'

const GUI_PORT = Number(process.argv[2] ?? 9225)
const SHARED_PORT = Number(process.argv[3])
if (!SHARED_PORT) throw new Error('usage: human-input.mjs <guiPort> <sharedPort>')

/** Attach to the newest page target of a DevTools port. */
async function attach(port) {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === 'page')
  const target = targets[targets.length - 1]
  const ws = connectWs(target.webSocketDebuggerUrl)
  await ws.ready
  await ws.send('Page.enable')
  await ws.send('Runtime.enable')
  return ws
}

const evalOn = async (ws, expression) => {
  const result = await ws.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  return result.result.value
}

const gui = await attach(GUI_PORT)
const shared = await attach(SHARED_PORT)

// 1) 让共享浏览器停在本地登录页，并把用户名输入框的视口坐标取出来
await evalOn(shared, "location.href = 'http://127.0.0.1:8899/login'")
await new Promise((r) => setTimeout(r, 1500))
const field = JSON.parse(
  await evalOn(
    shared,
    `(() => { const el = document.querySelector('input[name=user]'); const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`,
  ),
)
const viewport = JSON.parse(await evalOn(gui, `JSON.stringify({ w: innerWidth, h: innerHeight })`))
void viewport

// 2) 面板画布尺寸 / 位置（画布按 contain 缩放，需要按比例映射回去）
const canvas = JSON.parse(
  await evalOn(
    gui,
    `(() => { const c = document.querySelector('[data-dsh-browser-panel] canvas'); const r = c.getBoundingClientRect();
      return JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height }) })()`,
  ),
)

// 3) 页面视口坐标 -> GUI 画布坐标
const pageViewport = JSON.parse(await evalOn(gui, `window.__dbpViewport ? JSON.stringify(window.__dbpViewport) : 'null'`))
const vw = pageViewport?.width ?? canvas.cw
const vh = pageViewport?.height ?? canvas.ch
const guiX = Math.round(canvas.left + (field.x / vw) * canvas.width)
const guiY = Math.round(canvas.top + (field.y / vh) * canvas.height)
console.log(`共享页输入框 @(${field.x},${field.y}) → GUI 画布 @(${guiX},${guiY})  [canvas ${canvas.width.toFixed(0)}x${canvas.height.toFixed(0)}, 视口 ${vw}x${vh}]`)

// 4) 派发真实指针事件（不是 JS .click()，所以走的是 client.js 的 React 处理器）
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
  await gui.send('Input.dispatchMouseEvent', {
    type,
    x: guiX,
    y: guiY,
    button: 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: 1,
  })
  await new Promise((r) => setTimeout(r, 60))
}
await new Promise((r) => setTimeout(r, 400))

// 5) 敲字：焦点应在面板的键盘 sink 上，输入事件会被转发成 insertText
await gui.send('Input.insertText', { text: 'human-user' })
await new Promise((r) => setTimeout(r, 600))

// 6) 回共享浏览器核对
const typed = await evalOn(shared, `document.querySelector('input[name=user]').value`)
const focused = await evalOn(shared, `document.activeElement && document.activeElement.name`)
console.log(`共享页输入框值 = ${JSON.stringify(typed)}（焦点字段：${focused}）`)
console.log(typed === 'human-user' ? '✅ 人类在 GUI 面板里的操作真的落到容器浏览器' : '❌ 输入没有到达共享浏览器')
process.exit(typed === 'human-user' ? 0 : 1)
