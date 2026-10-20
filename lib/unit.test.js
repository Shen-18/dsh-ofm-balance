/**
 * Unit-label folding.
 *
 * `workbuddy` ships some credit packs labelled `credit` and others `credits`,
 * and the card rendered `credit/credits` — two words where one belongs, eating
 * the width the number needs. Singular and plural are the same unit, so they
 * fold; genuinely different units must not, because that would claim two things
 * are one.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChannel } from './gateway.js'

/** A one-account balance whose bundles carry the given unit labels. */
function balanceWithUnits(units) {
  return {
    accounts: [
      {
        accountId: 'a',
        nickname: 'n',
        balance: {
          total: units.length * 100,
          packages: units.map((unit, index) => ({
            name: `pack-${index}`,
            unit,
            remaining: 100,
            total: 100,
            used: 0,
            active: true,
          })),
        },
      },
    ],
  }
}

test('singular and plural of one unit fold to a single label', () => {
  const row = normalizeChannel('workbuddy', balanceWithUnits(['credit', 'credits']), 1)
  assert.equal(row.state, 'ok')
  // One word, not "credit/credits". The longer spelling wins so the label does
  // not read as singular while the number is a sum.
  assert.equal(row.unit, 'credits')
})

test('all bundles agreeing keeps that exact spelling', () => {
  assert.equal(normalizeChannel('x', balanceWithUnits(['credits', 'credits']), 1).unit, 'credits')
  assert.equal(normalizeChannel('x', balanceWithUnits(['credit', 'credit']), 1).unit, 'credit')
})

test('genuinely different units are not folded', () => {
  // Folding these would claim credits and tokens are the same thing.
  const row = normalizeChannel('x', balanceWithUnits(['credit', 'token']), 1)
  assert.equal(row.unit, 'credit/token')
})

test('a channel with no unit labels reports none', () => {
  const row = normalizeChannel('x', {
    accounts: [
      {
        accountId: 'a',
        nickname: 'n',
        balance: { total: 100, packages: [{ name: 'p', remaining: 100, total: 100, used: 0 }] },
      },
    ],
  }, 1)
  assert.equal(row.unit, undefined)
})

test('folding does not change the arithmetic', () => {
  const withBoth = normalizeChannel('workbuddy', balanceWithUnits(['credit', 'credits']), 1)
  const withOne = normalizeChannel('workbuddy', balanceWithUnits(['credits', 'credits']), 1)
  assert.equal(withBoth.remaining, withOne.remaining)
  assert.equal(withBoth.total, withOne.total)
  assert.equal(withBoth.percent, withOne.percent)
})
