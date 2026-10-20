/**
 * Gateway client: everything that knows the our-free-model wire protocol.
 *
 * Kept separate from the service so the HTTP shape lives in one place: the
 * service owns caching and polling, this module owns "how do I ask the gateway
 * a question and understand the answer".
 *
 * Three facts from the step-0 probe shape this module:
 *   - Channels are discovered from `/v1/models` (`data[].channel`), never
 *     hardcoded, so a channel added upstream appears without a plugin change.
 *   - A cold first probe takes ~10.5s while the gateway fetches upstream
 *     balances; a warm one takes ~0.3s. The timeout therefore has to be
 *     generous, and a slow first answer must not be treated as a failure.
 *   - `gemini` answers `ok:true` with `balance:null` plus an `error` string.
 *     That is a per-account failure inside a successful response and has to
 *     survive normalization as an error row, not crash the channel.
 *
 * @typedef {object} BalancePackage
 * @property {string} [name] Credit bundle name.
 * @property {string} [unit] Unit label (`credit`, `credits`).
 * @property {number} [remaining] Credits left in this bundle.
 * @property {number} [total] Credits the bundle started with.
 * @property {number} [used] Credits consumed.
 * @property {boolean} [active] Whether the bundle is currently in force.
 * @property {string} [cycleStartTime] Billing-cycle start, as the gateway reports it.
 * @property {string} [cycleEndTime] Billing-cycle end.
 * @property {string} [expiredTime] Expiry, when the bundle has one.
 * @property {number} [deductionEndTime] Epoch ms after which the bundle stops deducting.
 *
 * @typedef {object} GatewayAccount
 * @property {string} [accountId] Gateway-side account id.
 * @property {string} [nickname] Human-facing account name.
 * @property {{ total?: number, packages?: BalancePackage[], expiredTotal?: number } | null} [balance]
 *   Null when the gateway could not read the account (see `error`).
 * @property {string} [error] Why the balance is unavailable, when it is.
 *
 * @typedef {object} ChannelBalance
 * @property {string} channel Channel id (`codearts`, `buddy`, ...).
 * @property {'ok'|'error'|'empty'} state Outcome of the probe.
 * @property {string[]} nicknames Account names, deduped.
 * @property {number} [remaining] Summed remaining credits.
 * @property {number} [total] Summed bundle totals.
 * @property {number} [percent] `remaining / total`, 0-100.
 * @property {string} [unit] Unit label when every bundle agrees.
 * @property {number} packageCount How many bundles back this number.
 * @property {BalancePackage[]} packages Per-bundle detail.
 * @property {string} [error] Why the channel is unreadable, when it is.
 * @property {number} [observedAt] Epoch ms of the last successful read.
 *
 * @typedef {object} BalanceSnapshot
 * @property {number} updatedAt Epoch ms the snapshot was produced.
 * @property {string} baseUrl Gateway origin that answered.
 * @property {ChannelBalance[]} channels Channels in display order.
 * @property {string[]} warnings Non-fatal problems.
 * @property {string} [currentChannel] Channel the live conversation routes through.
 *
 * @module dsh-ofm-balance/gateway
 */

/** Default gateway origin; the profile may override it via config. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:18900'

/**
 * Per-request deadline. The cold path measured 10.5s, so 20s leaves headroom
 * for a colder gateway without letting a hung request wedge the poll loop.
 */
export const DEFAULT_TIMEOUT_MS = 20_000

/**
 * Convert an unknown JSON number-ish value, or undefined.
 * @param {unknown} value Raw value from the gateway.
 * @returns {number | undefined} A finite number, when one can be read.
 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Convert an unknown JSON string-ish value, or undefined.
 * @param {unknown} value Raw value from the gateway.
 * @returns {string | undefined} A non-empty trimmed string, when one can be read.
 */
