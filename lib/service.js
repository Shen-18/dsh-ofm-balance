/**
 * Balance service: owns the cache, the poll loop, and the channel plan.
 *
 * Design constraints, all learned from measurement rather than assumption:
 *   - The cold path costs ~10.5s (the gateway fetches upstream balances) and
 *     the warm path ~0.3s, so the service is cache-first: a reader never waits
 *     on a live probe, and a failed probe keeps the last good numbers on
 *     screen instead of blanking the card.
 *   - `gemini` fails upstream whenever the machine cannot reach Google. It must
 *     render as one row saying so, must not fail the whole snapshot, and must
 *     recover on its own once the upstream is reachable again.
 *   - The API key is resolved host-side and never leaves this process; the
 *     browser only ever sees the normalized snapshot.
 *
 * The service owns no policy about *which* channels deserve a row — that lives
 * in `channels.js` — but it owns the plan built from that policy and the probe
 * fan-out it drives.
 *
 * @typedef {import('./gateway.js').BalanceSnapshot} BalanceSnapshot
 * @typedef {import('./gateway.js').ChannelBalance} ChannelBalance
 *
 * @typedef {object} ServiceOptions
 * @property {string} baseUrl Gateway origin.
 * @property {string} credentialRoute Provider route to resolve the key from.
 * @property {number} pollIntervalSec Poll cadence in seconds.
 * @property {number} timeoutMs Per-request deadline in milliseconds.
 * @property {readonly string[]} hiddenChannels Channels the user hid.
 * @property {readonly string[]} revealedChannels Unconfigured channels the user revealed.
 *
 * @typedef {object} CredentialReader
 * @property {(route: string) => Promise<string | undefined>} read Resolve a route's API key.
 *
 * @typedef {object} ProbeReport
 * @property {number} updatedAt Epoch ms the cycle finished.
 * @property {number} durationMs How long the cycle took.
 * @property {number} channelsProbed How many channels were attempted.
 * @property {number} channelsOk How many answered with a number.
 * @property {number} configuredChannels How many channels the profile declares.
 * @property {number} discoveredChannels How many the gateway advertises.
 * @property {string[]} warnings Non-fatal problems from the cycle.
 *
 * @module dsh-ofm-balance/service
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  discoverChannels,
  probeAll,
} from './gateway.js'
import { classifyChannels, mergePlanWithRows, channelsToProbe, KNOWN_CHANNELS } from './channels.js'
import { listPluginChannels, probePluginChannels } from './plugin-source.js'
import { listDesktopAccounts } from './desktop-source.js'


/**
 * How many consecutive "no credential" probes are treated as a cold start
 * rather than a misconfiguration.
 *
 * A normal boot resolves the seam well inside one second, so three attempts
 * (immediate, +1s, +1s) is generous. Past that, the user really has no key and
 * deserves a message instead of a spinner.
 */
const CREDENTIAL_GRACE_ATTEMPTS = 3

/**
 * The environment-variable name a route's key conventionally lives under.
 * @param {string} route Provider route key.
 * @returns {string} Upper-snake env name.
 */
function credentialEnvHint(route) {
  return route.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_API_KEY'
}

export class BalanceService {
  /**
   * @param {ServiceOptions} options Resolved settings for this activation.
   * @param {CredentialReader} credentials The credential seam to read through.
   */
  constructor(options, credentials) {
    this.options = options
    this.readCredential = credentials

    /**
     * The kernel-RPC caller for the in-DSH source, when that source is in play.
     * Undefined for a desktop-only configuration, so the desktop path keeps
     * working in compositions that have no `connection` service at all.
     * @type {{call: Function} | undefined}
     */
    this.pluginRpc = options.pluginRpc

    /**
     * Which source is being read (`plugin`, `desktop`), decided by discovery
     * and the user's choice. Undefined until the first probe resolves it.
     * @type {string | undefined}
     */
    this.source = options.source

    /** @type {BalanceSnapshot | undefined} */
    this.snapshot = undefined
    /** Channels the provider advertised last cycle. @type {string[]} */
    this.discovered = []
    /** Channels with at least one logged-in account. @type {string[]} */
    this.accounts = []
    /** @type {Promise<BalanceSnapshot> | undefined} */
    this.inflight = undefined
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.timer = undefined
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.credentialRetryTimer = undefined
    /** Consecutive probes that found no credential. @type {number} */
    this.credentialMisses = 0
    /** @type {ProbeReport | undefined} */
    this.lastReport = undefined
    /**
     * Channel the live conversation routes through. Written from session
     * events; undefined until a request announces its route.
     * @type {string | undefined}
     */
    this.currentChannel = undefined
    this.disposed = false
  }

