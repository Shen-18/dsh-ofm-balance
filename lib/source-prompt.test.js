/**
 * "Ask once" for the data-source question.
 *
 * Two states must be distinguishable, and conflating them was the bug:
 *
 *   - **chose** a source — stop asking, and keep reading that one;
 *   - **dismissed** the question — stop asking, but keep picking the sensible
 *     default (`auto`) each start.
 *
 * A single `source` field could not express the second, so a dismissed question
 * came back on every launch.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run `fn` with `DSH_HOME` pointing at a throwaway directory. */
async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'ofm-prompt-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}

/** Import fresh so the module reads the current DSH_HOME on each call. */
async function patchModule() {
  return import('./patch.js')
}

test('the question is unanswered until it is either answered or dismissed', async () => {
  await withHome(async () => {
    const { readSourcePromptSeen } = await patchModule()
    assert.equal(await readSourcePromptSeen(), false, 'no settings file means never asked')
  })
})

test('dismissing marks the question seen without pinning a source', async () => {
  await withHome(async () => {
    const { readSourcePromptSeen, writeSourcePromptSeen, readSourceChoice } = await patchModule()
    await writeSourcePromptSeen()
    assert.equal(await readSourcePromptSeen(), true)
    // The critical part: dismissing is NOT choosing. `auto` must survive, so the
    // card keeps falling back to whichever product is reachable.
    assert.equal(await readSourceChoice(), undefined)
  })
})

test('choosing a source also settles the question', async () => {
  await withHome(async () => {
    const { readSourcePromptSeen, writeSourcePromptSeen, readSourceChoice, writeSourceChoice } =
      await patchModule()
    await writeSourceChoice('desktop')
    await writeSourcePromptSeen()
    assert.equal(await readSourcePromptSeen(), true)
    assert.equal(await readSourceChoice(), 'desktop')
  })
})

test('dismissing after choosing keeps the choice', async () => {
  await withHome(async () => {
    const { readSourceChoice, writeSourceChoice, writeSourcePromptSeen } = await patchModule()
    await writeSourceChoice('plugin')
    await writeSourcePromptSeen()
    assert.equal(await readSourceChoice(), 'plugin', 'the flag must not clobber the choice')
  })
})

test('a corrupt settings file reads as "never asked" rather than throwing', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'dsh-ofm-balance')
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    await writeFile(join(dir, 'settings.json'), '{ this is not json', 'utf8')
    const { readSourcePromptSeen } = await patchModule()
    assert.equal(await readSourcePromptSeen(), false)
  })
})