function str(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Fetch with a deadline and parse JSON.
 *
 * `AbortSignal.timeout` aborts on the same schedule as the gateway's own
 * upstream fetch, so a slow channel surfaces as a timeout rather than an
 * unhandled rejection.
 *
 * @param {string} url Absolute URL to fetch.
 * @param {RequestInit} init Fetch options.
 * @param {number} timeoutMs Deadline in milliseconds.
 * @returns {Promise<{ status: number, body: unknown }>} Status and parsed body.
 */
export async function fetchJson(url, init, timeoutMs) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`gateway answered non-JSON (HTTP ${response.status}): ${text.slice(0, 120)}`)
  }
  return { status: response.status, body }
}

/**
 * Discover the channel ids the gateway currently routes.
 *
 * `/v1/models` is the authoritative source because it is the same document the
 * model picker reads: anything routable appears there with its `channel`.
 * Discovery is best-effort — if it fails the caller keeps its known-good list
 * rather than showing nothing.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token for the gateway.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<string[]>} Channel ids, most-populated first.
 */
export async function discoverChannels(baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { status, body } = await fetchJson(
    `${baseUrl}/v1/models`,
    { headers: { authorization: `Bearer ${apiKey}` } },
    timeoutMs,
  )
  if (status !== 200) throw new Error(`models HTTP ${status}`)
  const data = body?.data
  if (!Array.isArray(data)) throw new Error('models payload has no data array')

  const seen = new Map()
  for (const item of data) {
    const channel = str(item?.channel)
    if (channel !== undefined) seen.set(channel, (seen.get(channel) ?? 0) + 1)
  }
  // Stable order: most models first, then alphabetical, so a new upstream
  // channel does not reshuffle the whole card.
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id)
}

/**
 * Query one channel's credits.
 *
 * The gateway answers HTTP 200 with `{ok:false,error:{...}}` for application
 * failures and rejects (401/5xx/network) for transport ones; callers treat both
 * as data so one bad channel cannot fail the others.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token for the gateway.
 * @param {string} channel Channel id to query.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<unknown>} The `value` payload of a successful answer.
 */
export async function queryChannel(baseUrl, apiKey, channel, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { status, body } = await fetchJson(
    `${baseUrl}/api/management/channels/rpc`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ method: 'credits.balances', payload: { provider: channel } }),
    },
    timeoutMs,
  )
  if (body?.ok !== true) {
    throw new Error(body?.error?.message ?? body?.error?.code ?? `gateway refused (HTTP ${status})`)
  }
  return body.value
}

/**
 * Fold one channel's raw response into the number the card renders.
 *
 * The rules that matter:
 *   - Accounts with `balance: null` are failures reported inside a success
 *     envelope (`gemini` does exactly this); they contribute an error row but
 *     must not erase a sibling account's number.
 *   - `balance.total` is the gateway's own remaining aggregate and wins when
 *     present; otherwise the bundle sums are used, because some channels
 *     report only bundles.
 *   - Percentages come from bundle totals, and only when a total exists — a
 *     100/100 resource pack is genuinely 100% used, but a channel without a
 *     total has no meaningful percentage.
 *
 * @param {string} channel Channel id.
 * @param {unknown} raw The `value` payload from {@link queryChannel}.
 * @param {number} observedAt Epoch ms of this read.
 * @returns {ChannelBalance} The normalized row.
 */
