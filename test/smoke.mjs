#!/usr/bin/env node
/**
 * Standalone smoke test for the browser-panel core.
 *
 * Runs without DSH: it starts the real Chrome through BrowserManager, serves a
 * tiny login page, drives the page over CDP, then connects a WebSocket panel
 * client to exercise the screencast + input path end to end.
 *
 *   node test/smoke.mjs
 */

import http from 'node:http'
import { rmSync } from 'node:fs'
import { BrowserManager, sleep } from '../lib/browser.js'
import { acceptUpgrade } from '../lib/ws.js'
import { ScreencastHub } from '../lib/screencast.js'
import { HumanBroker } from '../lib/human.js'

const PROFILE = '/tmp/dsh-browser-panel-smoke/profile'
const results = []
let failures = 0

function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- test page
const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
const site = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers })
    res.end(body)
  }
  if (url.pathname === '/') {
    return send(200, page('Smoke Home', '<h1>Smoke Home</h1><a href="/login">进入登录页</a><p id="marker">initial</p>'))
  }
  if (url.pathname === '/login' && req.method === 'GET') {
    return send(
      200,
      page(
        'Smoke Login',
        `<h1>登录</h1><form method="POST" action="/login">
           <input name="user" placeholder="用户名"><input name="pass" type="password" placeholder="密码">
           <button type="submit">登录</button></form>`,
      ),
    )
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const params = new URLSearchParams(body)
      if (params.get('pass') !== 'secret') return send(401, page('登录失败', '<h1>密码错误</h1>'))
      send(302, '', { location: '/welcome', 'set-cookie': 'smoke_sid=ok; Path=/; Max-Age=2592000' })
    })
    return
  }
  if (url.pathname === '/welcome') {
    const cookie = req.headers.cookie ?? ''
    if (!cookie.includes('smoke_sid=')) return send(401, page('未登录', '<h1>401</h1>'))
    return send(200, page('欢迎', '<h1 id="who">已登录</h1><p>会话有效</p>'))
  }
  send(404, page('404', '<h1>404</h1>'))
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
const siteUrl = `http://127.0.0.1:${site.address().port}`
console.log(`smoke site: ${siteUrl}\n`)

