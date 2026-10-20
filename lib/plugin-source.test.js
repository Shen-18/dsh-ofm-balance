/**
 * The in-DSH source: transport shape and normalization reuse.
 *
 * Fixtures are the shapes the official plugin actually answers with, taken from
 * a live probe of `credits.balances` against the installed `dsh-our-free-model`
 * 2.5.6 (codearts aggregate + buddy lapsed bundles), so a schema change upstream
 * surfaces as a test failure instead of a wrong number on the card.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANNEL_PACK_PATH,
  CHANNEL_PACK_METHOD,
  makePluginRpc,
  ownerPeer,
  probePluginChannels,
  probePluginSource,
  listPluginChannels,
} from './plugin-source.js'

/** A caller that records what it was asked and answers from a table. */
function fakeRpc(table) {
  const calls = []
  return {
    calls,
    async call(method, payload, signal) {
      calls.push({ method, payload, signal })
      const handler = table[method]
      if (handler === undefined) throw new Error(`unexpected method ${method}`)
      return handler(payload)
    },
  }
}

/** Real codearts shape: an aggregate bundle whose remaining equals balance.total. */
const codearts = {
  ok: true,
  value: {
    accounts: [
      {
        accountId: 'codearts-976f3d72',
        nickname: 'codearts-976f3d72',
        balance: {
          total: 7150.69,
          packages: [
            { name: '总积分包', unit: 'credit', remaining: 7150.69, total: 7500, used: 349.31, active: true },
            { name: '基础积分包', unit: 'credit', remaining: 500, total: 500, used: 0, active: true },
            { name: '赠送积分包', unit: 'credit', remaining: 6650.69, total: 7000, used: 349.31, active: true },
          ],
        },
      },
    ],
  },
}

test('the route path and RPC endpoint are the ones the official plugin registers', () => {
  // A mismatch here is the whole failure mode: the handler rejects a `method`
  // that does not equal the path segment, answering gateway/bad-request.
  assert.equal(CHANNEL_PACK_PATH, '/api/channel-pack')
  assert.equal(CHANNEL_PACK_METHOD, 'channel-pack')
})

test('channel payloads normalize through the shared arithmetic', async () => {
  const rpc = fakeRpc({ 'credits.balances': () => codearts })
  const rows = await probePluginChannels(rpc, ['codearts'], 5000)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.channel, 'codearts')
  assert.equal(row.state, 'ok')
  assert.equal(row.remaining, 7150.69)
  // The aggregate must not be double-counted: 7500, not 7500 + 350.
  assert.equal(row.total, 7500)
  assert.equal(row.percent, 95.3)
})

test('a lapsed bundle is excluded exactly as on the desktop path', async () => {
  // Real buddy shape: the four expired 裂变包 carry total 100 / used 100 /
  // remaining 0 each. Counting them would inflate the divisor by 400.
  const buddy = {
    ok: true,
    value: {
      accounts: [
        {
          accountId: 'buddy-1',
          nickname: 'Shen',
          balance: {
            total: 3896.29,
            packages: [
              { name: '体验版', unit: 'credits', remaining: 354.06, total: 500, used: 145.94, active: true },
              { name: '拉新权益包', unit: 'credits', remaining: 494.25, total: 1000, used: 505.75, active: true },
              // The live packs that make up the remaining 3148.98 / 3039.
              { name: '运营包', unit: 'credits', remaining: 3000, total: 3000, used: 0, active: true },
              { name: '签到包', unit: 'credits', remaining: 47.98, total: 39, used: -8.98, active: true },
              { name: '裂变包', unit: 'credits', remaining: 0, total: 100, used: 100, active: false },
              { name: '裂变包', unit: 'credits', remaining: 0, total: 100, used: 100, active: false },
            ],
          },
        },
      ],
    },
  }
  const rpc = fakeRpc({ 'credits.balances': () => buddy })
  const rows = await probePluginChannels(rpc, ['buddy'], 5000)
  const row = rows[0]
  assert.equal(row.state, 'ok')
  // 500 + 1000 + 3000 + 39 active totals = 4539, not 4739: the two lapsed packs
  // are excluded from the denominator.
  assert.equal(row.total, 4539)
  assert.equal(row.remaining, 3896.29)
})

test('one channel failing becomes an error row, not a failed read', async () => {
  const rpc = fakeRpc({
    'credits.balances': (payload) => {
      if (payload.provider === 'gemini') throw new Error('upstream unreachable')
      return codearts
    },
  })
  const rows = await probePluginChannels(rpc, ['codearts', 'gemini'], 5000)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].state, 'ok')
  assert.equal(rows[1].state, 'error')
  assert.match(rows[1].error, /upstream unreachable/)
})

test('a provider the pack does not know is reported, not silently dropped', async () => {
  const rpc = fakeRpc({
    'credits.balances': () => {
      throw new Error('unsupported provider')
    },
  })
  const rows = await probePluginChannels(rpc, ['made-up'], 5000)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'error')
})

test('discovery answers available only when the RPC behind the route works', async () => {
  const working = fakeRpc({
    'provider.status': () => ({
      ok: true,
      value: {
        statuses: {
          trae: { models: { total: 39, disabled: 0 }, accounts: { total: 1, enabled: 1 }, closed: false },
        },
      },
    }),
  })
  const ok = await probePluginSource(working)
  assert.equal(ok.available, true)
  assert.deepEqual(ok.channels, ['trae'])

  // The route can exist while the pack behind it failed to mount; that must
  // read as unavailable rather than as "no channels".
  const broken = fakeRpc({
    'provider.status': () => {
      throw new Error('channel-pack handler failed')
    },
  })
  const failed = await probePluginSource(broken)
  assert.equal(failed.available, false)
  assert.match(failed.reason, /handler failed/)
})