  /**
   * The cached snapshot, or undefined before the first probe lands.
   * @returns {BalanceSnapshot | undefined} The last good snapshot.
   */
  current() {
    return this.snapshot
  }

  /**
   * The most recent probe timing/failure report.
   * @returns {ProbeReport | undefined} The last cycle's diagnostics.
   */
  report() {
    return this.lastReport
  }

  /**
   * The classification of every known channel, for the settings surface.
   * @returns {ReturnType<typeof classifyChannels>} The current plan.
   */
  plan() {
    return classifyChannels({
      // Channels with a logged-in account. This drives the "shown by default"
      // rule: a channel that cannot have a balance read is not worth a row, and
      // `credits.balances` only answers for a channel with an account. The
      // profile's declared model ids are deliberately NOT used — they are a
      // stale snapshot that keeps naming channels whose accounts are long gone.
      accounts: this.accounts,
      discovered: this.discovered,
      // The provider's full catalogue. Without it the plugin only ever sees the
      // channels that currently have routed models — every other vendor it
      // supports (a channel with no account logged in) would be invisible, and
      // the settings panel could not offer it at all.
      known: KNOWN_CHANNELS,
      hidden: this.options.hiddenChannels,
      revealed: this.options.revealedChannels,
    })
  }

  /**
   * Rows for the first paint, before any probe has answered.
   *
   * A cold gateway takes ~10s to report balances. Without this the card renders
   * an empty body for that whole window, which is indistinguishable from a
   * broken plugin — the user's own complaint. Emitting the plan with
   * "读取中…" rows means the card appears immediately with the right channels
   * and their names, and the numbers fill in when the probe lands.
   *
   * @returns {ChannelBalance[]} One pending row per visible channel.
   */
  pendingRows() {
    return this.plan()
      .filter((entry) => entry.visible)
      .map((entry) => ({
        channel: entry.id,
        state: 'pending',
        nicknames: [],
        packageCount: 0,
        packages: [],
        error: undefined,
        hasAccount: entry.hasAccount,
        warning: entry.warning,
      }))
  }

  /**
   * Adopt the channels that have a logged-in account.
   *
   * Reported by `provider.status` for whichever product is being read, so the
   * card reflects the accounts that actually exist rather than the profile's
   * model declarations. They also become the route-matching inventory: the
   * collapsed summary names the channel a conversation is using.
   *
   * @param {readonly string[]} channels Channel ids with at least one account.
   */
  setAccountChannels(channels) {
    this.accounts = [...channels]
    for (const id of channels) {
      if (!this.discovered.includes(id)) this.discovered.push(id)
    }
  }

  /**
   * Adopt the channel the conversation is using.
   *
   * The runtime reports a provider route plus a model id whose prefix names the
   * channel (`trae/deepseek-v4.1-flash` → `trae`). Only the prefix matters: the
   * channel is what this card groups by, and the model has no bearing on quota.
   * A route this card does not watch is ignored, so another provider's traffic
   * cannot light up a row.
   *
   * @param {unknown} provider Provider route id from the request header.
   * @param {unknown} model Model id from the request header.
   */
  noteRequestRoute(provider, model) {
    if (typeof provider !== 'string' || provider !== this.options.credentialRoute) return
    if (typeof model !== 'string') return
    const slash = model.indexOf('/')
    if (slash <= 0) return
    const channel = model.slice(0, slash)
    // Accept any known channel, including one the user hid: the current route
    // is a fact about the conversation, not a display preference.
    const known = new Set([...this.accounts, ...this.discovered, ...this.options.revealedChannels, ...KNOWN_CHANNELS])
    if (known.has(channel)) this.currentChannel = channel
  }

