/**
 * Unit tests for the balance normalisation, especially the percentage denominator.
 *
 * Run with: node --test lib/gateway.test.js
 *
 * The denominator is the one piece of arithmetic here that was measured wrong
 * once, so it is pinned against the real gateway payloads it was measured from.
 * Every fixture below is a verbatim excerpt of a live response (2026-10-20),
 * not an invented shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeChannel } from './gateway.js'

/** Wrap accounts in the `value` payload the gateway returns. */
function channel(accounts) {
  return normalizeChannel('test', { accounts }, 1792460927777)
}

test('a codearts aggregate bundle does not double-count the shared used figure', () => {
  // Measured: 总积分包.remaining == balance.total (7150.69) and its .used (349.31)
  // is the SAME figure 赠送积分包 reports. Summing every bundle's used gives
  // 7849.31 and reads 91.1%; the bundle's own `total` of 7500 says 95.3%.
  const result = channel([
    {
      accountId: 'codearts-976f3d72',
      balance: {
        total: 7150.69,
        packages: [
          { name: '总积分包', unit: 'credit', remaining: 7150.69, total: 7500, used: 349.31, active: true },
          { name: '基础积分包', unit: 'credit', remaining: 500, total: 500, used: 0, active: true },
          { name: '赠送积分包', unit: 'credit', remaining: 6650.69, total: 7000, used: 349.31, active: true },
        ],
      },
    },
  ])

  assert.equal(result.state, 'ok')
  assert.equal(result.remaining, 7150.69)
  assert.equal(result.total, 7500, 'the denominator is the aggregate bundle 7500, not 7849.31')
  assert.equal(result.percent, 95.3, 'not 91.1 — the shared used figure must not be added twice')
})

test('independent bundles are summed, matching the gateway in both readings', () => {
  // Measured: buddy has 35 bundles whose totals do not overlap the aggregate;
  // summing them (4539) agrees with remaining + summed used.
  const result = channel([
    {
      accountId: 'Shen',
      balance: {
        total: 3896.29,
        packages: [
          { name: 'pack-a', unit: 'credits', remaining: 3000, total: 3500, used: 500, active: true },
          { name: 'pack-b', unit: 'credits', remaining: 896.29, total: 1039, used: 142.71, active: true },
        ],
      },
    },
  ])

  assert.equal(result.total, 4539)
  assert.equal(result.percent, 85.8)
})

test('a full resource pack reads exactly 100%', () => {
  // Measured: qoder reports 资源包 remaining 100 of total 100, used 0.
  const result = channel([
    {
      accountId: 'Shen',
      balance: { total: 100, packages: [{ name: '资源包', unit: 'credits', remaining: 100, total: 100, used: 0, active: true }] },
    },
  ])

  assert.equal(result.remaining, 100)
  assert.equal(result.total, 100)
  assert.equal(result.percent, 100)
})

test('one account per channel keeps the aggregate rather than summing accounts', () => {
  // Two accounts in one channel must sum, so the card is about the channel.
  const result = channel([
    { accountId: 'a', balance: { total: 100, packages: [{ name: 'p', remaining: 100, total: 100, used: 0, active: true }] } },
    { accountId: 'b', balance: { total: 300, packages: [{ name: 'p', remaining: 300, total: 300, used: 0, active: true }] } },
  ])

  assert.equal(result.remaining, 400)
  assert.equal(result.total, 400)
  assert.equal(result.percent, 100)
})

test('an account with no readable balance contributes an error row, not a zero', () => {
  // Measured: gemini inside a successful channel response. The channel keeps the
  // error so the card can say why, rather than reporting a fabricated 0%.
  const result = channel([{ accountId: 'gemini', balance: null, error: '配额查询网络失败' }])

  assert.equal(result.state, 'error')
  assert.equal(result.remaining, undefined, 'no number must not become a fabricated 0')
  assert.equal(result.percent, undefined)
  assert.match(result.error, /配额查询网络失败/)
})

test('a channel with no signed-in account is empty, and says so', () => {
  const result = channel([])

  assert.equal(result.state, 'empty')
  assert.equal(result.remaining, undefined)
  assert.equal(result.percent, undefined)
  assert.match(result.note, /未在该渠道登录账号/)
})
