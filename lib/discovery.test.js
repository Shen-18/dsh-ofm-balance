/**
 * Cold-start discovery: the retry contract.
 *
 * The kernel publishes `connection` only after the browser half mounts, which is
 * *after* plugins load — so a healthy install reports "plugin unavailable" for
 * the first seconds. The first live run of this feature settled on that first
 * empty answer and produced `active: none`, which is the bug this contract
 * exists to prevent.
 *
 * `discoverSourcesSettled` cannot be imported on its own (it lives in the host
 * module, which imports `schemastery`), so the loop is restated here against the
 * same rule. Keeping the contract explicit is the point; the host uses the
 * identical shape.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const DISCOVERY_ATTEMPTS = 6

/** The settlement loop, identical to the host's. */
async function settle(probeOnce) {
  let probes = await probeOnce()
  for (let attempt = 1; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
    if (probes.some((probe) => probe.available)) return probes
    await probeOnce.ready?.()
    probes = await probeOnce()
  }
  return probes
}

test('a source that appears late is still adopted', async () => {
  let call = 0
  const probes = await settle(async () => {
    call += 1
    return [{ id: 'plugin', available: call >= 3 }]
  })
  assert.equal(probes[0].available, true)
  // It must not have given up after the first empty answer.
  assert.equal(call, 3)
})

test('a source that never appears spends the budget and settles unreachable', async () => {
  let call = 0
  const probes = await settle(async () => {
    call += 1
    return [{ id: 'plugin', available: false }, { id: 'desktop', available: false }]
  })
  assert.equal(call, DISCOVERY_ATTEMPTS)
  assert.equal(probes.every((probe) => !probe.available), true)
})

test('a source available immediately costs exactly one probe', async () => {
  let call = 0
  await settle(async () => {
    call += 1
    return [{ id: 'desktop', available: true }]
  })
  assert.equal(call, 1)
})

test('one live source stops the retries even if the other never answers', async () => {
  let call = 0
  const probes = await settle(async () => {
    call += 1
    return [{ id: 'plugin', available: false }, { id: 'desktop', available: true }]
  })
  assert.equal(call, 1)
  assert.equal(probes.find((p) => p.id === 'desktop').available, true)
})
