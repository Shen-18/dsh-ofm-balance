/**
 * The in-DSH source: read the official Our Free Model plugin's credits through
 * the kernel's RPC channel.
 *
 * Why this is a channel and not a URL: the official plugin (`dsh-our-free-model`)
 * registers its management surface as a *Fetch route* on the kernel's
 * `connection` service, at path `/api/channel-pack`. That route is served by
 * `HostConnectionService.createSharedFetchHandler('/api')`, and it refuses any
 * caller whose Peer is not the owner — which is exactly why an HTTP request from
 * outside the app answers 401 and a same-process plugin does not.
 *
 * The wire envelope is the kernel's own (`type: 'client-request'`, `rpcId`,
 * `method`, `payload`), answered with `{ ok, value }`. `method` must equal the
 * endpoint spelled after the channel name, so `method: 'channel-pack'` is paired
 * with a path of `/api/channel-pack`.
 *
 * Credit payloads come back in the same `{ accounts: [{ accountId, nickname,
 * balance: { total, packages }, error }] }` shape the desktop gateway uses, so
 * normalization is shared: `normalizeChannel` from `gateway.js` consumes either
 * source unchanged. That is deliberate — one arithmetic implementation means the
 * denominator fixes (expired bundles, overlapping aggregates, no fabricated
 * 100%) apply to both.
 *
 * @module plugin-source
 */

import { normalizeChannel } from './gateway.js'

/** The Fetch-route path the official plugin registers. */
export const CHANNEL_PACK_PATH = '/api/channel-pack'

/** The RPC endpoint name (`method` on the envelope). */
export const CHANNEL_PACK_METHOD = 'channel-pack'

/**
 * Build the kernel RPC caller from a plugin context.
 *
 * Resolution is late-bound on every call: the `connection` service can be
 * published after this plugin loads (the kernel mounts it with the web server),
 * so reading it once at apply time would answer `undefined` forever.
 *
 * @param {object} ctx Host plugin context.
 * @returns {{call: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>} | undefined}
 */
export function makePluginRpc(ctx) {
  const readConnection = () => {
    try {
      return ctx?.get?.('connection') ?? ctx?.connection
    } catch {
      return undefined
    }
  }

  return {
    /**
     * Invoke one `channel-pack` method.
     * @param {string} method RPC method name (`credits.balances`, ...).
     * @param {unknown} payload Method payload.
     * @param {AbortSignal} [signal] Caller cancellation.
     * @returns {Promise<{ok: boolean, value?: unknown, error?: {message?: string, code?: string}}>}
     */
    async call(method, payload, signal) {
      const connection = readConnection()
      if (connection === undefined || connection === null) {
        throw new Error('connection service unavailable')
      }
      const handler = connection.createSharedFetchHandler('/api')
      const peer = connection.browserPeer
      if (handler === undefined || typeof handler.fetch !== 'function') {
        throw new Error('connection service has no shared fetch handler')
      }
      if (peer === undefined || peer === null) {
        throw new Error('connection service has no browser peer')
      }

      const envelope = {
        type: 'client-request',
        rpcId: `ofm-balance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        method: CHANNEL_PACK_METHOD,
        payload: { method, payload },
      }
      const request = new Request(`http://127.0.0.1${CHANNEL_PACK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
        signal,
      })
      const response = await handler.fetch(request, peer)
      if (response.status === 403 || response.status === 401) {
        throw new Error(`channel-pack refused (HTTP ${response.status})`)
      }
      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`channel-pack answered non-JSON (HTTP ${response.status})`)
      }
      // The kernel wraps the handler result in an envelope keyed by rpcId; the
      // official handler returns `{ ok, value }` as that result.
      const result = body?.result ?? body
      if (result?.ok === false) {
        throw new Error(result?.error?.message ?? result?.error?.code ?? 'channel-pack refused')
      }
      return result
    },
  }
}

/**
 * Probe whether the official plugin is mounted and answering.
 *
 * Uses a single cheap call: `account.list` with a provider the pack always
 * knows. Success means the Fetch route exists *and* the RPC handler behind it
 * works, which is the distinction that matters — the route can exist while the
 * pack is still `pending` or has `failed`.
 *
 * @param {{call: Function}|undefined} rpc The caller from {@link makePluginRpc}.
 * @returns {Promise<{available: boolean, reason?: string, channels?: string[]}>}
 */
