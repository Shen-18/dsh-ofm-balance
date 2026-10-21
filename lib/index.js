/**
 * Host half: mount the balance service behind two loopback-fenced routes.
 *
 * Why loopback-fenced: the snapshot is personal account data (balances behind
 * your own credentials). The browser reaches it same-origin, which is always
 * loopback when the GUI is opened locally; a LAN device must not.
 *
 * Why the credential never crosses the fence: the browser sends nothing but a
 * GET. The key is resolved from the DSH credential seam inside this process, so
 * a compromised page cannot read it out of the API.
 *
 * @module dsh-ofm-balance
 */

import z from '@deepseek-ai/schemastery'
import { BalanceService, numberIn, stringOr } from './service.js'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './gateway.js'
import { parseChannelList, channelLabel } from './channels.js'
import { writeVisibilitySettings, readVisibilitySettings, readSourceChoice, writeSourceChoice, readSourcePromptSeen, writeSourcePromptSeen } from './patch.js'
import { SOURCE_PLUGIN, SOURCE_DESKTOP, DEFAULT_SOURCE, resolveSource, describeSources, needsSourceChoice } from './sources.js'
import { makePluginRpc, probePluginSource } from './plugin-source.js'
import { probeDesktopSource } from './desktop-source.js'

export const name = 'dsh-ofm-balance'
export const inject = ['webServer']

/** Route prefix; the client half mirrors these document-relative. */
export const API_PREFIX = '/api/dsh-ofm-balance'

/**
 * Config schema. Every field is `volatile()` so a settings save re-arms this
 * row in place instead of remounting it (a remount would drop the cache and
 * restart the poll loop on every edit).
 *
 * Channel visibility is expressed as two id lists rather than one tri-state map
 * because the Host renders arrays as a text field the user can edit directly:
 * a list of exceptions is easy to type and easy to explain in the settings
 * page, whereas a per-channel tri-state would need a custom control this plugin
 * does not ship.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  /**
   * Which Our Free Model to read: `plugin` (the default primary source, the
   * official `dsh-our-free-model` plugin over the kernel RPC channel),
   * `desktop` (the standalone app on `baseUrl`), `auto` (decide from what is
   * reachable), or `none`.
   *
   * `plugin` is the default because it is the product that lives inside DSH:
   * its accounts are the ones configured in this app, and reading them needs no
   * separately running process. A machine without the plugin still works — an
   * unreachable preference falls back to whatever else answered, so `desktop`
   * is read instead of showing an empty card.
   */
  source: z
    .string()
    .default('plugin')
    .volatile(),
  baseUrl: z.string().default(DEFAULT_BASE_URL).volatile(),
  credentialRoute: z.string().default('ourfreemodel').volatile(),
  pollIntervalSec: z.number().min(30).max(3600).default(60).volatile(),
  timeoutMs: z.number().min(5000).max(120000).default(DEFAULT_TIMEOUT_MS).volatile(),
  /** Configured channels the user wants off the card. */
  hiddenChannels: z.array(z.string()).default([]).volatile(),
  /** Unconfigured channels the user wants on the card anyway. */
  revealedChannels: z.array(z.string()).default([]).volatile(),
})

/** Read a config field that may arrive as a live reference or a plain value. */
function readField(field) {
  if (field === undefined) return undefined
  if (typeof field === 'object' && field !== null && typeof field.get === 'function') {
    return field.get()
  }
  return field
}

/**
 * Read a list field, accepting either the schema's array or a single delimited
 * string (the Host's text rendering of an array field).
 * @param {unknown} field The raw config field.
 * @returns {string[]} Normalized ids.
 */
function readListField(field) {
  const value = readField(field)
  if (Array.isArray(value)) {
    return [...new Set(value.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))]
  }
  return parseChannelList(value)
}