export function normalizeChannel(channel, raw, observedAt) {
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : []
  if (accounts.length === 0) {
    // No accounts bound to this channel. That is the normal state for a vendor
    // the user has not logged into yet — not an error, and not "no balance":
    // there is simply nothing to read until an account is linked in the
    // gateway's console. Says so plainly rather than showing a bare dash.
    return {
      channel,
      state: 'empty',
      nicknames: [],
      packageCount: 0,
      packages: [],
      note: '未在该渠道登录账号',
    }
  }

  /** @type {string[]} */
  const nicknames = []
  /** @type {BalancePackage[]} */
  const packages = []
  let remaining = 0
  let total = 0
  let anyNumber = false
  /** @type {Set<string>} */
  const units = new Set()
  /** @type {string[]} */
  const failures = []

  for (const account of accounts) {
    const nickname = str(account?.nickname)
    if (nickname !== undefined && !nicknames.includes(nickname)) nicknames.push(nickname)

    const balance = account?.balance
    if (balance === null || balance === undefined) {
      // A per-account failure inside a successful channel answer (gemini).
      failures.push(str(account?.error) ?? '余额不可用')
      continue
    }

    const accountPackages = Array.isArray(balance.packages) ? balance.packages : []
    // Only bundles still in force count toward an allowance. The gateway marks
    // lapsed ones `active:false`: `buddy` carries four expired 裂变包 with
    // `total` 100 / `used` 100 / `remaining` 0 each, and counting them inflates
    // the divisor by 400 (4939 instead of 4539, reading 78.9% where 85.8% is
    // correct). Excluding them cannot hide remaining credits, since a lapsed
    // bundle contributes no `remaining` — it only stops a spent allowance from
    // being weighed as though it were still owed. All bundles are still listed
    // for display, so the detail remains visible.
    const activePackages = accountPackages.filter((pkg) => pkg?.active !== false)
    let accountPackageRemaining = 0
    let accountPackageTotal = 0
    let accountUsedDeclared = 0
    for (const pkg of accountPackages) {
      const unit = str(pkg?.unit)
      if (unit !== undefined) units.add(unit)
      packages.push(pkg)
    }
    for (const pkg of activePackages) {
      const pkgRemaining = num(pkg?.remaining)
      const pkgTotal = num(pkg?.total)
      const used = num(pkg?.used)
      if (pkgRemaining !== undefined) accountPackageRemaining += pkgRemaining
      if (pkgTotal !== undefined) accountPackageTotal += pkgTotal
      if (used !== undefined) accountUsedDeclared += used
    }

    // Bundle totals overlap in this gateway: `codearts` reports a 总积分包
    // whose remaining equals 基础积分包 + 赠送积分包, so summing every bundle
    // would double-count. `balance.total` is the gateway's own de-duplicated
    // aggregate and is therefore the authority whenever it is present.
    const gatewayTotal = num(balance.total)
    if (gatewayTotal !== undefined || accountPackageRemaining !== 0) anyNumber = true
    remaining += gatewayTotal !== undefined ? gatewayTotal : accountPackageRemaining

    // The denominator is where an overlapping bundle goes wrong a second time.
    // The same `used` appears in the aggregate and in a bundle cut from it:
    // `codearts` reports 总积分包.used 349.31 *and* 赠送积分包.used 349.31, so
    // summing every bundle's `used` inflates the divisor (7849.31 instead of the
    // true cycle allowance 7500, reading 91.1% where 95.3% is correct). Both
    // readings were measured against the live gateway.
    //
    // The aggregate is identified structurally rather than by name: it is the
    // bundle whose `remaining` equals `balance.total`. Its own `used` is then the
    // consumed side of that same aggregate. On the channels measured, that
    // bundle's `total` corroborates the result exactly (codearts 7500, qoder and
    // qodercn 100/300). When no bundle matches the aggregate, the bundles are
    // independent and summing them is the correct reading (buddy, trae) — and
    // there `Σremaining + Σused` equals `Σtotal`, which is the check that says
    // the sum is safe.
    //
    // When the itemization is missing entirely there is no allowance to divide
    // by, so no percentage is produced. Falling back to `remaining / remaining`
    // would print a confident 100% for a channel whose balance may be nearly
    // spent — the most misleading thing this card could say.
    if (gatewayTotal !== undefined) {
      let aggregate = null
      for (const pkg of activePackages) {
        if (num(pkg?.remaining) !== gatewayTotal) continue
        const used = num(pkg?.used) ?? 0
        if (aggregate === null || used > (num(aggregate?.used) ?? 0)) aggregate = pkg
      }
      if (aggregate !== null) {
        total += gatewayTotal + (num(aggregate?.used) ?? 0)
      } else if (accountPackageTotal > 0) {
        // Without an aggregate the bundles have to account for the total
        // themselves. If they do not, this is a balance shape we do not
        // understand and any divisor would be a guess, so no percentage is
        // produced. The measured shapes that do pass: buddy
        // (Σremaining 3896.29 == balance.total) and trae (Σremaining
        // 3636.34 == balance.total).
        if (Math.abs(accountPackageRemaining - gatewayTotal) < 0.005) {
          // Two independent readings of the same allowance; prefer the larger so
          // a bundle reporting `used` without `total` cannot shrink the divisor.
          total += Math.max(accountPackageTotal, gatewayTotal + accountUsedDeclared)
        }
      }
      // else: no itemization, or an unrecognised shape — leave `total` as-is so
      // the percentage is omitted rather than fabricated.
    } else {
      total += accountPackageTotal
    }
  }

  if (!anyNumber && failures.length > 0) {
    return {
      channel,
      state: 'error',
      nicknames,
      packageCount: packages.length,
      packages,
      error: failures.join('; '),
    }
  }

  const unit = pickUnit(units)
  return {
    channel,
    state: anyNumber ? 'ok' : 'empty',
    nicknames,
    remaining: anyNumber ? Number(remaining.toFixed(4)) : undefined,
    total: total > 0 ? Number(total.toFixed(4)) : undefined,
    percent: total > 0 ? Number(((remaining / total) * 100).toFixed(1)) : undefined,
    unit,
    packageCount: packages.length,
    packages,
    error: failures.length > 0 ? failures.join('; ') : undefined,
    observedAt: anyNumber ? observedAt : undefined,
  }
}