/**
 * Probe whether the official plugin is mounted and answering.
 *
 * The cheap honest test is `provider.status` over a channel the pack always
 * knows: it succeeds only when the Fetch route exists *and* the handler behind
 * it works. That distinction matters — the route can exist while the pack is
 * still `pending` or has `failed`, in which case the card must fall back rather
 * than read a route that answers 404.
 *
 * Deliberately *not* `account.list`: that method takes a `provider` and returns
 * only that provider's accounts, so probing with one channel proves the route
 * works but says nothing about the others. `provider.status` is asked about the
 * catalogue instead, which is a different question (see
 * {@link listPluginChannels}).
 *
 * @param {{call: Function}|undefined} rpc The caller from {@link makePluginRpc}.
 * @param {string[]} catalogue Channel ids to ask about.
 * @returns {Promise<{available: boolean, reason?: string, channels?: string[]}>}
 */
export async function probePluginSource(rpc, catalogue = KNOWN_CHANNEL_IDS) {
  if (rpc === undefined) return { available: false, reason: '内核未提供 connection 服务' }
  try {
    const result = await rpc.call('provider.status', { providers: catalogue })
    const statuses = result?.value?.statuses
    if (statuses === undefined || typeof statuses !== 'object') {
      throw new Error('provider.status answered no statuses')
    }
    // Channels that have at least one account are the ones worth reading: a
    // provider with no account has no balance to report.
    const channels = []
    for (const [provider, status] of Object.entries(statuses)) {
      const total = status?.accounts?.total
      if (typeof total === 'number' && total > 0) channels.push(provider)
    }
    return { available: true, channels }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The pack's own channel catalogue.
 *
 * Duplicated from `channels.js` rather than imported, because `channels.js`
 * imports nothing host-specific and this module is imported by tests that must
 * not pull in the world. If the catalogue ever moves, both lists move together —
 * `channels.test.js` asserts the two agree.
 */
const KNOWN_CHANNEL_IDS = [
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'minimax',
  'zcode',
  'gemini',
]

/**
 * Read every channel's credits from the official plugin.
 *
 * Mirrors `probeAll` from `gateway.js`: one channel's failure becomes an error
 * row rather than failing the whole read, because a single vendor being down is
 * normal and must not blank the card.
 *
 * @param {{call: Function}} rpc The caller from {@link makePluginRpc}.
 * @param {string[]} channels Channel ids to read.
 * @param {number} [timeoutMs] Per-channel deadline.
 * @returns {Promise<import('./gateway.js').ChannelBalance[]>} Normalized rows.
 */
export async function probePluginChannels(rpc, channels, timeoutMs = 20_000) {
  const observedAt = Date.now()
  const rows = await Promise.all(
    channels.map(async (channel) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const result = await rpc.call('credits.balances', { provider: channel }, controller.signal)
        return normalizeChannel(channel, result?.value, Date.now())
      } catch (error) {
        return {
          channel,
          state: 'error',
          nicknames: [],
          packageCount: 0,
          packages: [],
          error: error instanceof Error ? error.message : String(error),
          observedAt,
        }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
  return rows
}

/**
 * Which channels the official plugin has logged in, across the whole catalogue.
 *
 * `provider.status` is the pack's own bulk question: hand it the channel ids and
 * it answers each one's account and model counts in a single round trip. That is
 * what makes it the right discovery call — `account.list` takes one provider at
 * a time, so using it here would mean thirteen calls and would still only see
 * the providers someone remembered to ask about.
 *
 * An empty answer is a valid state (nothing logged in yet) and must not be
 * confused with an unreachable plugin — {@link probePluginSource} makes that
 * distinction.
 *
 * @param {{call: Function}} rpc The caller from {@link makePluginRpc}.
 * @param {string[]} fallback Channel ids to use when enumeration yields nothing.
 * @returns {Promise<string[]>} Channel ids with at least one account.
 */
export async function listPluginChannels(rpc, fallback) {
  try {
    const result = await rpc.call('provider.status', { providers: KNOWN_CHANNEL_IDS })
    const statuses = result?.value?.statuses
    if (statuses !== undefined && typeof statuses === 'object') {
      const providers = []
      for (const [provider, status] of Object.entries(statuses)) {
        const total = status?.accounts?.total
        if (typeof total === 'number' && total > 0) providers.push(provider)
      }
      if (providers.length > 0) return providers
    }
  } catch {
    // Fall through: an enumeration failure is not a discovery failure.
  }
  return fallback
}