/** Resolve the activation's settings into plain values. */
export function resolveConfig(config) {
  return {
    enabled: readField(config?.enabled) ?? true,
    source: stringOr(readField(config?.source), 'plugin'),
    baseUrl: stringOr(readField(config?.baseUrl), DEFAULT_BASE_URL),
    credentialRoute: stringOr(readField(config?.credentialRoute), 'ourfreemodel'),
    pollIntervalSec: numberIn(readField(config?.pollIntervalSec), 60, 30, 3600),
    timeoutMs: numberIn(readField(config?.timeoutMs), DEFAULT_TIMEOUT_MS, 5000, 120000),
    hiddenChannels: readListField(config?.hiddenChannels),
    revealedChannels: readListField(config?.revealedChannels),
  }
}

/**
 * Resolve a provider route's API key through the DSH credential seam.
 *
 * Two sources are tried, mirroring how the LLM adapter itself resolves a key:
 *   1. the route's `apiKeyEnv` name, read from the `llm-pi-ai` settings
 *      namespace (this profile declares `apiKeyEnv: OURFREEMODEL_API_KEY`);
 *   2. that same env name resolved through the credential store, which is
 *      where DSH keeps it.
 * Anything else (reading plain files, guessing names) is deliberately avoided:
 * the seam is the contract.
 */
function makeCredentialReader(ctx) {
  return {
    async read(route) {
      const credentials = safeService(ctx, 'credentials')

      // The route's own declaration is the authority for the env var name.
      let envName
      const pi = readNamespace(ctx, 'llm-pi-ai')
      const declared = pi?.providers?.[route]?.apiKeyEnv
      if (typeof declared === 'string' && declared !== '') envName = declared

      if (envName === undefined) {
        // No declaration: fall back to the conventional upper-snake name.
        envName = route.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_API_KEY'
      }

      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        try {
          const resolved = await credentials.resolve(envName)
          const value = resolved?.value
          if (typeof value === 'string' && value !== '') return value
        } catch {
          // Fall through to the process environment.
        }
      }

      const fromEnv = process.env[envName]
      if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
      return undefined
    },
  }
}

/** Best-effort typed service lookup; an absent service is not an error. */
function safeService(ctx, id) {
  try {
    return ctx.get?.(id) ?? ctx[id]
  } catch {
    return undefined
  }
}

/**
 * Probe both Our Free Model products.
 *
 * @param {object} ctx Host context.
 * @param {{baseUrl: string, timeoutMs: number, credentialRoute: string}} value Settings.
 * @returns {Promise<import('./sources.js').SourceProbe[]>} One probe per source.
 */
async function discoverSources(ctx, value) {
  const reader = makeCredentialReader(ctx)
  const apiKey = await reader.read(value.credentialRoute).catch(() => undefined)

  const pluginProbe = await probePluginSource(makePluginRpc(ctx))
  const desktopProbe = await probeDesktopSource(value.baseUrl, value.timeoutMs, apiKey)

  return [
    {
      id: SOURCE_PLUGIN,
      available: pluginProbe.available,
      reason: pluginProbe.reason,
      channels: pluginProbe.channels?.length,
    },
    {
      id: SOURCE_DESKTOP,
      available: desktopProbe.available,
      reason: desktopProbe.reason,
      channels: desktopProbe.channels,
    },
  ]
}

/**
 * How many discovery attempts a cold start gets before settling.
 *
 * The kernel publishes `connection` only after the browser half mounts, which is
 * *after* plugins load — the official plugin's own source notes the same trap.
 * So the first attempt legitimately sees nothing on a healthy machine. Six
 * attempts a second apart covers that window; past it, a missing source is real
 * rather than "not yet".
 */
const DISCOVERY_ATTEMPTS = 6

/** @param {number} ms Delay in milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Discover, retrying while nothing is reachable.
 *
 * A card that reads `none` because it looked a second too early is the exact
 * failure this whole feature exists to remove, so a cold start must not settle
 * for the first empty answer.
 *
 * @param {object} ctx Host context.
 * @param {{baseUrl: string, timeoutMs: number, credentialRoute: string}} value Settings.
 * @returns {Promise<import('./sources.js').SourceProbe[]>} The settled probes.
 */
