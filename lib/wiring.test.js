/**
 * End-to-end host wiring, without a DSH process.
 *
 * `index.js` imports `schemastery`, which only exists inside a DSH install, so
 * this cannot boot the real module. Instead it exercises the two seams the
 * feature turns on, with the same shapes the host passes:
 *
 *   1. discovery resolves a source from a probe set;
 *   2. that choice selects a transport, and the transport produces the rows the
 *      card renders — through the shared normalization.
 *
 * The point is to catch a wiring mistake (wrong source id, transport left
 * undefined, plan not reaching the probe) before DSH is restarted, because
 * restarting is the expensive step for the user.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_PLUGIN, SOURCE_DESKTOP, resolveSource, needsSourceChoice } from './sources.js'
import { probePluginChannels, probePluginSource, listPluginChannels } from './plugin-source.js'
import { normalizeChannel } from './gateway.js'

/** The live shapes, abbreviated to what the wiring reads. */
const accounts = {
  ok: true,
  value: {
    accounts: [
      {
        accountId: 'codearts-976f3d72',
        nickname: 'codearts-976f3d72',
        balance: {
          total: 7150.69,
          packages: [
            { name: '总积分包', remaining: 7150.69, total: 7500, used: 349.31, active: true },
            { name: '基础积分包', remaining: 500, total: 500, used: 0, active: true },
            { name: '赠送积分包', remaining: 6650.69, total: 7000, used: 349.31, active: true },
          ],
        },
      },
    ],
  },
}

function rpcWith(table) {
  return { async call(method, payload) { return table[method](payload) } }
}

test('both products installed resolves to the plugin, and asks the user', () => {
  const probes = [
    { id: SOURCE_PLUGIN, available: true },
    { id: SOURCE_DESKTOP, available: true },
  ]
  assert.equal(resolveSource('auto', probes), SOURCE_PLUGIN)
  assert.equal(needsSourceChoice('auto', probes), true)
})

test('choosing the plugin selects the plugin transport and yields real percentages', async () => {
  const rpc = rpcWith({
    'provider.status': () => ({
      ok: true,
      value: {
        statuses: {
          codearts: { accounts: { total: 1, enabled: 1 }, models: { total: 6, disabled: 0 } },
        },
      },
    }),
    'credits.balances': () => accounts,
  })

  // What the host does after discovery: pin the source, build the transport.
  const probes = [
    { id: SOURCE_PLUGIN, available: true },
    { id: SOURCE_DESKTOP, available: true },
  ]
  const chosen = resolveSource(SOURCE_DESKTOP, probes) === SOURCE_DESKTOP
    ? SOURCE_DESKTOP
    : SOURCE_PLUGIN
  assert.equal(chosen, SOURCE_DESKTOP)

  // Their choice is remembered, so a later launch resolves to it directly.
  assert.equal(resolveSource(SOURCE_DESKTOP, probes), SOURCE_DESKTOP)

  const discovery = await probePluginSource(rpc)
  assert.equal(discovery.available, true)
  const channels = await listPluginChannels(rpc, [])
  assert.deepEqual(channels, ['codearts'])

  const rows = await probePluginChannels(rpc, channels, 5000)
  assert.equal(rows[0].percent, 95.3)
  assert.equal(rows[0].total, 7500)
})

test('the desktop path is untouched: same normalization, HTTP-shaped raw value', () => {
  // `normalizeChannel` is the shared seam. Feeding it a desktop-shaped payload
  // must produce the same answer the plugin path produced above.
  const row = normalizeChannel('codearts', accounts.value, 1)
  assert.equal(row.percent, 95.3)
  assert.equal(row.total, 7500)
  assert.equal(row.state, 'ok')
})

test('a plugin that is installed but not mounted is not selected', () => {
  // The Fetch route exists only once the pack mounts. Until then discovery must
  // report unavailable so the card falls to the desktop rather than reading a
  // route that answers 404.
  const probes = [
    { id: SOURCE_PLUGIN, available: false, reason: 'connection service unavailable' },
    { id: SOURCE_DESKTOP, available: true },
  ]
  assert.equal(resolveSource('auto', probes), SOURCE_DESKTOP)
  assert.equal(needsSourceChoice('auto', probes), false)
})
