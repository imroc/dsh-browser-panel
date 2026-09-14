/**
 * dsh-browser-panel — browser half.
 *
 * Mounts two surfaces into the DSH Web UI:
 * - a sidebar entry (icon + label) that opens
 * - the browser panel in the centre column: a live JPEG screencast of the host
 *   browser, with the human's mouse/keyboard replayed into the same CDP session
 *   the AI drives, plus the hand-over banner used by `browser_panel_ask_human`.
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

    /** Panel id: the sidebar entry id and the `main` slot key must agree. */
    const PANEL_ID = 'browser-panel'
    const BASE = '/api/dsh-browser-panel'
    const STREAM_PATH = `${BASE}/stream`
    const STATE_PATH = `${BASE}/state`
    const DONE_PATH = `${BASE}/human-done`

    /** Copy for both shipped locales. */
    const DICT = {
      zh: {
        title: '浏览器',
        tooltip: '共享浏览器：AI 与你操作同一个页面',
        back: '后退',
        forward: '前进',
        reload: '刷新',
        refresh: '重绘',
        close: '关闭浏览器',
        connecting: '连接中…',
        connected: '已连接',
        offline: '未连接',
        stopped: '浏览器未启动',
        failed: '浏览器启动失败',
        empty: '面板已连接，浏览器即将就绪…',
        humanTitle: '需要你操作',
        humanDone: '我已完成',
        humanHint: '完成上方操作后点此按钮，AI 会接着往下做。',
        instructions: '点面板任意处即可聚焦，然后直接用键盘/输入法打字（登录页常用）；表单还可以用工具栏的 Tab / Enter 逐项跳转提交。AI 看到的是同一个页面。',
        tab: '把焦点移到下一个可输入元素（免鼠标定位）',
        shiftTab: '焦点移到上一个元素',
        enter: '回车（提交 / 确认）',
      },
      en: {
        title: 'Browser',
        tooltip: 'Shared browser: you and the AI act on the same page',
        back: 'Back',
        forward: 'Forward',
        reload: 'Reload',
        refresh: 'Repaint',
        close: 'Stop browser',
        connecting: 'Connecting…',
        connected: 'Connected',
        offline: 'Disconnected',
        stopped: 'Browser not running',
        failed: 'Browser failed to start',
        empty: 'Panel attached — the browser is starting…',
        humanTitle: 'Your turn',
        humanDone: 'Done',
        humanHint: 'Finish the step above, then press this — the AI continues from there.',
        instructions: 'Click anywhere in the panel to focus it, then type with your keyboard or IME (handy for logins); use the Tab / Enter buttons to walk a form without aiming the mouse. The AI sees the same page.',
        tab: 'Move focus to the next field (no mouse aiming needed)',
        shiftTab: 'Move focus to the previous element',
        enter: 'Enter (submit / confirm)',
      },
    }

    /** Pick the dictionary that matches the GUI language. */
    function pickDict(locale) {
      const code = String(locale ?? '').toLowerCase()
      return code.startsWith('zh') ? DICT.zh : DICT.en
    }

    /** Stylesheet, scoped by data attribute; colours follow the host theme. */
    const CSS = `
      [data-dsh-browser-panel]{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#111);color:var(--dsw-alias-label-primary,#eee)}
      [data-dsh-browser-panel] .dbp-bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));background:var(--dsw-alias-bg-layer-1,transparent);font-size:12.5px}
      [data-dsh-browser-panel] .dbp-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary,#e0a020);flex:none}
      [data-dsh-browser-panel] .dbp-dot[data-state="online"]{background:var(--dsw-alias-state-success-primary,#3ecf8e)}
      [data-dsh-browser-panel] .dbp-dot[data-state="offline"]{background:var(--dsw-alias-state-error-primary,#e5484d)}
      [data-dsh-browser-panel] .dbp-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:38%}
      [data-dsh-browser-panel] .dbp-url{color:var(--dsw-alias-label-secondary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;font-variant-numeric:tabular-nums}
      [data-dsh-browser-panel] button.dbp-btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:inherit;border-radius:6px;padding:3px 9px;font-size:12.5px;cursor:pointer;flex:none}
      [data-dsh-browser-panel] button.dbp-btn:hover{background:var(--dsw-alias-bg-overlay,rgba(127,127,127,.18))}
      [data-dsh-browser-panel] button.dbp-btn:disabled{opacity:.45;cursor:default}
      [data-dsh-browser-panel] .dbp-banner{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--dsw-alias-bg-overlay,rgba(224,160,32,.16));border-bottom:1px solid var(--dsw-alias-state-warn-primary,#e0a020);font-size:13px}
      [data-dsh-browser-panel] .dbp-banner strong{color:var(--dsw-alias-state-warn-primary,#e0a020)}
      [data-dsh-browser-panel] .dbp-banner .dbp-grow{flex:1;min-width:0}
      [data-dsh-browser-panel] .dbp-banner button{border:0;border-radius:6px;padding:5px 14px;font-size:13px;font-weight:600;cursor:pointer;background:var(--dsw-alias-brand-primary,#3b82f6);color:#fff;flex:none}
      [data-dsh-browser-panel] .dbp-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--dsw-alias-bg-base,#0b0b0b)}
      [data-dsh-browser-panel] canvas.dbp-canvas{display:block;max-width:100%;max-height:100%;outline:none;cursor:default;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}
      [data-dsh-browser-panel] .dbp-hint{position:absolute;left:12px;right:12px;bottom:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#999);pointer-events:none}
      [data-dsh-browser-panel] .dbp-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary,#999);font-size:13px;text-align:center;padding:24px;pointer-events:none}
      [data-dsh-browser-panel] .dbp-sink{position:absolute;opacity:0;width:1px;height:1px;border:0;padding:0;resize:none;left:0;top:0}
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

    /** Tiny external store shared by the sidebar entry and the panel. */
    function createStore() {
      let state = { human: undefined, status: {}, locale: undefined }
      const listeners = new Set()
      return {
        get: () => state,
        set: (patch) => {
          state = { ...state, ...patch }
          for (const listener of [...listeners]) listener()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    /** Subscribe a component to the shared store. */
    function useStore(store) {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => store.subscribe(() => setSnapshot(store.get())), [store])
      return snapshot
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

    /** Sidebar entry: the icon plus a pending-action dot. */
    function SidebarEntry(props) {
      const { size, active, store } = props
      const snapshot = useStore(store)
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(BrowserIcon, { size, active }),
        snapshot.human !== undefined
          ? h('span', {
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
     * The panel itself: toolbar, hand-over banner, live canvas.
     */
    function BrowserPanel(props) {
      const { store, dict } = props
      const snapshot = useStore(store)
      const canvasRef = useRef(null)
      const sinkRef = useRef(null)
      const socketRef = useRef(null)
      const bitmapRef = useRef(undefined)
      const decodingRef = useRef(false)
      const lastMoveRef = useRef(0)
      const [connection, setConnection] = useState('connecting')
      const [failure, setFailure] = useState(undefined)
      const [hasFrame, setHasFrame] = useState(false)
      const [viewport, setViewport] = useState({ width: 1440, height: 900 })

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
        } catch {
          /* a torn frame is not worth surfacing */
        }
      }, [])

      /** Send one panel message when the socket is open. */
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

      useEffect(() => {
        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const socket = new WebSocket(`${scheme}//${window.location.host}${STREAM_PATH}`)
        socket.binaryType = 'arraybuffer'
        socketRef.current = socket
        setConnection('connecting')
        socket.onopen = () => setConnection('connected')
        socket.onclose = () => setConnection('offline')
        socket.onerror = () => setConnection('offline')
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
            if (message.viewport !== undefined) setViewport(message.viewport)
            // Ask for one frame immediately: a static page produces none by itself.
            socket.send(JSON.stringify({ type: 'play' }))
          }
          if (message.type === 'error') setFailure(String(message.message ?? 'failed'))
          if (message.type === 'browser-stopped') setFailure(undefined)
          if (message.type === 'reconnect') socket.send(JSON.stringify({ type: 'play' }))
        }
        return () => {
          socketRef.current = null
          try {
            socket.close()
          } catch {
            /* already closed */
          }
        }
      }, [paint])

      // Focus the keyboard sink as soon as the panel appears, so typing works
      // without an extra click.
      useEffect(() => {
        const timer = setTimeout(() => sinkRef.current?.focus?.(), 120)
        return () => clearTimeout(timer)
      }, [])

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
        if (now - lastMoveRef.current < 40) return
        lastMoveRef.current = now
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'mouse', event: 'move', x: point.x, y: point.y })
      }
      const onWheel = (event) => {
        event.preventDefault()
        const point = toPageCoords(event)
        send({ type: 'input', kind: 'wheel', x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY })
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

      const finished = (request) => {
        send({ type: 'human-done', requestId: request?.id })
        void fetch(DONE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: request?.id }),
        }).catch(() => {})
      }

      const status = snapshot.status ?? {}
      const state = connection === 'connected' ? (status.running === false ? 'offline' : 'online') : connection === 'offline' ? 'offline' : ''
      return h(
        'div',
        { 'data-dsh-browser-panel': '' },
        h(
          'div',
          { className: 'dbp-bar' },
          h('span', { className: 'dbp-dot', 'data-state': state }),
          h('span', { className: 'dbp-title' }, status.title ?? dict.title),
          h('span', { className: 'dbp-url' }, status.url ?? ''),
          h('button', { className: 'dbp-btn', onClick: () => send({ type: 'nav', action: 'back' }), title: dict.back }, '←'),
          h('button', { className: 'dbp-btn', onClick: () => send({ type: 'nav', action: 'forward' }), title: dict.forward }, '→'),
          h('button', { className: 'dbp-btn', onClick: () => send({ type: 'nav', action: 'reload' }), title: dict.reload }, '⟳'),
          h('button', { className: 'dbp-btn', onClick: () => send({ type: 'play' }), title: dict.refresh }, '❐'),
          h('button', { className: 'dbp-btn', onClick: () => pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }), title: dict.tab }, '⇥ Tab'),
          h('button', {
            className: 'dbp-btn',
            onClick: () => {
              pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 }, ['shift'])
            },
            title: dict.shiftTab,
          }, '⇤ ⇧Tab'),
          h('button', {
            className: 'dbp-btn',
            onClick: () => pressKey({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }),
            title: dict.enter,
          }, '⏎ Enter'),
        ),
        snapshot.human !== undefined
          ? h(
              'div',
              { className: 'dbp-banner' },
              h('strong', null, `${dict.humanTitle}：`),
              h('span', { className: 'dbp-grow' }, snapshot.human.instruction),
              h('button', { onClick: () => finished(snapshot.human) }, dict.humanDone),
            )
          : null,
        h(
          'div',
          { className: 'dbp-stage' },
          h('canvas', {
            ref: canvasRef,
            className: 'dbp-canvas',
            tabIndex: 0,
            onPointerDown,
            onPointerUp,
            onPointerMove,
            onWheel,
            onFocus: () => sinkRef.current?.focus?.(),
          }),
          h('textarea', {
            ref: sinkRef,
            className: 'dbp-sink',
            'aria-label': 'browser panel keyboard sink',
            onInput,
            onKeyDown,
            onKeyUp,
            onCompositionEnd,
            onPaste,
          }),
          failure !== undefined
            ? h('div', { className: 'dbp-overlay' }, `${dict.failed}：${failure}`)
            : status.running === false
            ? h('div', { className: 'dbp-overlay' }, dict.stopped)
            : !hasFrame && connection === 'connected'
              ? h('div', { className: 'dbp-overlay' }, dict.empty)
              : null,
          connection !== 'connected' ? h('div', { className: 'dbp-hint' }, connection === 'offline' ? dict.offline : dict.connecting) : h('div', { className: 'dbp-hint' }, dict.instructions),
        ),
      )
    }

    /**
     * Mount the panel: styles, state poller, sidebar entry, centre panel.
     * @param ctx - the client context provided by the DSH web runtime.
     */
    function apply(ctx) {
      const dict = pickDict(typeof navigator !== 'undefined' ? navigator.language : 'en')
      const store = createStore()
      store.set({ locale: dict === DICT.zh ? 'zh' : 'en' })

      // Styles: inserted once per plugin activation and removed with the fiber.
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-browser-panel'
      style.textContent = CSS
      document.head.append(style)
      ctx.effect(() => () => style.remove())

      /** Ask the layout controller to foreground this panel. */
      const openPanel = () => {
        try {
          ctx.get('layout')?.selectPanel?.(PANEL_ID)
        } catch {
          /* the panel may not be registered yet; the sidebar entry still works */
        }
      }

      // Poll the host: pending human requests drive the banner, the badge and
      // the automatic foreground switch.
      let lastHuman
      const poll = async () => {
        try {
          const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' } })
          if (!response.ok) return
          const state = await response.json()
          store.set({ status: state, human: state.human })
          const id = state.human?.id
          if (id !== undefined && id !== lastHuman) {
            lastHuman = id
            openPanel()
          }
          if (id === undefined) lastHuman = undefined
        } catch {
          /* offline GUI: the panel shows its own connection state */
        }
      }
      void poll()
      const timer = setInterval(() => void poll(), 5000)
      ctx.effect(() => () => clearInterval(timer))

      // Slot declarations arrive with their owning plugin's fiber, which may
      // mount after this one: `slots.inject` waits for the declaration instead
      // of failing registration.
      const disposers = []
      const track = (dispose) => {
        disposers.push(dispose)
      }
      try {
        track(
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => pickDict(navigator.language).tooltip },
              (props) => h(SidebarEntry, { size: props?.size, active: props?.active, store }),
            ),
          ),
        )
        track(ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(BrowserPanel, { store, dict }))))
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
