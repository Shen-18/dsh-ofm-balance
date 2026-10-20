/**
 * The desktop source's probe.
 *
 * Both assertions here pin bugs found by restarting the real app and reading
 * `/api/dsh-ofm-balance/sources`:
 *
 *   - `/v1/models` on this gateway answers 401 to an *unauthenticated* caller
 *     (measured), so a probe that forgets the bearer key reports "credentials
 *     refused" on a perfectly healthy app;
 *   - the two 401 cases need different fixes ("no key found" vs "key refused"),
 *     so they must not collapse into one message.
 *
 * A unit test that hands discovery a ready-made probe list cannot see either.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeDesktopSource, listDesktopChannels } from './desktop-source.js'

/** Run `fn` with `fetch` replaced, restoring it afterwards. */
async function withFetch(t, impl, fn) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => {
    globalThis.fetch = real
  })
  return fn()
}

test('the probe sends the bearer key', async (t) => {
  const seen = []
  const result = await withFetch(
    t,
    async (url, init) => {
      seen.push({ url: String(url), auth: init?.headers?.authorization })
      return new Response(JSON.stringify({ data: [{ channel: 'trae' }, { channel: 'buddy' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, 'secret-key'),
  )

  assert.equal(result.available, true)
  assert.equal(result.channels, 2)
  assert.equal(seen[0].auth, 'Bearer secret-key')
  assert.match(seen[0].url, /\/v1\/models$/)
})

test('an unauthenticated 401 reads as "no key found", not "refused"', async (t) => {
  const result = await withFetch(
    t,
    async (_url, init) => {
      // This gateway genuinely refuses anonymous callers.
      if (init?.headers?.authorization === undefined) return new Response('unauthorized', { status: 401 })
      return new Response('{}', { status: 200 })
    },
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, undefined),
  )
  assert.equal(result.available, false)
  assert.match(result.reason, /没有找到凭据/)
})

test('a 401 with a key reads as refused', async (t) => {
  const result = await withFetch(
    t,
    async () => new Response('unauthorized', { status: 401 }),
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, 'wrong-key'),
  )
  assert.equal(result.available, false)
  assert.match(result.reason, /被拒绝/)
})

test('an empty key is treated as absent, so the message stays accurate', async (t) => {
  const result = await withFetch(
    t,
    async (_url, init) => {
      if (init?.headers?.authorization === undefined) return new Response('unauthorized', { status: 401 })
      return new Response('{}', { status: 200 })
    },
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, ''),
  )
  assert.equal(result.available, false)
  assert.match(result.reason, /没有找到凭据/)
})

test('nothing listening reads as "not listening", not as an auth problem', async (t) => {
  const result = await withFetch(
    t,
    async () => {
      throw new TypeError('fetch failed')
    },
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, 'key'),
  )
  assert.equal(result.available, false)
  assert.match(result.reason, /未监听/)
})

test('a non-200 reads as an HTTP status', async (t) => {
  const result = await withFetch(
    t,
    async () => new Response('boom', { status: 500 }),
    () => probeDesktopSource('http://127.0.0.1:18900', 4000, 'key'),
  )
  assert.equal(result.available, false)
  assert.match(result.reason, /HTTP 500/)
})

test('channel discovery failures degrade to an empty list, never a throw', async (t) => {
  const result = await withFetch(
    t,
    async () => new Response('nope', { status: 503 }),
    () => listDesktopChannels('http://127.0.0.1:18900', 'key', 3000),
  )
  assert.deepEqual(result, [])
})
