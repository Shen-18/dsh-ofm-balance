/**
 * Data-source rules.
 *
 * The interesting cases are the ones the user hits: both products installed,
 * one of them gone after being chosen, and nobody having chosen yet.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE_PLUGIN,
  SOURCE_DESKTOP,
  resolveSource,
  needsSourceChoice,
  describeSources,
} from './sources.js'

const both = [
  { id: SOURCE_PLUGIN, available: true, channels: 3 },
  { id: SOURCE_DESKTOP, available: true, channels: 6 },
]
const pluginOnly = [
  { id: SOURCE_PLUGIN, available: true, channels: 3 },
  { id: SOURCE_DESKTOP, available: false, reason: '未监听' },
]
const desktopOnly = [
  { id: SOURCE_PLUGIN, available: false, reason: '内核未提供 connection 服务' },
  { id: SOURCE_DESKTOP, available: true, channels: 6 },
]
const neither = [
  { id: SOURCE_PLUGIN, available: false, reason: '内核未提供 connection 服务' },
  { id: SOURCE_DESKTOP, available: false, reason: '未监听' },
]

test('auto with one source uses it, without asking', () => {
  assert.equal(resolveSource('auto', pluginOnly), SOURCE_PLUGIN)
  assert.equal(resolveSource('auto', desktopOnly), SOURCE_DESKTOP)
})

test('auto with both prefers the plugin, because that is the one inside DSH', () => {
  assert.equal(resolveSource('auto', both), SOURCE_PLUGIN)
})

test('auto with neither answers none rather than guessing', () => {
  assert.equal(resolveSource('auto', neither), 'none')
})

test('an explicit choice wins while that source is reachable', () => {
  assert.equal(resolveSource(SOURCE_PLUGIN, both), SOURCE_PLUGIN)
  assert.equal(resolveSource(SOURCE_DESKTOP, both), SOURCE_DESKTOP)
})

test('a choice whose source disappeared falls back instead of showing nothing', () => {
  // The user picked the desktop app, then stopped running it. Pinning the card
  // to an empty answer would look like a broken plugin.
  assert.equal(resolveSource(SOURCE_DESKTOP, pluginOnly), SOURCE_PLUGIN)
  // And the reverse: they picked the plugin, then uninstalled it.
  assert.equal(resolveSource(SOURCE_PLUGIN, desktopOnly), SOURCE_DESKTOP)
})

test('a stale choice with nothing reachable answers none', () => {
  assert.equal(resolveSource(SOURCE_PLUGIN, neither), 'none')
  assert.equal(resolveSource(SOURCE_DESKTOP, neither), 'none')
})

test('the user is asked only when two sources are live and nothing is remembered', () => {
  assert.equal(needsSourceChoice('auto', both), true)
  // One source is not ambiguous, so it must not interrupt the first run.
  assert.equal(needsSourceChoice('auto', pluginOnly), false)
  assert.equal(needsSourceChoice('auto', desktopOnly), false)
  assert.equal(needsSourceChoice('auto', neither), false)
  // A remembered answer settles it for good.
  assert.equal(needsSourceChoice(SOURCE_PLUGIN, both), false)
  assert.equal(needsSourceChoice(SOURCE_DESKTOP, both), false)
})

test('descriptions name both sources and mark which one is live', () => {
  const described = describeSources(both, SOURCE_PLUGIN)
  assert.equal(described.length, 2)
  const plugin = described.find((entry) => entry.id === SOURCE_PLUGIN)
  const desktop = described.find((entry) => entry.id === SOURCE_DESKTOP)
  assert.equal(plugin.active, true)
  assert.equal(desktop.active, false)
  assert.equal(plugin.label, 'DSH 插件')
  assert.equal(desktop.label, '桌面应用')
  assert.match(plugin.detail, /3 个渠道/)
})

test('an unavailable source carries the reason it is unavailable', () => {
  const described = describeSources(desktopOnly, SOURCE_DESKTOP)
  const plugin = described.find((entry) => entry.id === SOURCE_PLUGIN)
  assert.equal(plugin.available, false)
  assert.equal(plugin.active, false)
  assert.match(plugin.detail, /connection/)
})

test('a source that is not active is never marked active, even if reachable', () => {
  const described = describeSources(both, 'none')
  assert.equal(described.some((entry) => entry.active), false)
})
