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
import { readFileSync } from 'node:fs'
import { BalanceService, numberIn, stringOr } from './service.js'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from './gateway.js'
import { configuredChannelsFrom, parseChannelList, channelLabel } from './channels.js'
import { writeVisibilitySettings, readVisibilitySettings, profilePatchPath } from './patch.js'

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
 * Read the channels this profile routes through the watched provider.
 *
 * The profile's `llm-pi-ai` entry declares the route's models as
 * `<channel>/<model>` ids, so this is the user's own inventory — the set of
 * channels they actually spend through. That is the authority for "shown by
 * default", as opposed to the gateway's inventory, which is merely what it is
 * willing to serve.
 *
 * Best-effort: a host that does not expose the namespace leaves the list empty,
 * and the service keeps its seed plan.
 *
 * @param {object} ctx Host context.
 * @param {string} route Provider route key to read.
 * @returns {string[]} Channel ids declared by the profile.
 */
function readConfiguredChannels(ctx, route) {
  // Preferred: the live settings seam.
  const pi = readNamespace(ctx, 'llm-pi-ai')
  if (pi !== undefined) {
    const fromSeam = configuredChannelsFrom(pi, route)
    if (fromSeam.length > 0) return fromSeam
  }
  // Fallback: the profile patch on disk.
  //
  // Some hosts do not expose the `llm-pi-ai` namespace through the settings
  // service this plugin can reach (verified on 0.2.1-rc.2: the seam returns
  // undefined while the models are plainly declared in the patch). Without a
  // fallback every channel looks unconfigured, so the card would show nothing
  // and the settings panel would mark every vendor "未配置" — a wrong answer
  // presented confidently.
  return readConfiguredChannelsFromPatch(route)
}

/**
 * Extract a route's channel ids from the profile patch on disk.
 *
 * The patch declares the route's models as `<channel>/<model>` ids. Reading it
 * directly is a fallback, not the primary path: it is a text file the user may
 * be editing, and it can disagree with the running configuration until the next
 * reload. It is used only when the settings seam yields nothing.
 *
 * @param {string} route Provider route key.
 * @returns {string[]} Channel ids, or an empty list when the patch is unreadable.
 */
function readConfiguredChannelsFromPatch(route) {
  try {
    const text = readFileSync(profilePatchPath(), 'utf8')
    // Only look at the block that declares this route, so another provider's
    // model ids cannot be mistaken for ours.
    const routeAt = text.indexOf(route + ':')
    if (routeAt === -1) return []
    const block = text.slice(routeAt)
    const out = []
    const re = /^\s*-\s+id:\s*([A-Za-z0-9_-]+)\/[A-Za-z0-9_.-]+\s*$/gm
    let match
    while ((match = re.exec(block)) !== null) {
      const channel = match[1]
      if (!out.includes(channel)) out.push(channel)
    }
    return out
  } catch {
    return []
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
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let profileTimer

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
    const svc = new BalanceService(value, makeCredentialReader(ctx))
    // Seed the profile's own inventory before the first probe, so the default
    // card reflects the user's configuration rather than the gateway's catalog.
    svc.setConfiguredChannels(readConfiguredChannels(ctx, value.credentialRoute))
    service = svc
    svc.start()
    disposers = mountRoutes(svc)
    sessionDisposer = watchSessionRoutes(ctx, svc)

    // Restore the toggles the user set in the settings panel. Read after start
    // so a slow disk never delays the first paint; the overrides take effect on
    // the next probe, which is at most one poll interval away.
    //
    // An EMPTY result is applied too, not skipped: "no settings file" must clear
    // a previous activation's overrides, otherwise a deleted settings file
    // leaves the card filtering channels based on state nobody can see or edit.
    void readVisibilitySettings()
      .then((saved) => {
        if (service !== svc) return
        svc.applyOptions({
          ...svc.options,
          hiddenChannels: saved.hidden,
          revealedChannels: saved.revealed,
        })
      })
      .catch(() => {
        // A malformed settings file means "no overrides", not a broken plugin.
      })

    // The profile can be edited without reloading this plugin row (the model
    // list lives in another row's config), so re-read it on the poll cadence
    // rather than only at mount.
    profileTimer = setInterval(() => {
      if (service === undefined) return
      try {
        service.setConfiguredChannels(readConfiguredChannels(ctx, service.options.credentialRoute))
      } catch {
        // A transient read failure keeps the previous inventory.
      }
    }, 60_000)
    if (typeof profileTimer?.unref === 'function') profileTimer.unref()
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
    if (profileTimer !== undefined) {
      clearInterval(profileTimer)
      profileTimer = undefined
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
