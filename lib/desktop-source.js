/**
 * The standalone desktop source: read the Our Free Model desktop app's gateway.
 *
 * This is the product that predates the DSH plugin: a separate application that
 * serves an OpenAI-compatible gateway on `127.0.0.1:18900` plus a management RPC
 * for per-channel credits. It keeps its *own* account pool, so a user with both
 * products installed has two independent sets of balances — which is the whole
 * reason source selection exists.
 *
 * Symmetric with `plugin-source.js`: one module per product, each owning only
 * "how do I talk to this one". The arithmetic lives in `gateway.js` and is
 * shared by both.
 *
 * @module desktop-source
 */

import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, discoverChannels, probeAll } from './gateway.js'
import { fetchJson } from './gateway.js'

/**
 * Probe whether the desktop app is reachable *and* authenticated.
 *
 * The bearer key is required, not optional: this gateway answers 401 to an
 * unauthenticated `/v1/models` (measured — it is not an open loopback the way a
 * naive probe would assume). A probe without the key therefore reports
 * "credentials refused" for a perfectly healthy app, which is exactly the bug
 * found in the first live run of this feature.
 *
 * The two failure modes are kept distinct because they need different fixes:
 * "no key found" means the credential seam has nothing, "key refused" means the
 * app is up but the stored key is not the one it wants.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {number} timeoutMs Per-request deadline.
 * @param {string | undefined} apiKey Bearer token, when one was resolvable.
 * @returns {Promise<{available: boolean, reason?: string, channels?: number}>}
 */
export async function probeDesktopSource(baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 4000))
  try {
    const headers = typeof apiKey === 'string' && apiKey !== ''
      ? { authorization: `Bearer ${apiKey}` }
      : {}
    const response = await fetch(`${baseUrl}/v1/models`, { headers, signal: controller.signal })
    if (response.status === 401) {
      return {
        available: false,
        reason: typeof apiKey === 'string' && apiKey !== ''
          ? '网关在监听，但凭据被拒绝'
          : '网关在监听，但没有找到凭据',
      }
    }
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` }
    const body = await response.json().catch(() => undefined)
    const data = Array.isArray(body?.data) ? body.data : []
    const channels = new Set()
    for (const item of data) {
      if (typeof item?.channel === 'string') channels.add(item.channel)
    }
    return { available: true, channels: channels.size }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { available: false, reason: message.includes('abort') ? '连接超时' : '未监听' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Channels the desktop gateway advertises.
 *
 * Best-effort by design: a discovery failure keeps the caller's previous
 * inventory rather than collapsing the plan to nothing.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<string[]>} Channel ids, or an empty list on failure.
 */
export async function listDesktopChannels(baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    return await discoverChannels(baseUrl, apiKey, timeoutMs)
  } catch {
    return []
  }
}

/**
 * Read every channel's credits from the desktop gateway.
 *
 * Thin pass-through to `probeAll`, present so both sources expose the same
 * shape to `service.js` and the branch there stays one line.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token.
 * @param {string[]} channels Channels to read.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<import('./gateway.js').ChannelBalance[]>} Normalized rows.
 */
export function probeDesktopChannels(baseUrl, apiKey, channels, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return probeAll(baseUrl, apiKey, channels, timeoutMs)
}

/**
 * Channels with a logged-in account, from the desktop gateway.
 *
 * `provider.status` is the same bulk question the DSH plugin answers, and this
 * gateway speaks it identically (measured against a live 18900). One rule
 * therefore covers both products: a provider with `accounts.total > 0` is one
 * the card can read.
 *
 * Failure is reported as an empty list, which means "fall back to whatever else
 * already told us which channels exist" — never as an exception that would take
 * the whole probe cycle down.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token.
 * @param {string[]} catalogue Channel ids to ask about.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<string[]>} Channel ids with at least one account.
 */
export async function listDesktopAccounts(baseUrl, apiKey, catalogue, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const { body } = await fetchJson(
      `${baseUrl}/api/management/channels/rpc`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ method: 'provider.status', payload: { providers: catalogue } }),
      },
      timeoutMs,
    )
    const statuses = body?.ok === true ? body.value?.statuses : undefined
    if (statuses === undefined || typeof statuses !== 'object') return []
    const out = []
    for (const [provider, entry] of Object.entries(statuses)) {
      const total = entry?.accounts?.total
      if (typeof total === 'number' && total > 0) out.push(provider)
    }
    return out
  } catch {
    return []
  }
}