async function discoverSourcesSettled(ctx, value) {
  let probes = await discoverSources(ctx, value)
  for (let attempt = 1; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
    if (probes.some((probe) => probe.available)) return probes
    await delay(1000)
    probes = await discoverSources(ctx, value)
  }
  return probes
}


/** Read a settings namespace's resolved value, when the host exposes it. */
function readNamespace(ctx, namespace) {
  try {
    const settings = safeService(ctx, 'settings')
    if (settings === undefined) return undefined
    if (typeof settings.get === 'function') {
      const value = settings.get(namespace)
      if (value !== undefined) return value
    }
    if (typeof settings.read === 'function') return settings.read(namespace)
    return undefined
  } catch {
    return undefined
  }
}

/**
 * True when the request originates from this machine.
 *
 * The DNS-rebinding-safe test reads the socket address rather than a header:
 * `127.0.0.1`/`::1` cannot be forged by a remote page. A reverse-proxied
 * deployment still passes because the proxy is local; that is the same trade
 * the host's own privileged routes make.
 */
function isLoopback(req) {
  const socket = req.socket
  const address = socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write a JSON response with no-store so a stale balance never sticks. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Read and parse a JSON request body.
 *
 * Bounded: a visible setting is a handful of channel ids, so anything past
 * 64 KiB is either a mistake or an attack, and neither should be buffered.
 *
 * @param {import('node:http').IncomingMessage} req The request.
 * @returns {Promise<unknown>} The parsed body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const LIMIT = 64 * 1024
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > LIMIT) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Normalize a list of channel ids from a request body.
 * @param {unknown} value Raw value.
 * @returns {string[]} Trimmed, de-duplicated ids.
 */
function normalizeIdList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}


/**
 * Follow the conversation's model route so the collapsed card can name the
 * channel actually in use.
 *
 * The host announces every request on `session/event`; `request/header`
 * carries the resolved `{ provider, model }` for that turn. The model id leads
 * with the gateway channel (`trae/deepseek-v4.1-flash`), which is exactly what
 * this card groups by — so no extra probing is needed to answer "which one am
 * I spending right now".
 *
 * A malformed event must never break the session loop, hence the bare catch.
 *
 * @param {object} ctx Host context.
 * @param {import('./service.js').BalanceService} svc The running service.
 * @returns {(() => void) | undefined} A disposer, when the host exposed the seam.
 */
function watchSessionRoutes(ctx, svc) {
  if (typeof ctx?.on !== 'function') return undefined
  try {
    return ctx.on('session/event', (_session, event) => {
      try {
        if (event?.type === 'request/header') {
          const config = event.data?.header?.config
          if (config !== undefined) svc.noteRequestRoute(config.provider, config.model)
        } else if (event?.type === 'request/context') {
          const data = event.data
          if (data !== undefined) svc.noteRequestRoute(data.provider, data.model)
        }
      } catch {
        // A malformed event is not worth surfacing.
      }
    })
  } catch {
    return undefined
  }
}

/**
 * Host body. A disabled row mounts nothing at all — no poll loop, no routes.
 */