  /**
   * Retry soon because the credential seam was not ready.
   *
   * Deliberately short and one-shot: the seam resolves within a second or two
   * on a normal boot, and a repeating timer would keep re-probing a machine
   * whose credentials genuinely are absent. Once it succeeds, the normal poll
   * cadence takes over.
   */
  scheduleCredentialRetry() {
    if (this.disposed || this.credentialRetryTimer !== undefined) return
    this.credentialRetryTimer = setTimeout(() => {
      this.credentialRetryTimer = undefined
      if (this.disposed) return
      void this.refresh().catch(() => {})
    }, 1000)
    if (typeof this.credentialRetryTimer?.unref === 'function') this.credentialRetryTimer.unref()
  }

  /** Start the poll loop: one probe now, then on the configured interval. */
  start() {
    if (this.disposed) return
    void this.refresh().catch(() => {
      // A cold-start probe may fail (gateway not up yet); the next tick retries.
    })
    this.armTimer(this.options.pollIntervalSec)
  }

  /** Stop polling and drop the timer. */
  stop() {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    if (this.credentialRetryTimer !== undefined) {
      clearTimeout(this.credentialRetryTimer)
      this.credentialRetryTimer = undefined
    }
  }

  /**
   * Re-arm with new options in place, keeping the cache.
   *
   * A settings save reaches here. Reusing the instance is what keeps the last
   * known balances on screen while the new cadence takes effect; dropping the
   * service would blank the card for a whole poll cycle.
   *
   * @param {ServiceOptions} next The new settings.
   */
  applyOptions(next) {
    const baseChanged = next.baseUrl !== this.options.baseUrl
    const sourceChanged = next.source !== undefined && next.source !== this.source
    const rpcChanged = next.pluginRpc !== undefined && next.pluginRpc !== this.pluginRpc
    this.options = next
    if (next.pluginRpc !== undefined) this.pluginRpc = next.pluginRpc
    if (next.source !== undefined) this.source = next.source
    // A different transport invalidates the cached rows: the numbers on screen
    // came from the other product's accounts and would otherwise sit there
    // looking current.
    if (baseChanged || sourceChanged || rpcChanged) this.snapshot = undefined
    this.armTimer(next.pollIntervalSec)
    void this.refresh().catch(() => {})
  }

