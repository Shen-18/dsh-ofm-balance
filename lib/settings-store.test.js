import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ofm-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const mod = await import(`./patch.js?home=${encodeURIComponent(dir)}`)
    return await fn(mod, dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}
async function ensureDir(mod) {
  await mkdir(join(mod.settingsPath(), '..'), { recursive: true })
}

test('a missing settings file reads as no overrides', async () => {
  await withHome(async (mod) => {
    assert.deepEqual(await mod.readVisibilitySettings(), { hidden: [], revealed: [] })
  })
})

test('a corrupt settings file reads as no overrides instead of throwing', async () => {
  await withHome(async (mod) => {
    await ensureDir(mod)
    await writeFile(mod.settingsPath(), '{ this is not json', 'utf8')
    assert.deepEqual(await mod.readVisibilitySettings(), { hidden: [], revealed: [] })
  })
})

test('saves and reads back the two lists', async () => {
  await withHome(async (mod) => {
    await mod.writeVisibilitySettings(['qoder', 'gemini'], ['moonshot'])
    const saved = await mod.readVisibilitySettings()
    assert.deepEqual(saved.hidden, ['qoder', 'gemini'])
    assert.deepEqual(saved.revealed, ['moonshot'])
  })
})

test('the second save replaces the first', async () => {
  await withHome(async (mod) => {
    await mod.writeVisibilitySettings(['qoder'], ['a', 'b'])
    await mod.writeVisibilitySettings(['codearts'], [])
    const saved = await mod.readVisibilitySettings()
    assert.deepEqual(saved.hidden, ['codearts'])
    assert.deepEqual(saved.revealed, [])
  })
})

test('leaves no temp file behind', async () => {
  await withHome(async (mod) => {
    await mod.writeVisibilitySettings(['qoder'], [])
    const entries = await readdir(join(mod.settingsPath(), '..'))
    assert.deepEqual(entries.filter((n) => n.includes('.tmp')), [], 'atomic write cleans up')
  })
})

test('the file is written as readable JSON', async () => {
  await withHome(async (mod) => {
    await mod.writeVisibilitySettings(['trae'], ['moonshot'])
    const parsed = JSON.parse(await readFile(mod.settingsPath(), 'utf8'))
    assert.equal(parsed.version, 1)
    assert.deepEqual(parsed.hidden, ['trae'])
    assert.deepEqual(parsed.revealed, ['moonshot'])
  })
})

test('unknown shapes in the file are tolerated', async () => {
  await withHome(async (mod) => {
    await ensureDir(mod)
    await writeFile(mod.settingsPath(), JSON.stringify({ hidden: 'not-an-array', revealed: [1, 2, 'ok'] }), 'utf8')
    const saved = await mod.readVisibilitySettings()
    assert.deepEqual(saved.hidden, [])
    assert.deepEqual(saved.revealed, ['ok'], 'non-string entries are dropped')
  })
})
