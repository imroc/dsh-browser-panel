/**
 * Human-in-the-loop broker.
 *
 * The AI can hand the shared browser over to the person in front of the DSH Web
 * UI — logging in, scanning a QR code, answering a CAPTCHA. The broker owns that
 * hand-over: one pending request at a time, surfaced to every panel connection,
 * resolved by the human's "done" click, the human typing a reply, or a timeout.
 *
 * @module dsh-browser-panel/human
 */

/** Monotonic request ids. */
let sequence = 0

/**
 * Tracks the single outstanding human request.
 */
export class HumanBroker {
  /**
   * @param options - change notifier plus the default timeout from config.
   */
  constructor({ onEvent } = {}) {
    this.pending = undefined
    this.onEvent = onEvent ?? (() => {})
    this.waiter = undefined
  }

  /** Current request in a JSON-safe shape for `/state` and the panel. */
  snapshot() {
    if (this.pending === undefined) return undefined
    const { id, instruction, createdAt, timeoutMs } = this.pending
    return { id, instruction, createdAt, timeoutMs, expiresAt: createdAt + timeoutMs }
  }

  /**
   * Ask the human to act, resolving when they confirm or the budget elapses.
   *
   * @param instruction - what to do, phrased for a person.
   * @param options - timeout budget in milliseconds.
   * @returns the outcome, including how long the human took.
   */
  ask(instruction, { timeoutMs = 600_000 } = {}) {
    if (this.pending !== undefined) this.cancel('superseded')
    const id = `human-${++sequence}`
    const createdAt = Date.now()
    this.pending = { id, instruction, createdAt, timeoutMs }
    this.onEvent({ type: 'human-request', request: this.snapshot() })
    const outcome = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = undefined
        this.pending = undefined
        this.onEvent({ type: 'human-timeout', id })
        resolve({ status: 'timeout', waitedMs: Date.now() - createdAt })
      }, timeoutMs)
      timer.unref?.()
      this.waiter = {
        id,
        resolve: (extra) => {
          clearTimeout(timer)
          resolve({ status: 'done', waitedMs: Date.now() - createdAt, ...extra })
        },
      }
    })
    return outcome
  }

  /**
   * Resolve the outstanding request.
   *
   * @param id - request id from the panel; a mismatched id is ignored.
   * @param extra - optional human-supplied reply or note.
   * @returns whether a request was actually settled.
   */
  done(id, extra = {}) {
    if (this.pending === undefined) return false
    if (id !== undefined && id !== this.pending.id) return false
    const waiter = this.waiter
    const request = this.pending
    this.pending = undefined
    this.waiter = undefined
    this.onEvent({ type: 'human-done', id: request.id })
    waiter?.resolve(extra)
    return true
  }

  /** Drop the outstanding request without a human action (plugin dispose, restart). */
  cancel(reason = 'cancelled') {
    if (this.pending === undefined) return false
    const waiter = this.waiter
    this.pending = undefined
    this.waiter = undefined
    waiter?.resolve({ status: reason })
    return true
  }
}
