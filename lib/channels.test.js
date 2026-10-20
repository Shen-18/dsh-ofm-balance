/**
 * Unit tests for the pure channel-classification rules.
 *
 * Run with: node --test lib/channels.test.js
 *
 * These cover the policy that is easiest to get wrong and hardest to notice:
 * which channels earn a row, and what the card says about the ones it shows
 * that have no account behind them.
 *
 * The judgement changed in 0.7.0: the authority moved from "the DSH profile
 * declares a model route here" to "the provider reports a logged-in account".
 * The tests below state that rule directly, including the two ways the old rule
 * was wrong.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VISIBILITY,
  parseChannelList,
  classifyChannels,
  channelsToProbe,
  mergePlanWithRows,
} from './channels.js'

test('parseChannelList tolerates lists typed by a human', () => {
  assert.deepEqual(parseChannelList('trae, codearts'), ['trae', 'codearts'])
  assert.deepEqual(parseChannelList('trae，codearts'), ['trae', 'codearts'], 'full-width comma')
  assert.deepEqual(parseChannelList('trae  codearts\nbuddy'), ['trae', 'codearts', 'buddy'], 'whitespace separated')
  assert.deepEqual(parseChannelList('trae,trae,trae'), ['trae'], 'deduplicated')
  assert.deepEqual(parseChannelList('  '), [])
  assert.deepEqual(parseChannelList(''), [])
  assert.deepEqual(parseChannelList(undefined), [])
  assert.deepEqual(parseChannelList(['trae', '', 'codearts']), ['trae', 'codearts'], 'array form')
})

test('a channel with a logged-in account is visible by default', () => {
  const plan = classifyChannels({
    accounts: ['trae', 'codearts'],
    discovered: ['trae', 'codearts', 'buddy'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.trae.visible, true)
  assert.equal(byId.trae.visibility, VISIBILITY.ACCOUNT)
  assert.equal(byId.trae.hasAccount, true)
  assert.equal(byId.codearts.visible, true)
})

test('a channel with no account is hidden by default, even when advertised', () => {
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['trae', 'buddy', 'gemini'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, false, 'the gateway inventory alone is not a reason to show a row')
  assert.equal(byId.buddy.visibility, VISIBILITY.HIDDEN_NO_ACCOUNT)
  assert.equal(byId.gemini.visible, false)
  assert.equal(byId.trae.visible, true)
})

test('a stale profile declaration does not earn a row once its account is gone', () => {
  // The first way the old rule failed: the profile keeps naming a channel long
  // after the account behind it disappeared, so the card filled with rows that
  // could never show a number. Doubling as the catalogue entry must not matter:
  // here `trae` is in `known` and `discovered` but has no account.
  const plan = classifyChannels({
    accounts: [],
    discovered: ['trae'],
    known: ['trae', 'codearts'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.trae.visible, false, 'no account means no default row')
  assert.equal(byId.trae.hasAccount, false)
  assert.equal(byId.codearts.visible, false)
})

test('a freshly logged-in channel outside the catalogue still earns a row', () => {
  // The second way the old rule failed: a channel the user just logged into may
  // not be in the profile or the catalogue yet, and it stayed invisible.
  const plan = classifyChannels({
    accounts: ['brand-new-vendor'],
    discovered: [],
    known: ['trae'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId['brand-new-vendor'].visible, true)
  assert.equal(byId['brand-new-vendor'].visibility, VISIBILITY.ACCOUNT)
})

test('revealing an account-less channel shows it with a warning', () => {
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['trae', 'buddy'],
    hidden: [],
    revealed: ['buddy'],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, true)
  assert.equal(byId.buddy.visibility, VISIBILITY.REVEALED)
  assert.equal(byId.buddy.hasAccount, false)
  assert.match(byId.buddy.warning ?? '', /尚未登录/)
})

test('hiding a channel with an account wins over the default', () => {
  const plan = classifyChannels({
    accounts: ['trae', 'codearts'],
    discovered: ['trae', 'codearts'],
    hidden: ['codearts'],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.codearts.visible, false)
  assert.equal(byId.codearts.visibility, VISIBILITY.HIDDEN_BY_USER)
  assert.equal(byId.trae.visible, true)
})

test('a revealed channel survives the provider dropping it', () => {
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['trae'],
    hidden: [],
    revealed: ['buddy'],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, true, 'revealed means the user asked for it, reachable or not')
})

test('ordering puts account holders first, then the catalogue', () => {
  const plan = classifyChannels({
    accounts: ['trae', 'codearts'],
    discovered: [],
    known: ['trae', 'codearts', 'buddy', 'gemini'],
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(
    plan.map((e) => e.id),
    ['trae', 'codearts', 'buddy', 'gemini'],
  )
})

test('mergePlanWithRows keeps plan order and attaches the account flag', () => {
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['buddy'],
    hidden: [],
    revealed: ['buddy'],
  })
  const rows = mergePlanWithRows(plan, [
    { channel: 'buddy', state: 'ok' },
    { channel: 'trae', state: 'ok' },
  ])
  // The plan's order wins, not the probe's arrival order.
  assert.deepEqual(
    rows.map((r) => r.channel),
    ['trae', 'buddy'],
  )
  assert.equal(rows[0].hasAccount, true)
  assert.equal(rows[1].hasAccount, false)
  assert.match(rows[1].warning ?? '', /尚未登录/)
})

test('a visible channel the provider never reports keeps an honest row', () => {
  const plan = classifyChannels({
    accounts: ['trae', 'ghost'],
    discovered: ['trae'],
    known: ['ghost'],
    hidden: [],
    revealed: [],
  })
  const rows = mergePlanWithRows(plan, [{ channel: 'trae', state: 'ok' }])
  const ghost = rows.find((r) => r.channel === 'ghost')
  assert.ok(ghost !== undefined, 'an account-holding channel stays visible even when omitted')
  assert.equal(ghost.state, 'error')
  assert.match(ghost.error, /未提供/)
})

test('channelsToProbe asks only for the visible rows', () => {
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['trae', 'buddy'],
    hidden: [],
    revealed: ['buddy'],
  })
  assert.deepEqual(channelsToProbe(plan).sort(), ['buddy', 'trae'])
})

test('a hidden channel is not probed, so it costs no request', () => {
  const plan = classifyChannels({
    accounts: ['trae', 'codearts'],
    discovered: ['trae', 'codearts'],
    hidden: ['codearts'],
    revealed: [],
  })
  assert.deepEqual(channelsToProbe(plan), ['trae'])
})

test('revealing wins when a name appears in both lists', () => {
  // `hidden` only has meaning for a channel that would otherwise show — i.e. one
  // with an account. For an account-less channel the two lists disagree, and
  // revealing is the one the user just asked for.
  const plan = classifyChannels({
    accounts: ['trae'],
    discovered: ['buddy'],
    hidden: ['buddy'],
    revealed: ['buddy'],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, true)
  assert.equal(byId.buddy.visibility, VISIBILITY.REVEALED)
})

test('an empty account list leaves every catalogue channel hidden', () => {
  const plan = classifyChannels({
    accounts: [],
    discovered: [],
    known: ['trae', 'codearts', 'buddy'],
    hidden: [],
    revealed: [],
  })
  assert.equal(plan.every((e) => e.visible === false), true)
  assert.deepEqual(channelsToProbe(plan), [])
})
