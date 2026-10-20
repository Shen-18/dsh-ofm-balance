/**
 * Profile-patch writer — the only code in this plugin that rewrites a file the
 * user owns.
 *
 * Why a text-level edit instead of a YAML round-trip: the profile patch is a
 * hand-maintained document. It carries explanatory comments, other plugins'
 * rows, and `!!js` loader expressions. Parsing and re-serializing it would drop
 * the comments and could reinterpret the expressions, which turns a two-key
 * settings change into a corrupted profile.
 *
 * So the writer touches exactly one block — this plugin's own row — and leaves
 * every other byte of the document alone.
 *
 * Kept out of `index.js` so it can be tested without the host's runtime
 * dependencies (that module imports `schemastery`, which only exists inside a
 * DSH installation).
 *
 * @module dsh-ofm-balance/patch
 */

import { readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The loader row id this plugin mounts under. */
export const ROW_ID = 'ofm-balance'

/**
 * Where the plugin keeps its own user settings.
 *
 * NOT the profile patch: this plugin is mounted through its bundle's patch
 * (the `dsh.bundle.patch` manifest), not through a row the user hand-wrote, so
 * there is no `- id: ofm-balance` block in `cordis.patch.yml` to edit. Trying
 * to write one there would fail on every fresh install — verified against a
 * real profile where the row genuinely does not exist.
 *
 * A small JSON file under `$DSH_HOME` is the right home: it is ours, it cannot
 * corrupt the profile, and it survives plugin upgrades.
 *
 * @returns {string} Absolute path to `settings.json`.
 */
export function settingsPath() {
  return join(dshHome(), 'dsh-ofm-balance', 'settings.json')
}

/**
 * Resolve the DSH home the host is using.
 * @returns {string} Absolute path to the home directory.
 */
function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

/**
 * Path of the profile patch that declares this plugin's provider route.
 *
 * Used read-only, as a fallback for the settings seam: some hosts do not expose
 * the `llm-pi-ai` namespace to a plugin, and without reading the patch the card
 * cannot tell which channels are configured.
 *
 * @returns {string} Absolute path to `cordis.patch.yml`.
 */
export function profilePatchPath() {
  const profile = typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== ''
    ? process.env.DSH_PROFILE
    : 'desktop'
  return join(dshHome(), 'profiles', profile, 'cordis.patch.yml')
}

/**
 * Read the persisted visibility overrides.
 *
 * Best-effort: a missing or malformed file means "no overrides", which is the
 * default behaviour rather than an error the user has to resolve.
 *
 * @returns {Promise<{ hidden: string[], revealed: string[] }>} The overrides.
 */
export async function readVisibilitySettings() {
  let raw
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch {
    return { hidden: [], revealed: [] }
  }
  try {
    const parsed = JSON.parse(raw)
    return {
      hidden: flowListOf(parsed?.hidden),
      revealed: flowListOf(parsed?.revealed),
    }
  } catch {
    return { hidden: [], revealed: [] }
  }
}

/**
 * Persist the visibility overrides.
 *
 * Atomic (write-temp-then-rename), so an interrupted save leaves the previous
 * settings intact instead of a half-written JSON file the next boot cannot read.
 *
 * @param {readonly string[]} hidden Configured channels to hide.
 * @param {readonly string[]} revealed Unconfigured channels to reveal.
 * @returns {Promise<void>} Resolves once the file is replaced.
 */
export async function writeVisibilitySettings(hidden, revealed) {
  const path = settingsPath()
  const dir = dirname(path)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  const body = JSON.stringify({ version: 1, hidden: [...hidden], revealed: [...revealed] }, null, 2)
  const tmp = join(dir, `.settings.${process.pid}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

/**
 * Read the user's remembered data-source choice.
 *
 * Kept in the same settings file as the toggles but written by its own
 * function: the two are independent (hiding a channel must not overwrite the
 * source choice and vice versa), and sharing one writer would make every
 * settings save carry the other's current in-memory state, which re-arms races.
 *
 * @returns {Promise<string | undefined>} `plugin`, `desktop`, or undefined when
 *   the user has not chosen yet.
 */
export async function readSourceChoice() {
  let raw
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const value = JSON.parse(raw)?.source
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the user's data-source choice, preserving the other keys.
 *
 * Read-modify-write of one small JSON file under a lock-free atomic rename. A
 * concurrent toggle write could in principle interleave, but both writers are
 * driven by the same browser form and the loss is one setting the user can
 * simply change again — not worth a lock for.
 *
 * @param {string} source `plugin` or `desktop`.
 * @returns {Promise<void>} Resolves once the file is replaced.
 */
export async function writeSourceChoice(source) {
  const path = settingsPath()
  const dir = dirname(path)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  let existing = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) ?? {}
  } catch {
    existing = {}
  }
  const body = JSON.stringify({ ...existing, version: 1, source }, null, 2)
  const tmp = join(dir, `.settings.${process.pid}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

/**
 * Record that the source question has been put to the user, without pinning a
 * source.
 *
 * The distinction matters: "the user chose plugin" and "the user dismissed the
 * question" are different states. Both mean *stop asking*, but only the first
 * means *never fall back to the other product*. Storing a bare `source` cannot
 * express the second, so a dismissed question used to come back on every start.
 *
 * Written separately from {@link writeSourceChoice} so dismissing never
 * overwrites a real choice.
 *
 * @returns {Promise<void>} Resolves once the flag is on disk.
 */
export async function writeSourcePromptSeen() {
  const path = settingsPath()
  const dir = dirname(path)
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dir, { recursive: true })
  let existing = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) ?? {}
  } catch {
    existing = {}
  }
  const body = JSON.stringify({ ...existing, version: 1, sourcePromptSeen: true }, null, 2)
  const tmp = join(dir, `.settings.${process.pid}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

/**
 * Whether the source question has already been answered or dismissed.
 *
 * @returns {Promise<boolean>} True once the user has seen the prompt.
 */
export async function readSourcePromptSeen() {
  let raw
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch {
    return false
  }
  try {
    return JSON.parse(raw)?.sourcePromptSeen === true
  } catch {
    return false
  }
}

/**
 * Coerce an unknown JSON value into a list of channel ids.
 * @param {unknown} value Raw value.
 * @returns {string[]} Trimmed, de-duplicated ids.
 */
function flowListOf(value) {
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
 * Render a list as a YAML flow sequence of JSON strings.
 * @param {readonly string[]} ids Channel ids.
 * @returns {string} e.g. `["qoder", "gemini"]`.
 */
function flowList(ids) {
  return `[${ids.map((id) => JSON.stringify(id)).join(', ')}]`
}
