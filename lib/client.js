/**
 * dsh-browser-panel — browser half.
 *
 * One Chrome lives on the DSH host and **every DSH session owns one tab in it**.
 * This half gives that model three surfaces inside the Web UI:
 *
 * 1. `conversation.view` (id `browser-panel`) — the primary surface: the live
 *    picture of *this* session's tab, with the human's mouse, wheel, keyboard
 *    and IME replayed into the very CDP target the AI drives, plus the
 *    hand-over banner `browser_panel_ask_human` waits on. The slot entry is
 *    session-scoped, so the component always knows which tab it shows, and its
 *    mount/unmount lifetime *is* the focus protocol (mount asks the host to put
 *    this tab in front and stream it at full rate, unmount gives it back —
 *    unmount never closes the tab).
 * 2. `sidebar.panellist` (id `browser-panel`) — the sidebar entry: a glyph plus
 *    a dot while some session is waiting for a person.
 * 3. `main` keyed `browser-panel` — that entry's body: a host-wide overview of
 *    every session tab (title, url, last used, 待接管 badge, 结束并清理 per row).
 *    It is deliberately *not* a browser canvas: the canvas is per session and
 *    therefore belongs to (1).
 *
 * Plain JavaScript on purpose: the module loader factory must not depend on a
 * build step or on npm packages beyond React, which the host provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-panel',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** Panel id shared by the view tab, the sidebar entry and its body. */
    const PANEL_ID = 'browser-panel'
    /** Every route this plugin owns; all same-origin, all cookie-authenticated. */
    const BASE = '/api/dsh-browser-panel'
    const STREAM_PATH = `${BASE}/stream`
    const STATE_PATH = `${BASE}/state`
    const SESSIONS_PATH = `${BASE}/sessions`
    const OPEN_PATH = `${BASE}/open`
    const CLOSE_PATH = `${BASE}/close`
    const DONE_PATH = `${BASE}/human-done`
    /** Overview poll: a new session tab must show up before the human looks away. */
    const OVERVIEW_POLL_MS = 2000
    /** Session state poll, used only while the websocket is not live. */
    const STATE_POLL_MS = 2000
    /** The sidebar dot is decoration: a slow poll is enough and costs nothing. */
    const SIDEBAR_POLL_MS = 5000
    /** Reconnect backoff, so a host restart does not become a request storm. */
    const RECONNECT_BASE_MS = 800
    const RECONNECT_MAX_MS = 15000
    /** Pointer moves are throttled to ~25/s; a page does not need more. */
    const MOVE_THROTTLE_MS = 40

    /** Copy for both shipped locales. */
    const DICT = {
      zh: {
        title: '浏览器',
        back: '后退',
        forward: '前进',
        reload: '刷新',
        refresh: '重绘',
        closeTab: '结束并清理',
        closeTabTitle: '关闭这个会话的浏览器标签页（未提交的页面状态会丢失）',
        closeTabConfirm: '关闭这个会话的浏览器标签页？未提交的表单与页面状态会丢失；登录态存在共享 profile 里，不会丢。',
        connecting: '连接中…',
        connected: '已连接',
        offline: '连接断开，正在重连…',
        stopped: '浏览器未启动',
        failed: '浏览器启动失败',
        checking: '正在检查这个会话的浏览器…',
        empty: '这个会话还没有打开浏览器',
        emptyHint: '打开后这里就是 AI 正在操作的页面；登录、扫码、验证码都可以直接在这里完成。',
        open: '在此会话打开浏览器',
        starting: '正在打开…',
        openFailed: '打开失败',
        waitingFrame: '正在获取画面…',
        humanTitle: '需要你操作',
        humanDone: '我已完成',
        humanHint: '完成上方操作后点此按钮，AI 会接着往下做；也可以留一句话再回复。',
        reply: '回复',
        replyPlaceholder: '留一句话给 AI（可选）',
        pollHint: '降帧快照 ~7fps（标签页不在前台）',
        noSession: '这里拿不到会话 id，无法确定这个面板对应哪个浏览器标签页。',
        overviewTitle: '浏览器标签页',
        overviewEmpty: '还没有任何会话打开浏览器。',
        overviewEmptyHint: '在某个会话里打开浏览器后，这里会列出它的标签页；每一行都能单独结束并清理。',
        overviewHint: 'AI 与人类共用这些标签页，登录态由同一个浏览器 profile 共享。',
        lastUsed: '最近使用',
        watched: '正在观看',
        pending: '待接管',
        closeRow: '结束并清理',
        closeRowConfirm: '关闭「{name}」的浏览器标签页？未提交的表单与页面状态会丢失。',
        noUrl: '（无地址）',
        agoNow: '刚刚',
        agoMinutes: '{n} 分钟前',
        agoHours: '{n} 小时前',
        agoDays: '{n} 天前',
        tab: '把焦点移到下一个可输入元素（免鼠标定位）',
        shiftTab: '焦点移到上一个元素',
        enter: '回车（提交 / 确认）',
        instructions: '点画面任意处即可聚焦，然后用键盘/输入法打字（登录页常用）；表单还可以用工具栏的 Tab / Enter 逐项跳转提交。AI 看到的是同一个页面。',
      },
      en: {
        title: 'Browser',
        back: 'Back',
        forward: 'Forward',
        reload: 'Reload',
        refresh: 'Repaint',
        closeTab: 'Close tab',
        closeTabTitle: 'Close this session’s browser tab (its page state is discarded)',
        closeTabConfirm: 'Close this session’s browser tab? Unsaved form and page state are lost — logins live in the shared profile and stay.',
        connecting: 'Connecting…',
        connected: 'Connected',
        offline: 'Disconnected — reconnecting…',
        stopped: 'Browser not running',
        failed: 'Browser failed to start',
        checking: 'Checking this session’s browser…',
        empty: 'This session has no browser open yet',
        emptyHint: 'Once opened, this is the page the AI is working on — logins, QR codes and CAPTCHAs can be done right here.',
        open: 'Open a browser in this session',
        starting: 'Opening…',
        openFailed: 'Could not open',
        waitingFrame: 'Fetching the first frame…',
        humanTitle: 'Your turn',
        humanDone: 'Done',
        humanHint: 'Finish the step above, then press this — the AI continues from there. You can also leave a note in the reply field.',
        reply: 'Reply',
        replyPlaceholder: 'Leave the AI a note (optional)',
        pollHint: 'Low-rate stills ~7fps (tab not in front)',
        noSession: 'No session id here, so this panel cannot tell which browser tab it shows.',
        overviewTitle: 'Browser tabs',
        overviewEmpty: 'No session has opened a browser yet.',
        overviewEmptyHint: 'Open the browser in a session and its tab shows up here; every row can be closed on its own.',
        overviewHint: 'The AI and humans share these tabs; logins live in one shared browser profile.',
        lastUsed: 'last used',
        watched: 'watching',
        pending: 'needs you',
        closeRow: 'Close tab',
        closeRowConfirm: 'Close the browser tab of “{name}”? Unsaved form and page state are lost.',
        noUrl: '(no address)',
        agoNow: 'just now',
        agoMinutes: '{n} min ago',
        agoHours: '{n} h ago',
        agoDays: '{n} d ago',
        tab: 'Move focus to the next field (no mouse aiming needed)',
        shiftTab: 'Move focus to the previous element',
        enter: 'Enter (submit / confirm)',
        instructions: 'Click anywhere in the picture to focus it, then type with your keyboard or IME (handy for logins); use the Tab / Enter buttons to walk a form without aiming the mouse. The AI sees the same page.',
      },
    }

    /** Pick the dictionary that matches the GUI language. */
    function pickDict(locale) {
      const code = String(locale ?? '').toLowerCase()
      return code.startsWith('zh') ? DICT.zh : DICT.en
    }

    /**
     * Stylesheet, scoped by data attribute; colours follow the host theme.
     *
     * `.dbp-overlay` is an *informational* layer over a live canvas and must stay
     * click-through (a full-canvas overlay without `pointer-events:none` silently
     * eats every click on the page below — see references/PITFALLS.md #10). The
     * interactive empty state is a separate class without that rule.
     */
    const CSS = `
      [data-dsh-browser-panel]{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#111);color:var(--dsw-alias-label-primary,#eee)}
      [data-dsh-browser-panel] .dbp-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent);font-size:12.5px}
      [data-dsh-browser-panel] .dbp-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e0a020);flex:none}
      [data-dsh-browser-panel] .dbp-dot[data-state="online"]{background:var(--dsw-alias-state-success-primary,#3ecf8e)}
      [data-dsh-browser-panel] .dbp-dot[data-state="offline"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
      [data-dsh-browser-panel] .dbp-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34%}
      [data-dsh-browser-panel] .dbp-url{color:var(--dsw-alias-label-secondary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;font-variant-numeric:tabular-nums}
      [data-dsh-browser-panel] .dbp-note{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap}
      [data-dsh-browser-panel] .dbp-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent)}
      [data-dsh-browser-panel] button.dbp-btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;border-radius:6px;padding:3px 9px;font-size:12.5px;font-family:inherit;cursor:pointer;flex:none}
      [data-dsh-browser-panel] button.dbp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.18))}
      [data-dsh-browser-panel] button.dbp-btn:disabled{opacity:.45;cursor:default}
      [data-dsh-browser-panel] button.dbp-danger{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
      [data-dsh-browser-panel] button.dbp-primary{border:0;border-radius:6px;padding:5px 14px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;flex:none}
      [data-dsh-browser-panel] button.dbp-primary:disabled{opacity:.5;cursor:default}
      [data-dsh-browser-panel] .dbp-spacer{flex:1;min-width:8px}
      [data-dsh-browser-panel] .dbp-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;background:var(--dsw-alias-bg-overlay,rgba(224,160,32,.16));border-bottom:1px solid var(--dsw-alias-state-warn-primary,#e0a020);font-size:13px}
      [data-dsh-browser-panel] .dbp-banner strong{color:var(--dsw-alias-state-warn-primary,#e0a020);flex:none}
      [data-dsh-browser-panel] .dbp-banner .dbp-grow{flex:1;min-width:140px}
      [data-dsh-browser-panel] .dbp-banner input.dbp-reply{flex:0 1 240px;min-width:140px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-base,#111);color:inherit;padding:4px 8px;font-size:12.5px;font-family:inherit}
      [data-dsh-browser-panel] .dbp-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-base,#0b0b0b)}
      [data-dsh-browser-panel] canvas.dbp-canvas{display:block;max-width:100%;max-height:100%;outline:none;cursor:default;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      [data-dsh-browser-panel] .dbp-hint{position:absolute;left:12px;right:12px;bottom:10px;font-size:12px;text-align:center;color:var(--dsw-alias-label-secondary,#999);pointer-events:none}
      [data-dsh-browser-panel] .dbp-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary,#999);font-size:13px;text-align:center;padding:24px;pointer-events:none}
      [data-dsh-browser-panel] .dbp-sink{position:absolute;opacity:0;width:1px;height:1px;border:0;padding:0;resize:none;left:0;top:0}
      [data-dsh-browser-panel] .dbp-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbp-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#eee)}
      [data-dsh-browser-panel] .dbp-empty-note{max-width:420px;line-height:1.6}
      [data-dsh-browser-panel] .dbp-empty-error{max-width:420px;color:var(--dsw-alias-state-error-primary,#e5484d);word-break:break-word}
      [data-dsh-browser-panel] .dbp-notice{display:flex;align-items:center;justify-content:center;flex:1;min-height:0;padding:24px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbo-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));font-size:13px;font-weight:600}
      [data-dsh-browser-panel] .dbo-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbo-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:8px 10px}
      [data-dsh-browser-panel] .dbo-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
      [data-dsh-browser-panel] .dbo-main{flex:1;min-width:0}
      [data-dsh-browser-panel] .dbo-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;font-weight:600}
      [data-dsh-browser-panel] .dbo-name-text{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      [data-dsh-browser-panel] .dbo-url{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      [data-dsh-browser-panel] .dbo-meta{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbo-badge{flex:none;font-size:10.5px;font-weight:600;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-warn-primary,#e0a020);color:#111}
      [data-dsh-browser-panel] .dbo-watched{flex:none;font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.4));color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbo-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;flex:1;min-height:0;padding:32px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,#999)}
      [data-dsh-browser-panel] .dbo-hint{padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));font-size:11.5px;color:var(--dsw-alias-label-secondary,#999)}
    `

    /** Modifier list for the host's key dispatch. */
    const modifiersOf = (event) => {
      const list = []
      if (event.altKey) list.push('alt')
      if (event.ctrlKey) list.push('ctrl')
      if (event.metaKey) list.push('meta')
      if (event.shiftKey) list.push('shift')
      return list
    }

    /** Keys forwarded explicitly; everything else is typed through the sink. */
    const SPECIAL_KEYS = {
      Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
      Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
      ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      Home: { key: 'Home', code: 'Home', keyCode: 36 },
      End: { key: 'End', code: 'End', keyCode: 35 },
      PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    }

    /**
     * Fetch one JSON document on the GUI's own origin.
     *
     * Every route is protected by the Web UI's session cookie, so the request
     * must stay same-origin and credentialed; a non-2xx answer is an error the
     * caller renders instead of a silently empty panel.
     */
    async function requestJson(url, options) {
      const { method = 'GET', body } = options ?? {}
      const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(body)
      }
      const response = await fetch(url, init)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    }

    /**
     * Normalize the `/state` payload (`GET /state`, the body of `POST /open`, and
     * the `status` field of a `hello` message) into the few fields the panel uses.
     */
    function snapshotFromState(payload) {
      const session = payload?.session ?? {}
      return {
        open: session.open === true,
        running: payload?.running === true,
        url: typeof session.url === 'string' ? session.url : null,
        title: typeof session.title === 'string' ? session.title : null,
        human: payload?.human ?? null,
        stream: payload?.stream === 'poll' || payload?.stream === 'screencast' ? payload.stream : null,
      }
    }

    /** Normalize a pushed `{ type: 'state' }` message (a flatter shape). */
    function snapshotFromMessage(message) {
      return {
        open: message.open === true,
        running: message.running === true,
        url: typeof message.url === 'string' ? message.url : null,
        title: typeof message.title === 'string' ? message.title : null,
        human: message.human ?? null,
        stream: message.stream === 'poll' || message.stream === 'screencast' ? message.stream : null,
      }
    }

    /** Whether two pending-request snapshots describe the same request. */
    function sameHuman(left, right) {
      if (left === right) return true
      if (left === undefined || left === null || right === undefined || right === null) return false
      return left.id === right.id && left.instruction === right.instruction
    }

    /** Relative "last used" label; the numbers themselves are locale-neutral. */
    function formatAgo(timestamp, dict) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return dict.agoNow
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 45) return dict.agoNow
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return dict.agoMinutes.replace('{n}', String(minutes))
      const hours = Math.round(minutes / 60)
      if (hours < 24) return dict.agoHours.replace('{n}', String(hours))
      return dict.agoDays.replace('{n}', String(Math.round(hours / 24)))
    }

    /** The sidebar entry glyph: a small window with a cursor. */
    function BrowserIcon(props) {
      const { size = 16, active = false } = props ?? {}
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.3 }),
        h('path', { d: 'M1.5 5.5h13', stroke: 'currentColor', strokeWidth: 1.2 }),
        h('circle', { cx: 3.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('circle', { cx: 5.6, cy: 4, r: 0.6, fill: 'currentColor' }),
        h('path', { d: 'M7 8.5l4.6 1.9-1.8.8-.8 1.8z', fill: 'currentColor' }),
      )
    }

    /**
     * Sidebar entry: the glyph plus a dot while any session waits for a person.
     *
     * It polls the overview route itself instead of sharing state with the panel
     * below, because the sidebar is mounted even when nobody ever opens that panel
     * — and the dot is the only discovery path for a request raised in a session
     * the human is not currently reading.
     */
    function SidebarEntry(props) {
      const { size, active, dict } = props
      const [waiting, setWaiting] = useState(0)
      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          try {
            const payload = await requestJson(SESSIONS_PATH)
            if (cancelled) return
            setWaiting(Array.isArray(payload?.pending) ? payload.pending.length : 0)
          } catch {
            /* cosmetic badge: a failed poll keeps the last known value */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), SIDEBAR_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(BrowserIcon, { size, active }),
        waiting > 0
          ? h('span', {
              title: dict.pending,
              style: {
                position: 'absolute',
                right: -3,
                top: -3,
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'var(--dsw-alias-state-warn-primary,#e0a020)',
              },
            })
          : null,
      )
    }

    /**
     * One session's tab in the host browser — the conversation-view surface.
     *
     * Mounted when the human selects the 浏览器 tab and unmounted when they leave
     * it, which is exactly the lifetime the focus protocol wants: mount asks the
     * host to bring this session's tab in front and stream it at full rate, and
     * unmount hands the foreground back. **Unmount never closes the tab** — the
     * browser belongs to the session, not to the panel.
     */
    function SessionPanel(props) {
      const { dict } = props
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : ''
      const canvasRef = useRef(null)
      const sinkRef = useRef(null)
      const socketRef = useRef(null)
      const bitmapRef = useRef(undefined)
      const decodingRef = useRef(false)
      const lastMoveRef = useRef(0)
      const [open, setOpen] = useState(undefined)
      const [connection, setConnection] = useState('idle')
      const [status, setStatus] = useState({})
      const [streamMode, setStreamMode] = useState(undefined)
      const [human, setHuman] = useState(undefined)
      const [failure, setFailure] = useState(undefined)
      const [hasFrame, setHasFrame] = useState(false)
      const [busy, setBusy] = useState(false)
      const [reply, setReply] = useState('')

      /**
       * Fold one normalized snapshot into render state.
       *
       * The functional setters keep object identities stable when nothing
       * changed, so the 2s poll cannot re-render the canvas away or fight a
       * half-typed reply.
       */
      const applySnapshot = useCallback((snapshot) => {
        if (snapshot === undefined || snapshot === null) return
        setOpen(snapshot.open === true)
        setStatus((current) =>
          current.running === snapshot.running && current.url === snapshot.url && current.title === snapshot.title
            ? current
            : { running: snapshot.running, url: snapshot.url, title: snapshot.title },
        )
        setHuman((current) => (sameHuman(current, snapshot.human) ? current : snapshot.human ?? undefined))
        setStreamMode((current) => {
          const next = snapshot.stream === 'screencast' || snapshot.stream === 'poll' ? snapshot.stream : undefined
          return current === next ? current : next
        })
      }, [])

      /** Paint one JPEG frame onto the canvas. */
      const paint = useCallback(async (buffer) => {
        const canvas = canvasRef.current
        if (canvas === null) return
        try {
          const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }))
          bitmapRef.current = bitmap
          setHasFrame(true)
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const context = canvas.getContext('2d')
          context.drawImage(bitmap, 0, 0)
          // A frame that paints is the proof that whatever failed has recovered:
          // a genuinely broken browser stops sending them, and the note stays.
          setFailure(undefined)
        } catch {
          /* a torn frame is not worth surfacing */
        }
      }, [])

      /** Send one panel message when the socket is open; otherwise do nothing. */
      const send = useCallback((message) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(message))
      }, [])

      /**
       * Map a pointer event to page viewport coordinates. The canvas paints one
       * full viewport at deviceScaleFactor 1, so its intrinsic size *is* the page
       * viewport — mapping through it stays correct even if the emulated viewport
       * is changed or cleared underneath us.
       */
      const toPageCoords = (event) => {
        const canvas = canvasRef.current
        if (canvas === null) return { x: 0, y: 0 }
        const rect = canvas.getBoundingClientRect()
        const scaleX = canvas.width / Math.max(1, rect.width)
        const scaleY = canvas.height / Math.max(1, rect.height)
        return { x: (event.clientX - rect.left) * scaleX, y: (event.clientY - rect.top) * scaleY }
      }

      /** Send one key and keep the keyboard sink focused for follow-up typing. */
      const pressKey = (spec, modifiers = []) => {
        send({ type: 'input', kind: 'key', event: 'down', ...spec, modifiers })
        send({ type: 'input', kind: 'key', event: 'up', ...spec, modifiers })
        sinkRef.current?.focus?.()
      }

      /**
       * The live channel of *this* session's tab.
       *
       * Reconnects with backoff while the panel is mounted, asks for `focus` on
       * (re)connect — the host then activates this tab and upgrades it to a
       * full-rate screencast — and seeds one frame with `play`, because a static
       * page produces no frames of its own. A session without a tab never opens a
       * socket at all.
       */
      useEffect(() => {
        if (sessionId === '' || open !== true) {
          setConnection('idle')
          return undefined
        }
        let disposed = false
        let attempt = 0
        let timer
        const clearTimer = () => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
        }
        const schedule = () => {
          if (disposed) return
          const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) + Math.round(Math.random() * 250)
          attempt += 1
          clearTimer()
          timer = setTimeout(connect, delay)
        }
        const connect = () => {
          if (disposed) return
          setConnection('connecting')
          const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
          let socket
          try {
            socket = new WebSocket(`${scheme}//${window.location.host}${STREAM_PATH}?session=${encodeURIComponent(sessionId)}`)
          } catch {
            schedule()
            return
          }
          socket.binaryType = 'arraybuffer'
          socketRef.current = socket
          socket.onopen = () => {
            if (disposed) {
              try {
                socket.close()
              } catch {
                /* already closing */
              }
              return
            }
            attempt = 0
            setConnection('live')
            setFailure(undefined)
            if (document.visibilityState !== 'hidden') socket.send(JSON.stringify({ type: 'focus' }))
            // A static page emits nothing by itself: ask for one frame.
            socket.send(JSON.stringify({ type: 'play' }))
          }
          socket.onclose = () => {
            if (socketRef.current === socket) socketRef.current = null
            if (disposed) return
            setConnection('offline')
            schedule()
          }
          socket.onerror = () => {
            /* `onclose` always follows and owns the reconnect */
          }
          socket.onmessage = (event) => {
            if (typeof event.data !== 'string') {
              if (decodingRef.current) return
              decodingRef.current = true
              void paint(event.data).finally(() => {
                decodingRef.current = false
              })
              return
            }
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message.type === 'hello') {
              const snapshot = snapshotFromState(message.status ?? {})
              if (message.human !== undefined && message.human !== null) snapshot.human = message.human
              snapshot.stream = message.mode === 'screencast' || message.mode === 'poll' ? message.mode : null
              applySnapshot(snapshot)
              return
            }
            if (message.type === 'state') {
              applySnapshot(snapshotFromMessage(message))
              return
            }
            if (message.type === 'stream') {
              setStreamMode(message.mode === 'screencast' || message.mode === 'poll' ? message.mode : undefined)
              return
            }
            if (message.type === 'human-request') {
              setHuman(message.request ?? undefined)
              return
            }
            if (message.type === 'human-done' || message.type === 'human-timeout') {
              setHuman((current) => (current !== undefined && current.id === message.id ? undefined : current))
              return
            }
            if (message.type === 'error') {
              setFailure(String(message.message ?? 'failed'))
              return
            }
            if (message.type === 'browser-stopped') {
              setFailure(undefined)
              setHasFrame(false)
            }
            // `sessions` overview messages belong to the sidebar panel, not here.
          }
        }
        connect()
        return () => {
          disposed = true
          clearTimer()
          const socket = socketRef.current
          socketRef.current = null
          if (socket !== null) {
            try {
              if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'blur' }))
            } catch {
              /* the socket may already be gone */
            }
            try {
              socket.close()
            } catch {
              /* already closed */
            }
          }
          setConnection('idle')
        }
      }, [sessionId, open, applySnapshot, paint])

      /**
       * State poll for everything the socket cannot tell us yet: whether this
       * session has a tab at all, and what it shows while the socket is down
       * (reconnecting, or the host restarted). It stays out of the way while the
       * socket is live, which pushes state itself.
       */
      useEffect(() => {
        if (sessionId === '') return undefined
        let cancelled = false
        const tick = async () => {
          const socket = socketRef.current
          if (socket !== null && socket.readyState === 1) return
          try {
            const payload = await requestJson(`${STATE_PATH}?session=${encodeURIComponent(sessionId)}`)
            if (cancelled) return
            applySnapshot(snapshotFromState(payload))
          } catch {
            /* the GUI may be reloading; the next tick recovers */
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), STATE_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [sessionId, applySnapshot])

      /**
       * The wheel must reach the page instead of scrolling the GUI behind the
       * canvas. React registers `wheel` passively at its root, where
       * `preventDefault()` is a no-op, so this one listener is attached natively.
       */
      useEffect(() => {
        if (open !== true) return undefined
        const canvas = canvasRef.current
        if (canvas === null || typeof canvas.addEventListener !== 'function') return undefined
        const onWheel = (event) => {
          event.preventDefault()
          const point = toPageCoords(event)
          send({ type: 'input', kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
        }
        canvas.addEventListener('wheel', onWheel, { passive: false })
        return () => canvas.removeEventListener('wheel', onWheel)
      }, [open, send, sessionId])

      // Focus the keyboard sink as soon as a picture exists, so typing works
      // without an extra click (a click also focuses it — see onPointerDown).
      useEffect(() => {
        if (open !== true) return undefined
        const timer = setTimeout(() => sinkRef.current?.focus?.(), 120)
        return () => clearTimeout(timer)
      }, [open])

      // A view request is the shell's way of saying "this view is now the target
      // of an openView() call"; consume it so the shell can clear it.
      useEffect(() => {
        if (props.viewRequest === undefined || props.viewRequest === null) return
        if (props.viewRequest.view !== PANEL_ID) return
        sinkRef.current?.focus?.()
        if (typeof props.completeViewRequest === 'function') props.completeViewRequest()
      }, [props.viewRequest])

      /** A human arriving (or leaving) the page changes whether we want frames. */
      useEffect(() => {
        if (sessionId === '') return undefined
        const onVisibility = () => {
          const socket = socketRef.current
          if (socket === null || socket.readyState !== 1) return
          if (document.visibilityState === 'hidden') socket.send(JSON.stringify({ type: 'blur' }))
          else {
            socket.send(JSON.stringify({ type: 'focus' }))
            socket.send(JSON.stringify({ type: 'play' }))
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [sessionId])

      /**
       * Answer a takeover request: over the socket when it is open, otherwise over
       * the HTTP endpoint, so a request can still be settled while the picture is
       * reconnecting.
       */
      const sendOrPost = (message, body) => {
        const socket = socketRef.current
        if (socket !== null && socket.readyState === 1) {
          socket.send(JSON.stringify(message))
          return
        }
        void requestJson(DONE_PATH, { method: 'POST', body }).catch(() => {})
      }

      /** 「我已完成」: settle the pending request without a reply. */
      const finishHuman = () => {
        const requestId = human?.id
        if (requestId === undefined) return
        sendOrPost({ type: 'human-done', requestId }, { id: requestId })
        setHuman(undefined)
      }

      /** Reply: settles the request with a note the waiting tool call receives. */
      const submitReply = () => {
        const requestId = human?.id
        const text = reply.trim()
        if (requestId === undefined || text === '') return
        sendOrPost({ type: 'human-reply', requestId, text }, { id: requestId, text })
        setReply('')
        setHuman(undefined)
      }

      /** Empty state: open this session's tab, then let the socket take over. */
      const openBrowser = async () => {
        if (sessionId === '') return
        setBusy(true)
        try {
          const payload = await requestJson(OPEN_PATH, { method: 'POST', body: { sessionId } })
          applySnapshot(snapshotFromState(payload))
          setFailure(undefined)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      /** Toolbar close: discards the page, so it always asks first. */
      const closeTab = async () => {
        if (sessionId === '') return
        if (typeof window.confirm === 'function' && !window.confirm(dict.closeTabConfirm)) return
        setBusy(true)
        try {
          await requestJson(CLOSE_PATH, { method: 'POST', body: { sessionId } })
          setHasFrame(false)
          setFailure(undefined)
          applySnapshot({ open: false, running: status.running !== false, url: null, title: null, human: null, stream: null })
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const onPointerDown = (event) => {
        sinkRef.current?.focus?.()
        canvasRef.current?.setPointerCapture?.(event.pointerId)
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'down', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerUp = (event) => {
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'up', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      }
      const onPointerMove = (event) => {
        const now = Date.now()
        if (now - lastMoveRef.current < MOVE_THROTTLE_MS) return
        lastMoveRef.current = now
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'move', x: point.x, y: point.y })
      }
      const onKeyDown = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special !== undefined) {
          event.preventDefault()
          send({
            type: 'input',
            kind: 'key',
            event: 'down',
            key: special.key,
            code: special.code,
            keyCode: special.keyCode,
            text: special.text,
            modifiers: modifiersOf(event),
          })
          return
        }
        // Everything else is typed: the sink's input event carries the glyph,
        // and IME composition arrives through compositionend.
      }
      const onKeyUp = (event) => {
        const special = SPECIAL_KEYS[event.key]
        if (special === undefined) return
        send({
          type: 'input',
          kind: 'key',
          event: 'up',
          key: special.key,
          code: special.code,
          keyCode: special.keyCode,
          modifiers: modifiersOf(event),
        })
      }
      const onInput = (event) => {
        const text = event.target.value
        event.target.value = ''
        if (text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onCompositionEnd = (event) => {
        const text = event.data
        if (typeof text === 'string' && text !== '') send({ type: 'input', kind: 'text', text })
      }
      const onPaste = (event) => {
        const text = event.clipboardData?.getData?.('text') ?? ''
        if (text !== '') {
          event.preventDefault()
          send({ type: 'input', kind: 'text', text })
        }
      }

      if (sessionId === '') {
        return h('div', { 'data-dsh-browser-panel': '' }, h('div', { className: 'dbp-notice' }, dict.noSession))
      }

      const url = typeof status.url === 'string' ? status.url : ''
      const title = typeof status.title === 'string' ? status.title : ''
      const running = status.running !== false
      const live = connection === 'live'
      const canType = live && open === true
      const dotState = open === true && live ? (running ? 'online' : 'offline') : connection === 'offline' ? 'offline' : ''
      // The status line carries the connection state; the downgrade to polled
      // stills only shows up as a subtle note, because it never blocks input.
      const barNote =
        open !== true
          ? ''
          : live
            ? streamMode === 'poll'
              ? dict.pollHint
              : dict.connected
            : connection === 'offline'
              ? dict.offline
              : dict.connecting
      // Typing/pointer help only makes sense once there is a picture to act on.
      const hint = open === true ? (live ? dict.instructions : barNote) : ''

      return h(
        'div',
        { 'data-dsh-browser-panel': '' },
        h(
          'div',
          { className: 'dbp-bar' },
          h('span', { className: 'dbp-dot', 'data-state': dotState }),
          h('span', { className: 'dbp-title', title: title !== '' ? title : dict.title }, title !== '' ? title : dict.title),
          h('span', { className: 'dbp-url', title: url }, url),
          barNote !== '' ? h('span', { className: 'dbp-note' }, barNote) : null,
        ),
        open === true
          ? h(
              'div',
              { className: 'dbp-tools' },
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.back, onClick: () => send({ type: 'nav', action: 'back' }) }, '←'),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.forward, onClick: () => send({ type: 'nav', action: 'forward' }) }, '→'),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.reload, onClick: () => send({ type: 'nav', action: 'reload' }) }, '⟳'),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.refresh, onClick: () => send({ type: 'play' }) }, '❐'),
              h('span', { className: 'dbp-spacer' }),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.tab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }) }, '⇥ Tab'),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.shiftTab, onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }, ['shift']) }, '⇤ ⇧Tab'),
              h('button', { type: 'button', className: 'dbp-btn', disabled: !canType, title: dict.enter, onClick: () => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }) }, '⏎ Enter'),
              h('span', { className: 'dbp-spacer' }),
              h('button', { type: 'button', className: 'dbp-btn dbp-danger', disabled: busy, title: dict.closeTabTitle, onClick: () => void closeTab() }, dict.closeTab),
            )
          : null,
        human !== undefined
          ? h(
              'div',
              { className: 'dbp-banner' },
              h('strong', null, `${dict.humanTitle}：`),
              h('span', { className: 'dbp-grow' }, human.instruction),
              h('input', {
                className: 'dbp-reply',
                value: reply,
                placeholder: dict.replyPlaceholder,
                onChange: (event) => setReply(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  submitReply()
                },
              }),
              h('button', { type: 'button', className: 'dbp-primary', disabled: reply.trim() === '', onClick: submitReply }, dict.reply),
              h('button', { type: 'button', className: 'dbp-primary', title: dict.humanHint, onClick: finishHuman }, dict.humanDone),
            )
          : null,
        h(
          'div',
          { className: 'dbp-stage' },
          open === true
            ? h('canvas', {
                ref: canvasRef,
                className: 'dbp-canvas',
                tabIndex: 0,
                onPointerDown,
                onPointerUp,
                onPointerMove,
                onFocus: () => sinkRef.current?.focus?.(),
              })
            : null,
          open === true
            ? h('textarea', {
                ref: sinkRef,
                className: 'dbp-sink',
                'aria-label': 'browser panel keyboard sink',
                onInput,
                onKeyDown,
                onKeyUp,
                onCompositionEnd,
                onPaste,
              })
            : null,
          open === true && failure !== undefined ? h('div', { className: 'dbp-overlay' }, `${dict.failed}：${failure}`) : null,
          open === true && failure === undefined && running === false ? h('div', { className: 'dbp-overlay' }, dict.stopped) : null,
          open === true && failure === undefined && running && !hasFrame && live ? h('div', { className: 'dbp-overlay' }, dict.waitingFrame) : null,
          open === undefined ? h('div', { className: 'dbp-empty' }, h('div', { className: 'dbp-empty-note' }, dict.checking)) : null,
          open === false
            ? h(
                'div',
                { className: 'dbp-empty' },
                h('div', { className: 'dbp-empty-title' }, dict.empty),
                h('div', { className: 'dbp-empty-note' }, dict.emptyHint),
                h('button', { type: 'button', className: 'dbp-primary', disabled: busy, onClick: () => void openBrowser() }, busy ? dict.starting : dict.open),
                failure !== undefined ? h('div', { className: 'dbp-empty-error' }, `${dict.openFailed}：${failure}`) : null,
              )
            : null,
          hint !== '' ? h('div', { className: 'dbp-hint' }, hint) : null,
        ),
      )
    }

    /**
     * The sidebar entry's body: every tab the host browser currently has.
     *
     * Root-scoped on purpose — it describes the whole host, not one conversation —
     * and it is not a browser canvas: each canvas belongs to the session that owns
     * the tab, which is what the `conversation.view` tab is for.
     */
    function Overview(props) {
      const { dict } = props
      const [data, setData] = useState(undefined)
      const [failure, setFailure] = useState(undefined)
      const [busy, setBusy] = useState(undefined)
      const aliveRef = useRef(true)

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const payload = await requestJson(SESSIONS_PATH)
          if (!aliveRef.current) return
          setData({
            running: payload?.running === true,
            sessions: Array.isArray(payload?.sessions) ? payload.sessions : [],
            pending: Array.isArray(payload?.pending) ? payload.pending : [],
            watched: typeof payload?.watched === 'string' ? payload.watched : null,
          })
          setFailure(undefined)
        } catch (error) {
          if (aliveRef.current) setFailure(String(error?.message ?? error))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), OVERVIEW_POLL_MS)
        return () => clearInterval(timer)
      }, [load])

      /** Close one row's tab. It discards the page, so it asks first. */
      const closeRow = async (sessionId, name) => {
        const question = dict.closeRowConfirm.replace('{name}', name)
        if (typeof window.confirm === 'function' && !window.confirm(question)) return
        setBusy(sessionId)
        try {
          await requestJson(CLOSE_PATH, { method: 'POST', body: { sessionId } })
          setFailure(undefined)
        } catch (error) {
          setFailure(String(error?.message ?? error))
        } finally {
          setBusy(undefined)
          void load()
        }
      }

      const sessions = data?.sessions ?? []
      const pendingIds = new Set((data?.pending ?? []).map((entry) => entry?.sessionId))

      let body
      if (data === undefined) {
        body = h('div', { className: 'dbo-empty' }, failure !== undefined ? `${dict.failed}：${failure}` : dict.checking)
      } else if (sessions.length === 0) {
        body = h(
          'div',
          { className: 'dbo-empty' },
          h('div', { className: 'dbp-empty-title' }, dict.overviewEmpty),
          h('div', { className: 'dbp-empty-note' }, dict.overviewEmptyHint),
        )
      } else {
        body = h(
          'div',
          { className: 'dbo-list' },
          sessions.map((session) => {
            const id = typeof session?.id === 'string' ? session.id : ''
            const label =
              (typeof session?.title === 'string' && session.title !== '' ? session.title : undefined) ??
              (typeof session?.label === 'string' && session.label !== '' ? session.label : undefined) ??
              id
            const url = typeof session?.url === 'string' && session.url !== '' ? session.url : dict.noUrl
            return h(
              'div',
              { className: 'dbo-row', key: id },
              h(
                'div',
                { className: 'dbo-main' },
                h(
                  'div',
                  { className: 'dbo-name' },
                  h('span', { className: 'dbo-name-text', title: label }, label),
                  pendingIds.has(id) ? h('span', { className: 'dbo-badge' }, dict.pending) : null,
                  session?.watched === true ? h('span', { className: 'dbo-watched' }, dict.watched) : null,
                ),
                h('div', { className: 'dbo-url', title: url }, url),
                h('div', { className: 'dbo-meta' }, `${dict.lastUsed} ${formatAgo(session?.lastUsedAt, dict)}`),
              ),
              h(
                'button',
                { type: 'button', className: 'dbp-btn dbp-danger', disabled: busy === id, onClick: () => void closeRow(id, label) },
                dict.closeRow,
              ),
            )
          }),
        )
      }

      return h(
        'div',
        { 'data-dsh-browser-panel': '' },
        h(
          'div',
          { className: 'dbo-head' },
          h('span', null, dict.overviewTitle),
          data !== undefined ? h('span', { className: 'dbo-count' }, String(sessions.length)) : null,
          h('span', { className: 'dbp-spacer' }),
          data !== undefined && data.running === false ? h('span', { className: 'dbo-count' }, dict.stopped) : null,
        ),
        body,
        failure !== undefined && data !== undefined ? h('div', { className: 'dbo-hint' }, `${dict.failed}：${failure}`) : null,
        h('div', { className: 'dbo-hint' }, dict.overviewHint),
      )
    }

    /**
     * Mount the three surfaces: styles, the session view tab, the sidebar entry
     * and the overview panel behind it.
     *
     * @param ctx - the client context provided by the DSH web runtime.
     */
    function apply(ctx) {
      const dict = pickDict(typeof navigator !== 'undefined' ? navigator.language : 'en')

      // Styles: inserted once per plugin activation and removed with the fiber.
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-browser-panel'
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(() => () => style.remove())

      // Slot declarations arrive with their owning plugin's fiber, which may
      // mount after this one: `slots.inject` waits for the declaration instead
      // of failing registration.
      const disposers = []
      const track = (dispose) => {
        if (typeof dispose === 'function') disposers.push(dispose)
      }
      try {
        // 1) The primary surface: one tab per session, inside the session page.
        //    The slot entry is session-scoped, so `sessionId` identifies the very
        //    browser tab this panel must show.
        track(
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: PANEL_ID,
                order: 40,
                label: () => dict.title,
                inject: (sessionId) => ({ sessionId: typeof sessionId === 'string' ? sessionId : null }),
              },
              (props) => h(SessionPanel, { ...props, dict }),
            ),
          ),
        )
        // 2) The sidebar entry: glyph, plus a dot while a session waits for a human.
        track(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => dict.title },
              (props) => h(SidebarEntry, { ...props, dict }),
            ),
          ),
        )
        // 3) The entry's body. `ctx.layout.selectPanel(id)` refuses an id without a
        //    keyed `main` entry, so the sidebar row needs one; it renders the
        //    host-wide overview, never a canvas (the canvas is per session and
        //    lives in the view tab above).
        track(
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, (props) => h(Overview, { ...props, dict })),
          ),
        )
      } catch (error) {
        console.warn('[dsh-browser-panel] slot registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) dispose()
      })
    }

    const exports = { apply, inject: ['slots'] }
    return exports
  },
})
