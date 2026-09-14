/**
 * HTTP and WebSocket routes the DSH Web UI talks to.
 *
 * Everything mounts on the DSH host webserver's own origin, and every route runs
 * the same guard the Web UI itself uses (`connection.requestRejection`): the
 * browser panel is exactly as reachable — and exactly as protected — as the GUI
 * it lives in. No extra port, no separate token, no tunnel.
 *
 * @module dsh-browser-panel/routes
 */

/** Base path of every route this plugin owns. */
export const BASE_PATH = '/api/dsh-browser-panel'

/** Maximum accepted JSON body for the small control endpoints. */
const MAX_BODY_BYTES = 64 * 1024

/** Write a JSON response. */
export function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Read a small JSON request body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Reject an unauthenticated request with the same codes the GUI uses.
 *
 * The `connection` service object is passed in rather than read from `ctx`:
 * Cordis forbids reaching a service through the context proxy unless the plugin
 * declared it in `inject`, and this plugin keeps web services optional.
 */
function rejected(connection, req, res) {
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

/**
 * Build the plugin's plain HTTP routes.
 *
 * @param deps - context, browser manager, human broker, screencast hub.
 * @returns webserver route objects (registered by the caller inside an effect).
 */
export function makeRoutes({ connection, manager, human, hub, version }) {
  const state = async () => {
    const status = await manager.status()
    return {
      ...status,
      version,
      human: human.snapshot(),
      panels: hub.connections.size,
      streaming: hub.streaming,
      framesDropped: hub.framesDropped,
    }
  }

  return [
    {
      kind: 'exact',
      path: `${BASE_PATH}/state`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if ((req.method ?? 'GET') !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          writeJson(res, 200, await state())
        } catch (error) {
          writeJson(res, 500, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/human-done`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const settled = human.done(body.id, body.text !== undefined ? { reply: String(body.text) } : {})
          writeJson(res, settled ? 200 : 409, { ok: settled })
        } catch (error) {
          writeJson(res, 400, { error: error.message })
        }
      },
    },
    {
      kind: 'exact',
      path: `${BASE_PATH}/health`,
      handler: async (req, res) => {
        if (rejected(connection, req, res)) return
        const status = await manager.status()
        writeJson(res, 200, {
          ok: true,
          version,
          executable: manager.executable,
          mode: manager.mode,
          running: status.running,
          profileDir: manager.profileDir(),
        })
      },
    },
  ]
}

/**
 * Build the screencast/input upgrade route.
 *
 * @param deps - context and screencast hub.
 * @returns an upgrade route object, or undefined when the optional `ws` acceptance fails.
 */
export function makeUpgradeRoute({ connection, hub }) {
  return {
    path: `${BASE_PATH}/stream`,
    handler: (req, socket) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        socket.write(
          `HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
        )
        socket.destroy()
        return
      }
      // Imported lazily so a broken upgrade never affects plugin load.
      import('./ws.js')
        .then(({ acceptUpgrade }) => {
          acceptUpgrade(req, socket, undefined, (connection) => {
            void hub.attach(connection)
          })
        })
        .catch(() => socket.destroy())
    },
  }
}
