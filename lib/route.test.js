/**
 * Route → channel mapping, for both Our Free Model products.
 *
 * The bug this file pins down: the collapsed strip named the wrong channel
 * whenever the conversation ran through the official plugin. The two products
 * announce a route differently —
 *
 *   desktop app:  provider `ourfreemodel`,  model `buddy/deepseek-v4.1-flash`
 *   plugin:       provider `workbuddy`,     model `deepseek-v4.1-flash`
 *
 * — and only the first shape was understood. The plugin's model id has no
 * channel prefix at all (each channel is its own LLM provider route), so the
 * prefix lookup produced `deepseek-v4.1-flash`, matched no row,
 * `currentChannel` stayed undefined, and the card fell back to "closest to
 * running out" instead of "what am I spending".
 *
 * Both shapes are exercised against one service so a fix for one cannot
 * silently break the other.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BalanceService } from './service.js'

/** A service with no I/O: the route memory is what is under test. */
function serviceWith(source, extra = {}) {
  const options = {
    baseUrl: 'http://127.0.0.1:18900',
    credentialRoute: 'ourfreemodel',
    pollIntervalSec: 60,
    timeoutMs: 5000,
    hiddenChannels: [],
    revealedChannels: [],
    source,
    ...extra,
  }
  return new BalanceService(options, { async read() { return undefined } })
}

test('desktop shape: the channel is the model prefix', () => {
  const svc = serviceWith('desktop')
  svc.noteRequestRoute('ourfreemodel', 'buddy/deepseek-v4.1-flash')
  assert.equal(svc.currentChannel, 'buddy')

  svc.noteRequestRoute('ourfreemodel', 'trae/glm-5.3-flash')
  assert.equal(svc.currentChannel, 'trae')
})

test('plugin shape: the provider route itself is the channel', () => {
  const svc = serviceWith('plugin')
  // The real event payload, measured from a live session log.
  svc.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(svc.currentChannel, 'workbuddy')

  svc.noteRequestRoute('trae', 'glm-5.3-flash')
  assert.equal(svc.currentChannel, 'trae')
})

test('the plugin shape works for a channel this build never heard of', () => {
  // The channel catalogue is a floor, not a filter: a deployment shipping a
  // new vendor must still highlight it. This is why the check is not limited
  // to the hardcoded id list alone — `accounts` and `discovered` feed it too.
  const svc = serviceWith('plugin')
  svc.setAccountChannels(['moonshot'])
  svc.noteRequestRoute('moonshot', 'kimi-k3')
  assert.equal(svc.currentChannel, 'moonshot')
})

test('a route outside both products is ignored, not guessed', () => {
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  // Another provider's traffic must not move the highlight.
  svc.noteRequestRoute('deepseek', 'deepseek-v4.1')
  assert.equal(svc.currentChannel, 'workbuddy')
})

test('a plain provider that happens to share a channel name is not adopted', () => {
  // `gemini` is both a channel-pack channel and a name a user may give their
  // own Gemini API provider. In desktop mode the card reads the desktop app,
  // so that traffic must not light up the row.
  const svc = serviceWith('desktop')
  svc.noteRequestRoute('gemini', 'gemini-3.8-flash')
  assert.equal(svc.currentChannel, undefined)
})

test('the plugin free lane clears the highlight instead of leaving it stale', () => {
  // `our-free-model` is the plugin's keyless lane: no account, no credits, so
  // no channel is being spent. Keeping the previous channel on screen would
  // claim a spend that is not happening.
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(svc.currentChannel, 'workbuddy')

  svc.noteRequestRoute('our-free-model', 'glm-5.3-flash-free')
  assert.equal(svc.currentChannel, undefined)
})

test('switching source drops the remembered route', () => {
  // The two products use overlapping channel names over separate account
  // pools, so a route remembered from the old source would highlight a row
  // whose number now comes from a different account.
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(svc.currentChannel, 'workbuddy')

  svc.refresh = async () => svc.current() ?? {}
  svc.applyOptions({ ...svc.options, source: 'desktop' })
  assert.equal(svc.currentChannel, undefined)
})

test('a route from the other product does not name a row', () => {
  // The two products keep separate account pools behind overlapping channel
  // names, so a desktop route while reading the plugin would name a row whose
  // number comes from a different account. Clearing is the honest answer.
  const pluginSource = serviceWith('plugin')
  pluginSource.noteRequestRoute('ourfreemodel', 'buddy/deepseek-v4.1-flash')
  assert.equal(pluginSource.currentChannel, undefined)

  const desktopSource = serviceWith('desktop')
  desktopSource.setAccountChannels(['workbuddy'])
  desktopSource.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(desktopSource.currentChannel, undefined)
})

