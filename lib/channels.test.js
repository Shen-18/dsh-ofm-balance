/**
 * Unit tests for the pure channel-classification rules.
 *
 * Run with: node --test lib/channels.test.js
 *
 * These cover the policy that is easiest to get wrong and hardest to notice:
 * which channels earn a row, and what the card says about the ones it shows
 * but the user never configured.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  VISIBILITY,
  parseChannelList,
  configuredChannelsFrom,
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

test('configuredChannelsFrom reads the model-id prefix as the channel', () => {
  const pi = {
    providers: {
      ourfreemodel: {
        models: [
          { id: 'trae/deepseek-v4.1-flash' },
          { id: 'trae/glm-5.3' },
          { id: 'codearts/glm-5.3' },
          { id: 'no-slash-model' },
          { id: '/leading-slash' },
          { id: 'buddy/deepseek-v4-pro' },
        ],
      },
    },
  }
  assert.deepEqual(configuredChannelsFrom(pi, 'ourfreemodel'), ['trae', 'codearts', 'buddy'])
})

test('configuredChannelsFrom tolerates a missing route or models', () => {
  assert.deepEqual(configuredChannelsFrom(undefined, 'ourfreemodel'), [])
  assert.deepEqual(configuredChannelsFrom({}, 'ourfreemodel'), [])
  assert.deepEqual(configuredChannelsFrom({ providers: {} }, 'ourfreemodel'), [])
  assert.deepEqual(configuredChannelsFrom({ providers: { ourfreemodel: {} } }, 'ourfreemodel'), [])
})

test('a configured channel is visible by default', () => {
  const plan = classifyChannels({
    configured: ['trae', 'codearts'],
    discovered: ['trae', 'codearts', 'buddy'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.trae.visible, true)
  assert.equal(byId.trae.visibility, VISIBILITY.CONFIGURED)
  assert.equal(byId.trae.configured, true)
  assert.equal(byId.codearts.visible, true)
})

test('an unconfigured but discovered channel is hidden by default', () => {
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['trae', 'buddy', 'gemini'],
    hidden: [],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, false, 'the gateway inventory alone is not a reason to show a row')
  assert.equal(byId.buddy.visibility, VISIBILITY.HIDDEN_UNCONFIGURED)
  assert.equal(byId.gemini.visible, false)
  assert.equal(byId.trae.visible, true)
})

test('revealing an unconfigured channel shows it with a warning', () => {
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['trae', 'buddy'],
    hidden: [],
    revealed: ['buddy'],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, true)
  assert.equal(byId.buddy.visibility, VISIBILITY.REVEALED)
  assert.equal(byId.buddy.configured, false)
  assert.match(byId.buddy.warning ?? '', /尚未配置/)
})

test('hiding a configured channel wins over the configuration default', () => {
  const plan = classifyChannels({
    configured: ['trae', 'codearts'],
    discovered: ['trae', 'codearts'],
    hidden: ['codearts'],
    revealed: [],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.codearts.visible, false)
  assert.equal(byId.codearts.visibility, VISIBILITY.HIDDEN_BY_USER)
  assert.equal(byId.trae.visible, true)
})

test('a revealed channel survives the gateway dropping it', () => {
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['trae'],
    hidden: [],
    revealed: ['buddy'],
  })
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.buddy.visible, true, 'the user asked for it, so it stays on the list')
  assert.equal(byId.buddy.discovered, false)
})

test('ordering puts configured channels first, then discovered alphabetically', () => {
  const plan = classifyChannels({
    configured: ['trae', 'codearts'],
    discovered: ['qoder', 'buddy', 'trae', 'codearts'],
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(plan.map((e) => e.id), ['trae', 'codearts', 'buddy', 'qoder'])
})

test('channelsToProbe skips hidden rows so a poll is not spent on invisible data', () => {
  const plan = classifyChannels({
    configured: ['trae', 'codearts'],
    discovered: ['trae', 'codearts', 'buddy'],
    hidden: ['codearts'],
    revealed: [],
  })
  assert.deepEqual(channelsToProbe(plan), ['trae'])
})

test('mergePlanWithRows keeps plan order and attaches the configured flag', () => {
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['trae', 'buddy'],
    hidden: [],
    revealed: ['buddy'],
  })
  const rows = mergePlanWithRows(plan, [
    { channel: 'buddy', state: 'ok', remaining: 100 },
    { channel: 'trae', state: 'ok', remaining: 500 },
  ])
  assert.deepEqual(rows.map((r) => r.channel), ['trae', 'buddy'])
  assert.equal(rows[0].configured, true)
  assert.equal(rows[1].configured, false)
  assert.match(rows[1].warning ?? '', /尚未配置/)
})

test('mergePlanWithRows reports a visible channel the gateway never answered', () => {
  const plan = classifyChannels({
    configured: ['trae', 'ghost'],
    discovered: ['trae'],
    hidden: [],
    revealed: [],
  })
  const rows = mergePlanWithRows(plan, [{ channel: 'trae', state: 'ok' }])
  const ghost = rows.find((r) => r.channel === 'ghost')
  assert.ok(ghost !== undefined, 'a configured channel stays visible even when the gateway omits it')
  assert.equal(ghost.state, 'error')
  assert.match(ghost.error, /网关未提供/)
})

test('a probe result never gets overwritten by the pending state', () => {
  // The first paint must be able to show channel names before numbers arrive,
  // and a settled result must win once it exists. This is the regression guard
  // for "the card is blank until I click something".
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['trae'],
    hidden: [],
    revealed: [],
  })
  const pending = mergePlanWithRows(plan, [])
  assert.equal(pending[0].state, 'error', 'with no probe result the row reports why')
  const settled = mergePlanWithRows(plan, [{ channel: 'trae', state: 'ok', remaining: 10 }])
  assert.equal(settled[0].state, 'ok')
  assert.equal(settled[0].remaining, 10)
})

test('the full catalogue appears even when the gateway advertises nothing', () => {
  // The reported bug: /v1/models only lists channels with routed models, so a
  // gateway with thirteen vendors showed six. The catalogue is the floor.
  const KNOWN = ['codearts', 'buddy', 'workbuddy', 'trae', 'gemini']
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: [],
    known: KNOWN,
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(
    plan.map((e) => e.id).sort(),
    [...KNOWN].sort(),
    'every catalogue channel is listed',
  )
  assert.equal(plan[0].id, 'trae', 'the configured channel is listed first')
  const byId = Object.fromEntries(plan.map((e) => [e.id, e]))
  assert.equal(byId.trae.visible, true, 'configured stays visible')
  assert.equal(byId.buddy.visible, false, 'unconfigured stays hidden by default')
  assert.equal(byId.workbuddy.visible, false)
})

test('configured order wins over the catalogue order', () => {
  const plan = classifyChannels({
    configured: ['trae', 'codearts'],
    discovered: [],
    known: ['codearts', 'buddy', 'trae'],
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(plan.map((e) => e.id), ['trae', 'codearts', 'buddy'])
})

test('a channel outside the catalogue still appears when the gateway advertises it', () => {
  // Generality guard: a deployment shipping a vendor this build never heard of
  // must still work.
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['some-new-vendor'],
    known: ['trae', 'codearts'],
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(plan.map((e) => e.id), ['trae', 'codearts', 'some-new-vendor'])
})

test('nothing is lost when known is omitted', () => {
  const plan = classifyChannels({
    configured: ['trae'],
    discovered: ['buddy'],
    hidden: [],
    revealed: [],
  })
  assert.deepEqual(plan.map((e) => e.id), ['trae', 'buddy'])
})