// --------------------------------------------------------------- ws harness
const sockets = []
const server = http.createServer()
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/stream') {
    socket.destroy()
    return
  }
  acceptUpgrade(req, socket, head, (connection) => {
    sockets.push(connection)
    void hub.attach(connection)
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const wsUrl = `ws://127.0.0.1:${server.address().port}/stream`

let hub
const human = new HumanBroker({
  onEvent: (event) => {
    if (event.type === 'human-request') hub?.broadcast({ type: 'human-request', request: event.request })
    else if (event.type === 'human-timeout') hub?.broadcast({ type: 'human-timeout', id: event.id })
    else if (event.type === 'human-done') hub?.broadcast({ type: 'human-done', id: event.id })
  },
})
const manager = new BrowserManager({
  config: {
    mode: 'auto',
    profileDir: PROFILE,
    screen: '1280x800x24',
    windowSize: '1280x800',
    snapshotMaxChars: 2000,
    maxElements: 40,
  },
  logger: { info: (m) => console.log(`  [browser] ${m}`), debug: () => {}, warn: (m) => console.log(`  [warn] ${m}`) },
})
hub = new ScreencastHub({
  manager,
  logger: console.log,
  viewport: { width: 1280, height: 800 },
  quality: 55,
  maxWidth: 1280,
  maxHeight: 800,
  human,
})

try {
  // ------------------------------------------------------------- AI side
  rmSync(PROFILE, { recursive: true, force: true })
  const status = await manager.status()
  check('status before start reports stopped', status.running === false, JSON.stringify(status.mode ?? ''))

  const started = await manager.navigate(`${siteUrl}/`)
  check('browser starts and navigates', started.running === true && started.url.endsWith('/'), `${started.mode} ${started.url}`)

  const snapshot = await manager.snapshot()
  check('snapshot lists the login link', snapshot.elements.some((e) => (e.label ?? '').includes('进入登录页')), `${snapshot.elements.length} elements`)
  check('snapshot carries page text', snapshot.text.includes('Smoke Home'), JSON.stringify(snapshot.text.slice(0, 40)))

  await manager.clickText('进入登录页')
  await sleep(400)
  const loginState = await manager.status()
  check('click-by-text navigates', loginState.url.endsWith('/login'), loginState.url)

  const form = await manager.snapshot()
  const userField = form.elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('用户名'))
  const passField = form.elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('密码'))
  check('snapshot indexes form fields', userField !== undefined && passField !== undefined)

  await manager.type(userField.index, 'smoke-user')
  await manager.type(passField.index, 'secret', { submit: true })
  await sleep(700)
  const welcome = await manager.status()
  check('AI login flow reaches the protected page', welcome.url.endsWith('/welcome'), welcome.url)

  const cookies = await manager.cookies()
  check('session cookie is present', cookies.some((c) => c.name === 'smoke_sid'))

  const shot = await manager.screenshot()
  check('screenshot returns PNG bytes', shot.data.length > 1000 && shot.data.subarray(1, 4).toString() === 'PNG', `${shot.data.length} bytes`)

  // ----------------------------------------------------------- panel side
  const frames = []
  const messages = []
  const client = new WebSocket(wsUrl)
  client.binaryType = 'arraybuffer'
  client.onmessage = (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data))
    else frames.push(Buffer.from(event.data))
  }
  await new Promise((resolve, reject) => {
    client.onopen = resolve
    client.onerror = () => reject(new Error('panel websocket failed to open'))
  })
  await sleep(900)
  check('panel receives hello', messages.some((m) => m.type === 'hello'))
  check('panel receives a binary frame', frames.length > 0 && frames[0].subarray(0, 2).toString('hex') === 'ffd8', `${frames.length} frames, first ${frames[0]?.length ?? 0} bytes`)
  check('panel receives state with url', messages.some((m) => m.type === 'state' && typeof m.url === 'string'))

  // Human types through the panel into the page: go back and log in again.
  client.send(JSON.stringify({ type: 'nav', action: 'back' }))
  await sleep(900)
  await hub.pushState({ force: true })
  await sleep(200)
  const backState = messages.filter((m) => m.type === 'state').pop()
  check('panel navigation works', typeof backState?.url === 'string' && backState.url.endsWith('/login'), backState?.url)

  const live = await manager.snapshot()
  const user = live.elements.find((e) => e.tag === 'input' && (e.label ?? '').includes('用户名'))
  const located = await manager.locate(user.index)
  client.send(JSON.stringify({ type: 'input', kind: 'mouse', event: 'down', x: located.x, y: located.y, button: 'left', clickCount: 1 }))
  client.send(JSON.stringify({ type: 'input', kind: 'mouse', event: 'up', x: located.x, y: located.y, button: 'left', clickCount: 1 }))
  await sleep(120)
  client.send(JSON.stringify({ type: 'input', kind: 'text', text: 'human-user' }))
  await sleep(250)
  const afterTyping = await manager.evaluate('document.querySelector("input[name=user]").value')
  check('panel keyboard input reaches the page', String(afterTyping).endsWith('human-user'), JSON.stringify(afterTyping))

  // Live streaming: a page change after the panel connected must push a new frame.
  const framesBefore = frames.length
  await manager.navigate(`${siteUrl}/`)
  await sleep(1200)
  check('live screencast pushes frames on page change', frames.length > framesBefore, `${framesBefore} -> ${frames.length} frames`)
  await manager.navigate(`${siteUrl}/login`)
  await sleep(800)

  // Reconnect race: a disconnecting panel used to kill the *next* panel's
  // screencast (its async teardown stopped the stream the new one had started).
  client.close()
  const secondFrames = []
  const secondMessages = []
  const reconnected = new WebSocket(wsUrl)
  reconnected.binaryType = 'arraybuffer'
  reconnected.onmessage = (event) => {
    if (typeof event.data === 'string') secondMessages.push(JSON.parse(event.data))
    else secondFrames.push(Buffer.from(event.data))
  }
  await new Promise((resolve, reject) => {
    reconnected.onopen = resolve
    reconnected.onerror = () => reject(new Error('reconnect failed'))
  })
  await sleep(800)
  const framesBeforeNav = secondFrames.length
  await manager.navigate(`${siteUrl}/login`)
  await sleep(1500)
  check('stream survives a panel reconnect race', secondFrames.length > framesBeforeNav, `${framesBeforeNav} -> ${secondFrames.length} frames`)

  // ------------------------------------------------------- human handover
  const asked = human.ask('请在面板里完成登录', { timeoutMs: 5000 })
  await sleep(200)
  check('human request is broadcast', secondMessages.some((m) => m.type === 'human-request'))
  reconnected.send(JSON.stringify({ type: 'human-done', requestId: human.snapshot()?.id }))
  const outcome = await asked
  check('human handover resolves on done', outcome.status === 'done', JSON.stringify(outcome))
  await sleep(150)
  check('human done is broadcast to panels', secondMessages.some((m) => m.type === 'human-done'))

  const timeoutOutcome = await human.ask('永远不会点', { timeoutMs: 300 })
  check('human handover times out', timeoutOutcome.status === 'timeout')

  // ------------------------------------------------------------- restart
  await manager.stop()
  const stopped = await manager.status()
  check('stop releases the browser', stopped.running === false)
  const restarted = await manager.navigate(`${siteUrl}/welcome`)
  check('login survives a browser restart', restarted.title === '欢迎', `${restarted.url} / ${restarted.title}`)
  client.close()
  await manager.stop()
} catch (error) {
  failures += 1
  console.error(`\n✗ smoke aborted: ${error.stack ?? error.message}`)
} finally {
  await hub.close().catch(() => {})
  await manager.stop().catch(() => {})
  server.close()
  site.close()
  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`} (${results.length} total)`)
  process.exit(failures === 0 ? 0 : 1)
}