test('a stale highlight is cleared when the conversation leaves the source', () => {
  // Start on a plugin channel, then the conversation moves to the desktop
  // gateway: the old channel must not stay lit.
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(svc.currentChannel, 'workbuddy')

  svc.noteRequestRoute('ourfreemodel', 'trae/glm-5.3-flash')
  assert.equal(svc.currentChannel, undefined)
})

test('before a source is settled either shape is accepted', () => {
  // `auto` means discovery has not resolved which product to read yet; refusing
  // both shapes there would leave the strip blank on a healthy machine.
  const auto = serviceWith('auto')
  auto.noteRequestRoute('workbuddy', 'deepseek-v4.1-flash')
  assert.equal(auto.currentChannel, 'workbuddy')

  const autoDesktop = serviceWith('auto')
  autoDesktop.noteRequestRoute('ourfreemodel', 'buddy/deepseek-v4.1-flash')
  assert.equal(autoDesktop.currentChannel, 'buddy')
})

test('malformed routes are ignored without throwing', () => {
  const svc = serviceWith('plugin')
  for (const bad of [undefined, null, '', 42, {}, []]) {
    svc.noteRequestRoute(bad, 'x/y')
  }
  assert.equal(svc.currentChannel, undefined)

  // The desktop shape needs a usable model id; a prefix-less one names nothing.
  const desktop = serviceWith('desktop')
  desktop.noteRequestRoute('ourfreemodel', 'deepseek-v4.1-flash')
  assert.equal(desktop.currentChannel, undefined)
  desktop.noteRequestRoute('ourfreemodel', undefined)
  assert.equal(desktop.currentChannel, undefined)
})

// ── per-session routes ───────────────────────────────────────────────────────
//
// The sidebar card is ONE element shared by every conversation. Keeping a
// single global channel meant it answered "which session sent a request most
// recently" — with two sessions open on different channels, the strip named a
// channel from a conversation the user was not reading. That was the reported
// bug: the card said `buddy` while the transcript was on `codearts`.

test('a request in another session does not move the displayed channel', () => {
  const svc = serviceWith('plugin')
  // The user is looking at session A, which last used codearts.
  svc.noteRequestRoute('codearts', 'deepseek-v4.1-flash', 'session-A')
  svc.setViewSession('session-A')
  assert.equal(svc.displayedChannel(), 'codearts')

  // Session B (a background agent, another tab) sends a request on buddy.
  svc.noteRequestRoute('buddy', 'glm-5.3-flash', 'session-B')
  // The card must keep naming what the user is actually reading.
  assert.equal(svc.displayedChannel(), 'codearts')
})

test('switching the viewed session switches the displayed channel', () => {
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('codearts', 'deepseek-v4.1-flash', 'session-A')
  svc.noteRequestRoute('buddy', 'glm-5.3-flash', 'session-B')

  svc.setViewSession('session-A')
  assert.equal(svc.displayedChannel(), 'codearts')

  svc.setViewSession('session-B')
  assert.equal(svc.displayedChannel(), 'buddy')
})

test('a viewed session that has not sent a request shows nothing, not another session', () => {
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('buddy', 'glm-5.3-flash', 'session-A')
  // A brand-new conversation: no route yet. Naming session A's channel here is
  // exactly the mismatch being fixed.
  svc.setViewSession('session-new')
  assert.equal(svc.displayedChannel(), undefined)
})

test('without a reported session the global fallback still answers', () => {
  // A client that cannot tell us which conversation is on screen must not lose
  // the strip entirely.
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('buddy', 'glm-5.3-flash', 'session-A')
  assert.equal(svc.displayedChannel(), 'buddy')

  // And clearing the view returns to that fallback.
  svc.setViewSession('session-A')
  assert.equal(svc.displayedChannel(), 'buddy')
  svc.setViewSession(undefined)
  assert.equal(svc.displayedChannel(), 'buddy')
})

test('a route outside both products leaves per-session state untouched', () => {
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('codearts', 'deepseek-v4.1-flash', 'session-A')
  svc.setViewSession('session-A')

  // Someone else's provider must not clear or overwrite this card's answer.
  svc.noteRequestRoute('deepseek', 'deepseek-v4.1', 'session-A')
  assert.equal(svc.displayedChannel(), 'codearts')
})

test('switching source clears per-session routes too', () => {
  const svc = serviceWith('plugin')
  svc.noteRequestRoute('codearts', 'deepseek-v4.1-flash', 'session-A')
  svc.setViewSession('session-A')
  assert.equal(svc.displayedChannel(), 'codearts')

  svc.refresh = async () => svc.current() ?? {}
  svc.applyOptions({ ...svc.options, source: 'desktop' })
  // The numbers now come from the other product's account pool, so the old
  // channel would highlight a row backed by a different account.
  assert.equal(svc.displayedChannel(), undefined)
})
