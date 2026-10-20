/**
 * Data-source discovery: which Our Free Model is actually on this machine?
 *
 * Two independent products share the OFM name and neither knows about the other:
 *
 *   1. **The DSH plugin** (`dsh-our-free-model`). It carries the thirteen 白嫖
 *      channels inside the DSH process and exposes their credits through the
 *      kernel's RPC channel as namespace `channel-pack`, method
 *      `credits.balances`. There is no HTTP door: its `/api/our-free-model/*`
 *      routes and its `/api/channel-pack` Fetch route are fenced by
 *      `connection.admit()`, which needs the browser's session cookie (measured:
 *      401 for every non-browser caller, including loopback with a matching
 *      Origin).
 *
 *   2. **The standalone desktop app**. It listens on `127.0.0.1:18900` and serves
 *      the same method over `POST /api/management/channels/rpc` behind a Bearer
 *      key. This is what earlier versions of this plugin read.
 *
 * A user may have either, both, or neither. The card must not silently read the
 * wrong one — that is the defect this module exists to fix: with both installed,
 * the card showed the desktop app's accounts while the user had just logged into
 * the plugin's.
 *
 * Discovery is *advisory*: it reports what is reachable, and the caller decides
 * which one to read (the user gets asked on first run, see `resolveSource`).
 *
 * @module sources
 */

/** The id of the in-DSH source, i.e. the official plugin's RPC namespace. */
export const SOURCE_PLUGIN = 'plugin'

/** The id of the standalone desktop app source. */
export const SOURCE_DESKTOP = 'desktop'

/** The default gateway the standalone app binds. */
export const DESKTOP_DEFAULT_URL = 'http://127.0.0.1:18900'

/** User's persisted choice: ask once, then always `auto`. */
export const PREFERENCE_AUTO = 'auto'

/** Every value `preference` may hold. */
export const PREFERENCES = [PREFERENCE_AUTO, SOURCE_PLUGIN, SOURCE_DESKTOP, 'none']

/**
 * @typedef {object} SourceProbe
 * @property {string} id Source id (`plugin` or `desktop`).
 * @property {boolean} available Whether the source answered.
 * @property {string} [version] Best-effort version label for the UI.
 * @property {string} [reason] Why it is unavailable, when it is not.
 * @property {number} [channels] How many channels the source advertises.
 */

/**
 * Decide which source to read, given what was found and what the user chose.
 *
 * The rules, in order:
 *   - an explicit choice wins whenever that source is reachable;
 *   - an explicit choice that is no longer reachable falls back to `auto`
 *     rather than showing an empty card forever (the user uninstalled one of
 *     them, or the desktop app is simply not running today);
 *   - `auto` with exactly one source uses it;
 *   - `auto` with both prefers the plugin: it is the one mounted in DSH, so it
 *     is the one whose accounts the user just configured in this app's UI;
 *   - `auto` with neither answers `none`.
 *
 * @param {string} preference Persisted preference.
 * @param {SourceProbe[]} probes What discovery found.
 * @returns {string} One of `plugin`, `desktop`, `none`.
 */
export function resolveSource(preference, probes) {
  const available = new Set(probes.filter((p) => p.available).map((p) => p.id))
  if (preference === SOURCE_PLUGIN || preference === SOURCE_DESKTOP) {
    if (available.has(preference)) return preference
    // The chosen source is gone. Fall through to auto rather than pinning the
    // card to an empty answer the user cannot explain.
  }
  if (available.has(SOURCE_PLUGIN)) return SOURCE_PLUGIN
  if (available.has(SOURCE_DESKTOP)) return SOURCE_DESKTOP
  return 'none'
}

/**
 * True when the user must be asked which source to use.
 *
 * Asked exactly once, and only when the answer is genuinely ambiguous: a single
 * source needs no question, and a remembered choice settles it.
 *
 * @param {string} preference Persisted preference.
 * @param {SourceProbe[]} probes What discovery found.
 * @returns {boolean} Whether the UI should prompt.
 */
export function needsSourceChoice(preference, probes) {
  if (preference !== PREFERENCE_AUTO) return false
  const available = probes.filter((p) => p.available)
  return available.length > 1
}

/**
 * Describe the sources for the settings page and the first-run prompt.
 *
 * @param {SourceProbe[]} probes What discovery found.
 * @param {string} active The source actually being read.
 * @returns {{id: string, available: boolean, active: boolean, label: string, detail: string}[]}
 */
export function describeSources(probes, active) {
  return probes.map((probe) => ({
    id: probe.id,
    available: probe.available,
    active: probe.available && probe.id === active,
    label: probe.id === SOURCE_PLUGIN ? 'DSH 插件' : '桌面应用',
    detail: probe.available
      ? `可用${probe.version === undefined ? '' : ` · ${probe.version}`}${probe.channels === undefined ? '' : ` · ${probe.channels} 个渠道`}`
      : (probe.reason ?? '未检测到'),
  }))
}