test('a provider with no account is not reported as a readable channel', async () => {
  const rpc = fakeRpc({
    'provider.status': () => ({
      ok: true,
      value: {
        statuses: {
          trae: { accounts: { total: 1, enabled: 1 }, models: { total: 39, disabled: 0 } },
          buddy: { accounts: { total: 0, enabled: 0 }, models: { total: 8, disabled: 0 } },
        },
      },
    }),
  })
  const result = await probePluginSource(rpc)
  assert.equal(result.available, true)
  assert.deepEqual(result.channels, ['trae'])
})

test('no connection service reads as unavailable, never as an exception', async () => {
  const result = await probePluginSource(undefined)
  assert.equal(result.available, false)
  assert.match(result.reason, /connection/)
})

test('logged-in channels come from a bulk question, not a single-provider guess', async () => {
  // The bug this pins: `account.list` takes ONE provider, so asking it about
  // `trae` can never reveal `buddy`. A bulk question is required.
  const rpc = fakeRpc({
    'provider.status': (payload) => {
      assert.equal(Array.isArray(payload.providers), true)
      assert.ok(payload.providers.includes('buddy'), 'the catalogue must include every channel')
      return {
        ok: true,
        value: {
          statuses: {
            trae: { accounts: { total: 1, enabled: 1 }, models: { total: 39, disabled: 0 } },
            buddy: { accounts: { total: 3, enabled: 2 }, models: { total: 8, disabled: 0 } },
            gemini: { accounts: { total: 0, enabled: 0 }, models: { total: 4, disabled: 0 } },
          },
        },
      }
    },
  })
  assert.deepEqual(await listPluginChannels(rpc, ['fallback']), ['trae', 'buddy'])
})

test('an empty catalogue falls back rather than reporting nothing', async () => {
  const rpc = fakeRpc({
    'provider.status': () => ({ ok: true, value: { statuses: { trae: { accounts: { total: 0, enabled: 0 } } } } }),
  })
  assert.deepEqual(await listPluginChannels(rpc, ['trae']), ['trae'])
})

// ── The owner Peer moved between kernel versions ────────────────────────────
//
// DSH 0.2.0-rc.2 exposes the owner Peer as `connection.operator`; 0.2.1 renamed
// it to `connection.browserPeer`. Reading only the new name made every 0.2.0
// install answer "connection service has no browser peer", so the whole in-DSH
// source vanished and the card settled on `active: none` — which is the reported
// bug. These tests pin both shapes.

/** A connection service exposing one of the two owner-Peer field names. */
function fakeConnection(field, { principalKind = 'owner' } = {}) {
  const seen = []
  const connection = {
    createSharedFetchHandler() {
      return {
        async fetch(request, peer) {
          seen.push({ url: request.url, peer })
          // Mirror the kernel: an exact route answers 403 to a non-owner Peer.
          if (peer?.principal?.kind !== 'owner') {
            return new Response('forbidden', { status: 403 })
          }
          const envelope = await request.json()
          return Response.json({
            type: 'server-response',
            rpcId: envelope.rpcId,
            result: { ok: true, value: { statuses: { trae: { accounts: { total: 1, enabled: 1 } } } } },
          })
        },
      }
    },
  }
  if (field !== undefined) connection[field] = { id: 'peer-1', principal: { kind: principalKind } }
  return { connection, seen }
}

/** A context whose `get('connection')` answers the given service. */
function fakeCtx(connection) {
  return { get: (id) => (id === 'connection' ? connection : undefined) }
}

test('the owner Peer is read from browserPeer (0.2.1) or operator (0.2.0)', () => {
  const peer = { id: 'p', principal: { kind: 'owner' } }
  assert.equal(ownerPeer({ browserPeer: peer }), peer)
  assert.equal(ownerPeer({ operator: peer }), peer)
  // browserPeer wins when a kernel somehow exposes both: it is the newer name.
  assert.equal(ownerPeer({ browserPeer: peer, operator: { id: 'old' } }), peer)
  assert.equal(ownerPeer({}), undefined)
  assert.equal(ownerPeer(undefined), undefined)
  assert.equal(ownerPeer(null), undefined)
})

test('a 0.2.0 kernel reads the in-DSH source through operator', async () => {
  const { connection, seen } = fakeConnection('operator')
  const rpc = makePluginRpc(fakeCtx(connection))
  const probe = await probePluginSource(rpc)
  assert.equal(probe.available, true)
  assert.deepEqual(probe.channels, ['trae'])
  // The Peer must actually reach the route: a call without one answers 403.
  assert.equal(seen[0].peer.principal.kind, 'owner')
})

test('a 0.2.1 kernel reads the in-DSH source through browserPeer', async () => {
  const { connection } = fakeConnection('browserPeer')
  const rpc = makePluginRpc(fakeCtx(connection))
  const probe = await probePluginSource(rpc)
  assert.equal(probe.available, true)
  assert.deepEqual(probe.channels, ['trae'])
})

test('a kernel with neither field reports the missing Peer instead of a 403', async () => {
  const { connection } = fakeConnection(undefined)
  const rpc = makePluginRpc(fakeCtx(connection))
  const probe = await probePluginSource(rpc)
  assert.equal(probe.available, false)
  assert.match(probe.reason, /owner peer/)
})

test('a non-owner Peer is refused, and that refusal is not read as data', async () => {
  // A future kernel may hand out a Peer with a different principal; the route
  // then answers 403 and the probe must say so rather than report no channels.
  const { connection } = fakeConnection('browserPeer', { principalKind: 'guest' })
  const rpc = makePluginRpc(fakeCtx(connection))
  const probe = await probePluginSource(rpc)
  assert.equal(probe.available, false)
  assert.match(probe.reason, /refused \(HTTP 403\)/)
})