/**
 * Pick one unit label for a channel.
 *
 * Bundles disagree on spelling more often than on meaning: `workbuddy` ships
 * some packs labelled `credit` and others `credits`, and joining them produced
 * `credit/credits` on the card — two words where one belongs, eating the width
 * that the number needs. Singular and plural are the same unit, so they are
 * folded to one spelling (the longer, which is the plural in this catalogue).
 *
 * A genuine disagreement — `credit` vs `token` — is *not* folded: that would
 * claim two different things are the same. It renders as a slash list, because
 * the number really is a sum across unlike units and saying so is honest.
 *
 * @param {Set<string>} units Unit labels seen across the channel's bundles.
 * @returns {string | undefined} One label, a slash list, or undefined.
 */
function pickUnit(units) {
  const list = [...units]
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  const stems = new Set(list.map((unit) => unit.toLowerCase().replace(/s$/, '')))
  if (stems.size === 1) {
    // Same unit, different pluralisation: use the longest spelling.
    return list.reduce((longest, unit) => (unit.length > longest.length ? unit : longest), list[0])
  }
  return list.join('/')
}

/**
 * Probe every channel at once.
 *
 * `allSettled`, not `all`: the whole point of this fan-out is that the slow or
 * broken channel (gemini) never delays or cancels the healthy ones.
 *
 * @param {string} baseUrl Gateway origin.
 * @param {string} apiKey Bearer token for the gateway.
 * @param {readonly string[]} channels Channel ids to probe.
 * @param {number} [timeoutMs] Per-request deadline.
 * @returns {Promise<ChannelBalance[]>} One row per channel, in input order.
 */
export async function probeAll(baseUrl, apiKey, channels, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const settled = await Promise.allSettled(
    channels.map(async (channel) => {
      const raw = await queryChannel(baseUrl, apiKey, channel, timeoutMs)
      return normalizeChannel(channel, raw, Date.now())
    }),
  )
  return settled.map((entry, index) => {
    if (entry.status === 'fulfilled') return entry.value
    return {
      channel: channels[index],
      state: 'error',
      nicknames: [],
      packageCount: 0,
      packages: [],
      error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
    }
  })
}