export function apply(ctx, config) {
  let live = true
  let service
  let disposers = []
  let queued = false
  /** @type {(() => void) | undefined} */
  let sessionDisposer
  /**
   * The last discovery result, for the settings page and the first-run prompt.
   * @type {import('./sources.js').SourceProbe[]}
   */
  let lastProbes = []
  /**
   * Slow re-probe used while no source is reachable, so the card recovers when
   * one appears without needing a DSH restart.
   * @type {ReturnType<typeof setInterval> | undefined}
   */
  let sourceWatchTimer

  const mountRoutes = (svc) => {
    const routes = [
      {
        kind: 'exact',
        path: API_PREFIX + '/overview',
        handler: (req, res) => {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
            return
          }
          const snapshot = svc.current()
          if (snapshot === undefined) {
            // First load: answer immediately with a "warming up" document and
            // let the probe land in the background. The cold probe takes ~10s
            // and blocking the first paint on it would look like a hang.
            //
            // Kick a probe here as well: the mount-time probe can race a
            // gateway that is not listening yet, and without this retry the
            // card waits a full poll interval before trying again.
            void svc.refresh().catch(() => {})
            writeJson(res, 200, {
              ok: true,
              warming: true,
              snapshot: {
                updatedAt: Date.now(),
                baseUrl: svc.options.baseUrl,
                // Pending rows, not an empty list: the card should appear at
                // once with the right channel names while the numbers load.
                channels: svc.pendingRows(),
                warnings: [],
                currentChannel: svc.currentChannel,
              },
              report: undefined,
            })
            return
          }
          // The route a conversation just switched to must show up on the next
          // poll of the card, not the next probe cycle, so overlay it here
          // rather than waiting for the snapshot to be rebuilt.
          writeJson(res, 200, {
            ok: true,
            warming: false,
            snapshot: { ...snapshot, currentChannel: svc.currentChannel },
            report: svc.report(),
          })
        },
      },
      {
        // Which Our Free Model this card is reading, what else is reachable, and
        // whether the user still has to choose. The browser renders the
        // first-run prompt from `needsChoice` and the settings switch from
        // `sources`, so both read one document and cannot disagree.
        kind: 'exact',
        path: API_PREFIX + '/sources',
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
            return
          }
          if (req.method === 'POST') {
            let body
            try {
              body = await readJsonBody(req)
            } catch (error) {
              writeJson(res, 400, {
                ok: false,
                error: error instanceof Error ? error.message : 'invalid body',
              })
              return
            }
            // Dismissing the first-run question: record that it was seen, but
            // leave the choice unset. `auto` then keeps picking the sensible
            // default on every start without asking again.
            if (body?.dismiss === true) {
              try {
                await writeSourcePromptSeen()
              } catch (error) {
                writeJson(res, 500, {
                  ok: false,
                  error: error instanceof Error ? error.message : 'write failed',
                })
                return
              }
              writeJson(res, 200, { ok: true, dismissed: true })
              return
            }
            const choice = typeof body?.source === 'string' ? body.source.trim() : ''
            if (choice !== SOURCE_PLUGIN && choice !== SOURCE_DESKTOP) {
              writeJson(res, 400, { ok: false, error: 'source must be "plugin" or "desktop"' })
              return
            }
            try {
              // A real choice also settles the question, so both flags land.
              await writeSourceChoice(choice)
              await writeSourcePromptSeen()
            } catch (error) {
              writeJson(res, 500, {
                ok: false,
                error: error instanceof Error ? error.message : 'write failed',
              })
              return
            }
            // Restart on the new source: the transport differs, so re-applying
            // options in place would leave the old client reading the wrong
            // product. A stop+launch is cheap (the discovery is cached in
            // `lastProbes`, and the first probe answers from cache in ~0.3s).
            stop()
            queued = false
            const next = resolveConfig(config)
            void discoverAndLaunch(ctx, { ...next, source: choice }).catch(() => {})
            writeJson(res, 200, { ok: true, source: choice })
            return
          }
          const active = service?.source ?? 'none'
          // No saved choice means the default applies, not `auto`: reporting
          // `auto` here would tell the panel the user opted into being asked.
          const saved = (await readSourceChoice().catch(() => undefined)) ?? DEFAULT_SOURCE
          const promptSeen = await readSourcePromptSeen().catch(() => false)
          // Probe live, not from `lastProbes`: the panel exists precisely so the
          // user can see the current state of both products, and that state
          // changes (the desktop app starts and stops, the plugin mounts a few
          // seconds after load).
          const probes = await discoverSources(ctx, resolveConfig(config))
          lastProbes = probes
          writeJson(res, 200, {
            ok: true,
            active,
            preference: saved,
            // Asked at most once. A dismissed question counts as answered: the
            // user has seen it and decided not to decide, which is different
            // from never having seen it, and re-asking on every start is nagging.
            needsChoice: !promptSeen && needsSourceChoice(saved, probes),
            // Where to change it later, so the prompt can say so instead of
            // leaving the user to hunt for the control.
            changeAt: '插件详情页 → 数据源',
            sources: describeSources(probes, active),
          })
        },
      },
      {
        kind: 'exact',
        path: API_PREFIX + '/refresh',
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const snapshot = await svc.refresh()
            writeJson(res, 200, { ok: true, warming: false, snapshot, report: svc.report() })
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: error instanceof Error ? error.message : 'refresh failed',
            })
          }
        },
      },
      {
        // The settings surface's data source: which channels exist, which the
        // profile declares, and which the user has hinted at.
        //
        // Carries the label for every channel so the browser needs no list of
        // its own — one source of truth, and a channel nobody anticipated still
        // gets a display name.
        kind: 'exact',
        path: API_PREFIX + '/channels',
        handler: (req, res) => {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
            return
          }
          const plan = svc.plan().map((entry) => ({ ...entry, label: channelLabel(entry.id) }))
          writeJson(res, 200, {
            ok: true,
            baseUrl: svc.options.baseUrl,
            credentialRoute: svc.options.credentialRoute,
            plan,
            report: svc.report(),
          })
        },
      },
      {
        // Persist the channel visibility overrides.
        //
        // Stored in this plugin's own settings file under `$DSH_HOME`, not in
        // the profile patch: the plugin mounts through its bundle's patch, so
        // there is no hand-written row for it in `cordis.patch.yml` and writing
        // one there would fail on every fresh install.
        kind: 'exact',
        path: API_PREFIX + '/visibility',
        handler: async (req, res) => {
          if (!isLoopback(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let body
          try {
            body = await readJsonBody(req)
          } catch (error) {
            writeJson(res, 400, {
              ok: false,
              error: error instanceof Error ? error.message : 'invalid body',
            })
            return
          }
          const hidden = normalizeIdList(body?.hidden)
          const revealed = normalizeIdList(body?.revealed)
          try {
            await writeVisibilitySettings(hidden, revealed)
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: error instanceof Error ? error.message : 'write failed',
            })
            return
          }
          // Apply immediately: waiting for a later reload would leave the
          // checkbox looking unresponsive.
          svc.applyOptions({ ...svc.options, hiddenChannels: hidden, revealedChannels: revealed })
          const plan = svc.plan().map((entry) => ({ ...entry, label: channelLabel(entry.id) }))
          writeJson(res, 200, { ok: true, plan })
        },
      },
    ]
    return routes.map((route) => ctx.webServer.register(route))
  }

  const launch = () => {
    queued = false
    if (!live || service !== undefined) return
    const value = resolveConfig(config)
    if (!value.enabled) return

    // Discovery decides which of the two Our Free Model products this card
    // reads. It runs before the service exists so the first probe already knows
    // its transport; a card that read the wrong product was the reported bug.
    void discoverAndLaunch(ctx, value).catch(() => {
      // Discovery never blocks the card: a failure leaves it on the desktop
      // path, which is where it was before this feature existed.
    })
  }

  /**
   * Probe both sources, resolve which one to read, then start the service.
   *
   * The order matters: `pluginRpc` is built from the live `connection` service,
   * so a composition without one simply has no plugin source and keeps the
   * desktop behaviour.
   *
   * @param {object} ctx Host context.
   * @param {ReturnType<typeof resolveConfig>} value Resolved settings.
   */
  async function discoverAndLaunch(ctx, value) {
    if (service !== undefined || !live) return

    // Retry while nothing is reachable. The first attempt after a cold boot
    // legitimately sees no plugin: the kernel publishes `connection` after the
    // browser half mounts, which is after plugins load. Settling on that first
    // empty answer is what produced `active: none`.
    const probes = await discoverSourcesSettled(ctx, value)
    lastProbes = probes

    // The settings row is a manual override; the remembered choice is what the
    // user actually picked in the UI (including "use the desktop app", which
    // must survive a restart even though the default is the plugin).
    //
    // Order: an explicit non-default settings value wins, then the choice saved
    // by the UI, then the plugin default. `resolveSource` then falls back when
    // the preferred source is unreachable, so a machine without the plugin
    // still reads the desktop app rather than showing an empty card.
    const saved = await readSourceChoice()
    const pinned = value.source
    const preference = pinned !== DEFAULT_SOURCE && pinned !== 'auto'
      ? pinned
      : (saved ?? DEFAULT_SOURCE)
    const chosen = resolveSource(preference, probes)

    if (service !== undefined || !live) return

    const options = {
      ...value,
      source: chosen,
      pluginRpc: chosen === SOURCE_PLUGIN ? makePluginRpc(ctx) : undefined,
    }
    const svc = new BalanceService(options, makeCredentialReader(ctx))
    service = svc
    svc.start()
    disposers = mountRoutes(svc)
    sessionDisposer = watchSessionRoutes(ctx, svc)

    // A settled `none` means neither product answered. That is not a dead end:
    // the desktop app can be started later, and the plugin's `connection`
    // service can appear late. Re-probe on a slow cadence and re-launch the
    // moment one of them shows up, so the card recovers without a restart.
    if (chosen === 'none') {
      sourceWatchTimer = setInterval(() => {
        void (async () => {
          if (!live) return
          const fresh = await discoverSources(ctx, resolveConfig(config))
          lastProbes = fresh
          if (resolveSource(preference, fresh) === 'none') return
          clearInterval(sourceWatchTimer)
          sourceWatchTimer = undefined
          stop()
          queued = false
          launch()
        })().catch(() => {})
      }, 30_000)
      if (typeof sourceWatchTimer?.unref === 'function') sourceWatchTimer.unref()
    }

    void readVisibilitySettings()
      .then((savedToggles) => {
        if (service !== svc) return
        svc.applyOptions({
          ...svc.options,
          hiddenChannels: savedToggles.hidden,
          revealedChannels: savedToggles.revealed,
        })
      })
      .catch(() => {})

    // No profile re-read timer any more: the channel inventory now comes from
    // the provider's own account list, which every probe cycle refreshes. The
    // old timer existed only because the profile patch was the authority, and
    // it was edited in another plugin row without reloading this one.
  }

  const stop = () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Route fiber already gone during shutdown.
      }
    }
    disposers = []
    try {
      sessionDisposer?.()
    } catch {
      // Listener already gone during shutdown.
    }
    sessionDisposer = undefined
    if (sourceWatchTimer !== undefined) {
      clearInterval(sourceWatchTimer)
      sourceWatchTimer = undefined
    }
    service?.stop()
    service = undefined
  }

  const rearm = () => {
    const value = resolveConfig(config)
    if (!value.enabled) {
      queued = false
      stop()
      return
    }
    if (service !== undefined) {
      // Already running: re-apply the scalar config in place, then re-read the
      // persisted toggles. The two steps are separate because the file read is
      // async — merging into `service.options` inside the callback races the
      // next rearm and leaves a stale override list behind.
      service.applyOptions({ ...value, hiddenChannels: [], revealedChannels: [] })
      void readVisibilitySettings()
        .then((saved) => {
          if (service === undefined) return
          service.applyOptions({
            ...service.options,
            hiddenChannels: saved.hidden,
            revealedChannels: saved.revealed,
          })
        })
        .catch(() => {})
      return
    }
    if (queued) return
    queued = true
    launch()
  }

  ctx.on('loader/volatile-update', () => {
    // Settings changed: drop the old activation so the new options (base URL,
    // credential route, poll cadence) actually take effect.
    stop()
    rearm()
  })

  ctx.effect(() => {
    rearm()
    return () => {
      live = false
      queued = false
      stop()
    }
  }, 'dsh-ofm-balance: runtime')
}
