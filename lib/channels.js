/**
 * Channel classification — the pure rules that decide what the card shows.
 *
 * Kept free of I/O and of the host context on purpose: this is the part most
 * likely to need changing and the part worth testing, so it must be callable
 * with three plain arrays and nothing else.
 *
 * ## The three populations
 *
 * A channel id (`trae`, `codearts`, ...) can be known to three different
 * sources, and the card's behaviour depends on which ones know it:
 *
 * | Source | Where it comes from | Meaning |
 * | --- | --- | --- |
 * | `configured` | The DSH profile's `llm-pi-ai` entry: the model ids declared under the route the card watches | The user actually routed models through this channel |
 * | `discovered` | The gateway's `/v1/models`, `data[].channel` | The gateway is willing to serve this channel |
 * | `probed` | The gateway's `credits.balances` answered with a number | The balance is readable right now |
 *
 * ## The default policy
 *
 * - **Configured** channels are visible by default. If the gateway cannot
 *   report a balance for one, it is still shown, with the reason — the user
 *   configured it, so hiding it would misrepresent their setup.
 * - **Unconfigured but discovered** channels are hidden by default. They are
 *   the gateway's inventory, not the user's, and a default card that lists
 *   services the user never set up is noise.
 * - The user can override either side in the plugin's settings: hide a
 *   configured channel, or reveal an unconfigured one. Revealing an
 *   unconfigured channel raises a warning, because a balance the user cannot
 *   spend through this harness is a misleading number.
 *
 * @module dsh-ofm-balance/channels
 */

/** How a channel ended up on the card. */
export const VISIBILITY = {
  /** Configured in DSH and not hidden: shown by default. */
  CONFIGURED: 'configured',
  /** Not configured, revealed by the user: shown with a warning. */
  REVEALED: 'revealed',
  /** Not configured and not revealed: not rendered. */
  HIDDEN_UNCONFIGURED: 'hidden-unconfigured',
  /** Configured but hidden by the user. */
  HIDDEN_BY_USER: 'hidden-by-user',
}

/**
 * Human labels for the channels this gateway is known to ship.
 *
 * This is a *presentation* nicety, never an identity list: nothing in the
 * plugin gates on membership here. A channel that is not named still shows up,
 * is still probed, and is still toggleable — it just renders its raw id until
 * someone adds a label. That is what makes the plugin work for a gateway
 * deployment with different vendors than the one it was written against.
 *
 * Sourced from the gateway's own provider catalogue (`_ofm-provider-list` in the
 * console bundle). The Chinese names are the vendors' own, which matters when
 * two entries are close (WorkBuddy 国内版 vs 国际版, Qoder vs Qoder 中国版).
 */
export const CHANNEL_LABELS = {
  codearts: 'CodeArts',
  buddy: 'WorkBuddy 国内版',
  workbuddy: 'WorkBuddy 国际版',
  lobsterai: 'LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder 中国版',
  trae: 'TRAE',
  cline: 'Cline',
  loomy: 'Loomy',
  raccoon: 'Raccoon',
  minimax: 'MiniMax Code',
  zcode: 'ZCode',
  gemini: 'Gemini',
}

/**
 * The gateway's full channel catalogue, in the order its console lists them.
 *
 * This is the answer to "why do I only see six channels": `/v1/models` only
 * reports channels that currently have models routed. A channel with no account
 * logged in, or one whose models are temporally unavailable, still exists —
 * it just answers `credits.balances` with an empty account list.
 *
 * The plugin therefore seeds discovery from this catalogue and treats
 * `/v1/models` as an addition, not the source of truth. A deployment shipping a
 * channel this list has never heard of still works: the catalogue is a floor,
 * not a filter (see `discoverChannels` in gateway.js).
 */
export const KNOWN_CHANNELS = [
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
 * Display label for a channel id.
 *
 * Unknown ids are title-cased rather than shown raw, so a new channel reads as
 * `Moonshot` instead of `moonshot` — a small thing that keeps an unfamiliar
 * deployment looking intentional rather than broken.
 *
 * @param {string} id Channel id.
 * @returns {string} The label.
 */
export function channelLabel(id) {
  const known = CHANNEL_LABELS[id]
  if (known !== undefined) return known
  if (id === '') return ''
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * Split a comma-separated settings field into ids.
 *
 * The host renders a `z.array(...)` field as free text in some versions and as
 * a chip list in others, so the settings surface stores these overrides as one
 * string per list. Parsing is deliberately forgiving: blank entries, stray
 * whitespace and duplicate ids are all normal when a human types a list.
 *
 * @param {unknown} raw The settings field value.
 * @returns {string[]} Non-empty, trimmed, de-duplicated ids.
 */
export function parseChannelList(raw) {
  if (typeof raw !== 'string') {
    return Array.isArray(raw) ? [...new Set(raw.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))] : []
  }
  const out = []
  for (const piece of raw.split(/[,，\s]+/)) {
    const id = piece.trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Extract the channel ids a profile's model list routes through.
 *
 * The route's models are declared as `<channel>/<model>` ids
 * (`trae/deepseek-v4.1-flash`), so the prefix is the channel. Ids without a
 * slash, or with an empty prefix, carry no channel and are skipped.
 *
 * @param {unknown} piConfig The `llm-pi-ai` settings namespace value.
 * @param {string} route Provider route key to read (`ourfreemodel`).
 * @returns {string[]} Channel ids, in declaration order, de-duplicated.
 */
export function configuredChannelsFrom(piConfig, route) {
  const provider = piConfig?.providers?.[route]
  const models = Array.isArray(provider?.models) ? provider.models : []
  const out = []
  for (const model of models) {
    const id = model?.id
    if (typeof id !== 'string') continue
    const slash = id.indexOf('/')
    if (slash <= 0) continue
    const channel = id.slice(0, slash)
    if (!out.includes(channel)) out.push(channel)
  }
  return out
}

/**
 * Classify every known channel into what the card should render.
 *
 * @param {object} input Classification inputs.
 * @param {readonly string[]} input.configured Channels declared in the profile.
 * @param {readonly string[]} input.discovered Channels the gateway advertises.
 * @param {readonly string[]} input.known The gateway's full catalogue.
 * @param {readonly string[]} input.hidden Channels the user hid.
 * @param {readonly string[]} input.revealed Unconfigured channels the user revealed.
 * @returns {Array<{ id: string, configured: boolean, discovered: boolean, visible: boolean, visibility: string, warning?: string }>}
 *   One entry per known channel, ordered configured-first.
 */
export function classifyChannels({ configured, discovered, known, hidden, revealed }) {
  const configuredSet = new Set(configured)
  const discoveredSet = new Set(discovered)
  const hiddenSet = new Set(hidden)
  const revealedSet = new Set(revealed)

  // Every channel the plugin knows about, in a stable order:
  //   1. configured channels, in the profile's own declaration order;
  //   2. the gateway's catalogue, in the order its console lists them;
  //   3. anything else the gateway happened to advertise, alphabetically.
  // The catalogue sits in the middle deliberately: it gives the unconfigured
  // entries a meaningful order (rather than alphabetical noise) while still
  // letting a profile's own ordering win for the channels the user routes.
  const ids = []
  const push = (id) => {
    if (!ids.includes(id)) ids.push(id)
  }
  for (const id of configured) push(id)
  for (const id of known ?? []) push(id)
  for (const id of [...discovered].sort((a, b) => a.localeCompare(b))) push(id)
  for (const id of revealed) push(id)

  return ids.map((id) => {
    const isConfigured = configuredSet.has(id)
    const isDiscovered = discoveredSet.has(id)

    if (isConfigured && hiddenSet.has(id)) {
      return { id, configured: true, discovered: isDiscovered, visible: false, visibility: VISIBILITY.HIDDEN_BY_USER }
    }
    if (isConfigured) {
      return { id, configured: true, discovered: isDiscovered, visible: true, visibility: VISIBILITY.CONFIGURED }
    }
    if (revealedSet.has(id)) {
      return {
        id,
        configured: false,
        discovered: isDiscovered,
        visible: true,
        visibility: VISIBILITY.REVEALED,
        // Shown so the reader knows the number is not spendable from this
        // harness: nothing routes through it until a model is configured.
        warning: '尚未配置该渠道的模型，仅供查看',
      }
    }
    return { id, configured: false, discovered: isDiscovered, visible: false, visibility: VISIBILITY.HIDDEN_UNCONFIGURED }
  })
}

/**
 * The channels worth probing: everything visible, plus anything configured.
 *
 * Hidden-by-user channels are skipped — that is what hiding them means, and it
 * also avoids spending a request per poll on a number nobody will see.
 *
 * @param {ReturnType<typeof classifyChannels>} plan Classification result.
 * @returns {string[]} Channel ids to probe.
 */
export function channelsToProbe(plan) {
  return plan.filter((entry) => entry.visible).map((entry) => entry.id)
}

/**
 * Merge the classification into probe rows, preserving the plan order and
 * letting an unreadable channel keep its row.
 *
 * @param {ReturnType<typeof classifyChannels>} plan Classification result.
 * @param {Array<{ channel: string }>} rows Probe results, keyed by `channel`.
 * @returns {Array<object>} Visible rows in plan order.
 */
export function mergePlanWithRows(plan, rows) {
  const byChannel = new Map(rows.map((row) => [row.channel, row]))
  const out = []
  for (const entry of plan) {
    if (!entry.visible) continue
    const row = byChannel.get(entry.id)
    if (row !== undefined) {
      out.push({ ...row, configured: entry.configured, warning: entry.warning })
      continue
    }
    // Visible in the plan but never probed: a configured channel the gateway
    // does not advertise. Report it honestly rather than dropping the row —
    // the user configured it, so saying nothing would look like a bug.
    out.push({
      channel: entry.id,
      state: 'error',
      nicknames: [],
      packageCount: 0,
      packages: [],
      error: entry.discovered ? '未探测' : '网关未提供该渠道',
      configured: entry.configured,
      warning: entry.warning,
    })
  }
  return out
}