  /**
   * (Re)install the interval timer at the given cadence.
   * @param {number} seconds Poll interval in seconds.
   */
  armTimer(seconds) {
    if (this.disposed) return
    if (this.timer !== undefined) clearInterval(this.timer)
    const intervalMs = Math.max(30, seconds) * 1000
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {})
    }, intervalMs)
    // `unref` keeps the poll loop from holding the process open on shutdown.
    if (typeof this.timer?.unref === 'function') this.timer.unref()
  }

  /**
   * Refresh once. Concurrent callers share one in-flight probe, so a burst of
   * page loads cannot multiply the gateway requests.
   * @returns {Promise<BalanceSnapshot>} The fresh snapshot.
   */
  refresh() {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.probe().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /**
   * Run one full probe cycle and swap the snapshot in.
   * @returns {Promise<BalanceSnapshot>} The snapshot produced by this cycle.
   */
  async probe() {
    const startedAt = Date.now()
    /** @type {string[]} */
    const warnings = []

    // The in-DSH source reads the official plugin over the kernel's RPC channel
    // and needs no gateway credential at all: the plugin's own credential store
    // authenticates the accounts. Routing it before the credential read is what
    // makes the card work on a machine that has only the plugin installed.
    if (this.source === 'plugin') {
      return this.probeViaPlugin(startedAt, warnings)
    }

    // Neither product answered. Say exactly that instead of reporting a missing
    // API key: on a machine where the user installed the plugin but does not run
    // the desktop app, "缺少 OURFREEMODEL_API_KEY" points at the wrong problem.
    if (this.source === 'none') {
      const plan = this.plan()
      /** @type {BalanceSnapshot} */
      const snapshot = {
        updatedAt: startedAt,
        baseUrl: this.options.baseUrl,
        source: 'none',
        channels: plan
          .filter((entry) => entry.visible)
          .map((entry) => ({
            channel: entry.id,
            state: 'error',
            nicknames: [],
            packageCount: 0,
            packages: [],
            error: '未检测到数据源',
            hasAccount: entry.hasAccount,
            warning: entry.warning,
          })),
        warnings: ['未检测到可用的 Our Free Model：请安装官方插件，或启动桌面应用'],
        currentChannel: this.currentChannel,
      }
      this.snapshot = snapshot
      this.lastReport = {
        updatedAt: snapshot.updatedAt,
        durationMs: snapshot.updatedAt - startedAt,
        channelsProbed: 0,
        channelsOk: 0,
        accountChannels: this.accounts.length,
        discoveredChannels: this.discovered.length,
        warnings,
      }
      return snapshot
    }

    const apiKey = await this.readCredential.read(this.options.credentialRoute)
    if (apiKey === undefined || apiKey === '') {
      // The credential seam is not answering.
      //
      // On a fresh boot the host mounts plugins before the credential service
      // has resolved, so a probe in that window sees "no key". Treating that as
      // final is what produced the reported bug: the card stayed on "缺少凭据"
      // until the user clicked refresh, because the empty snapshot was cached
      // and the next attempt only came a full poll interval later.
      //
      // The two cases must be told apart, so this counts misses:
      //   - the first few are treated as "still starting" (pending rows, no
      //     cache, a fast retry), which lets a normal boot self-heal;
      //   - after that it is a real configuration problem and gets a cached
      //     snapshot with an actionable message, so the card stops spinning.
      this.credentialMisses += 1
      const stillStarting = this.credentialMisses <= CREDENTIAL_GRACE_ATTEMPTS
      const plan = this.plan()
      /** @type {BalanceSnapshot} */
      const snapshot = {
        updatedAt: startedAt,
        baseUrl: this.options.baseUrl,
        channels: plan
          .filter((entry) => entry.visible)
          .map((entry) => ({
            channel: entry.id,
            state: stillStarting ? 'pending' : 'error',
            nicknames: [],
            packageCount: 0,
            packages: [],
            error: stillStarting ? undefined : '未配置 API Key',
            hasAccount: entry.hasAccount,
            warning: entry.warning,
          })),
        warnings: stillStarting
          ? []
          : [`未找到 ${this.options.credentialRoute} 的凭据；请在 DSH 中配置 ${credentialEnvHint(this.options.credentialRoute)}`],
        currentChannel: this.currentChannel,
        credentialPending: stillStarting,
      }
      if (stillStarting) {
        // Not cached: the next reader re-probes, and a short timer recovers
        // without waiting for the poll interval.
        this.scheduleCredentialRetry()
        return snapshot
      }
      this.snapshot = snapshot
      return snapshot
    }

    // A successful read resets the grace window, so a later restart is treated
    // as a fresh cold start rather than escalating immediately.
    this.credentialMisses = 0

    // Discovery is best-effort: a failure keeps the previous inventory rather
    // than collapsing the plan to nothing.
    try {
      const advertised = await discoverChannels(this.options.baseUrl, apiKey, this.options.timeoutMs)
      if (advertised.length > 0) this.discovered = mergeIds(advertised, this.discovered)
    } catch (error) {
      warnings.push(`渠道发现失败：${error instanceof Error ? error.message : String(error)}`)
    }

    // Which channels actually have an account. This is the authority for what
    // the card shows: `credits.balances` answers only for a channel with one,
    // and the profile's declared model ids are a stale snapshot that keeps
    // naming channels whose accounts are gone.
    try {
      const withAccounts = await listDesktopAccounts(
        this.options.baseUrl,
        apiKey,
        KNOWN_CHANNELS,
        this.options.timeoutMs,
      )
      if (withAccounts.length > 0) this.setAccountChannels(withAccounts)
    } catch (error) {
      warnings.push(`账号发现失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const plan = this.plan()
    const targets = channelsToProbe(plan)
    const probed = await probeAll(this.options.baseUrl, apiKey, targets, this.options.timeoutMs)
    const rows = mergePlanWithRows(plan, probed)

    /** @type {BalanceSnapshot} */
    const snapshot = {
      updatedAt: Date.now(),
      baseUrl: this.options.baseUrl,
      // Carried so the card and the diagnostics can say which product these
      // numbers came from. Without it the desktop path is indistinguishable
      // from a default, and "why does trae show 4800 here but 1 account in the
      // plugin" has no answer on screen.
      source: 'desktop',
      channels: rows,
      warnings,
      currentChannel: this.currentChannel,
    }
    this.snapshot = snapshot
    this.lastReport = {
      updatedAt: snapshot.updatedAt,
      durationMs: snapshot.updatedAt - startedAt,
      channelsProbed: targets.length,
      channelsOk: rows.filter((c) => c.state === 'ok').length,
      accountChannels: this.accounts.length,
      discoveredChannels: this.discovered.length,
      warnings,
    }
    return snapshot
  }

  /**
   * One probe cycle against the in-DSH official plugin.
   *
   * Shares `plan()`, `channelsToProbe`, `mergePlanWithRows` and
   * `normalizeChannel` with the desktop path: only the transport differs. That
   * is deliberate — the two sources report the same credit payload, so keeping
   * one arithmetic implementation means the denominator rules (expired bundles
   * excluded, overlapping aggregate not double-counted, never a fabricated
   * 100%) hold for both.
   *
   * Discovery asks the plugin's account list rather than `/v1/models`, because
   * the pack's channel inventory *is* its account list: a provider with no
   * logged-in account has nothing to report.
   *
   * @param {number} startedAt Epoch ms this cycle began.
   * @param {string[]} warnings Collector for non-fatal problems.
   * @returns {Promise<BalanceSnapshot>} The snapshot produced by this cycle.
   */
  async probeViaPlugin(startedAt, warnings) {
    if (this.pluginRpc === undefined) {
      /** @type {BalanceSnapshot} */
      const snapshot = {
        updatedAt: startedAt,
        baseUrl: 'plugin',
        channels: this.pendingRows().map((row) => ({ ...row, state: 'error', error: '未连接到 DSH 插件' })),
        warnings: ['未连接到 DSH 插件：内核未提供 connection 服务'],
        currentChannel: this.currentChannel,
      }
      this.snapshot = snapshot
      return snapshot
    }

    try {
      const advertised = await listPluginChannels(this.pluginRpc, KNOWN_CHANNELS)
      if (advertised.length > 0) {
        this.setAccountChannels(advertised)
        this.discovered = mergeIds(advertised, this.discovered)
      }
    } catch (error) {
      warnings.push(`渠道发现失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const plan = this.plan()
    const targets = channelsToProbe(plan)
    const probed = await probePluginChannels(this.pluginRpc, targets, this.options.timeoutMs)
    const rows = mergePlanWithRows(plan, probed)

    /** @type {BalanceSnapshot} */
    const snapshot = {
      updatedAt: Date.now(),
      baseUrl: 'plugin',
      source: 'plugin',
      channels: rows,
      warnings,
      currentChannel: this.currentChannel,
    }
    this.snapshot = snapshot
    this.lastReport = {
      updatedAt: snapshot.updatedAt,
      durationMs: snapshot.updatedAt - startedAt,
      channelsProbed: targets.length,
      channelsOk: rows.filter((c) => c.state === 'ok').length,
      accountChannels: this.accounts.length,
      discoveredChannels: this.discovered.length,
      warnings,
    }
    return snapshot
  }
}

/**
 * Union two id lists, keeping the first list's order and appending only ids the
 * second list has that the first does not.
 * @param {readonly string[]} first Preferred order.
 * @param {readonly string[]} second Fallback additions.
 * @returns {string[]} The union.
 */
function mergeIds(first, second) {
  const out = [...first]
  for (const id of second) {
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Coerce a config value into a number inside a range, with a fallback.
 * @param {unknown} value Raw config value.
 * @param {number} fallback Value to use when unset or unusable.
 * @param {number} min Lower clamp.
 * @param {number} max Upper clamp.
 * @returns {number} A finite number within range.
 */
export function numberIn(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * Coerce a config value into a non-empty string, with a fallback.
 * @param {unknown} value Raw config value.
 * @param {string} fallback Value to use when unset or blank.
 * @returns {string} A non-empty trimmed string.
 */
export function stringOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

export { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS }
