// CliResolver를 진짜 gestalt 대신 test/fake-gestalt.mjs로 돌린다. 저장소는 임시 폴더라 실제 상태를 건드리지 않는다.
import { assert, test } from 'orca/testing'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliError, CliResolver } from './cli'

const FAKE = decodeURIComponent(new URL('../test/fake-gestalt.mjs', import.meta.url).pathname)
const TIMEOUT_MS = 10_000

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-cli-')))
  writeFileSync(join(dir, 'fake-calls.jsonl'), '')
  writeFileSync(join(dir, 'fake-status.json'), '{"orders":[]}')
  const bin = join(dir, 'bin.mjs')
  writeFileSync(bin, readFileSync(FAKE, 'utf8'))
  const answer = (value: unknown) => writeFileSync(join(dir, 'fake-exec-path.json'), JSON.stringify(value))
  answer({ node: process.execPath, args: [bin], env: {}, version: '0.0.0' })
  const calls = () =>
    readFileSync(join(dir, 'fake-calls.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; via: string })
  return {
    dir,
    bin,
    answer,
    lookups: () => calls().filter((c) => c.args[1] === 'exec-path').length,
    statusCalls: () => calls().filter((c) => c.args[1] === 'status').length,
    statusArgs: ['conductor', 'status', '--json', `--state-dir=${dir}`],
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

async function withSetup(body: (s: ReturnType<typeof setup>) => Promise<void>) {
  const s = setup()
  try {
    await body(s)
  } finally {
    s.cleanup()
  }
}

test('겹친 resolve는 같은 찾기를 기다린다', () =>
  withSetup(async (s) => {
    const cli = new CliResolver(TIMEOUT_MS, () => 'a')
    const [a, b] = await Promise.all([cli.resolve(FAKE, s.dir), cli.resolve(FAKE, s.dir)])
    assert.equal(s.lookups(), 1)
    assert.equal(a, b)
    assert.deepEqual(a.prefix, [s.bin])
  }))

test('설치 목록이 바뀌거나 invalidate가 불리면 다시 찾는다', () =>
  withSetup(async (s) => {
    let stamp = 'a'
    const cli = new CliResolver(TIMEOUT_MS, () => stamp)
    await cli.resolve(FAKE, s.dir)
    await cli.resolve(FAKE, s.dir)
    assert.equal(s.lookups(), 1)
    stamp = 'b'
    await cli.resolve(FAKE, s.dir)
    assert.equal(s.lookups(), 2)
    cli.invalidate()
    await cli.resolve(FAKE, s.dir)
    assert.equal(s.lookups(), 3)
  }))

test('찾는 중에 invalidate되면 그 결과를 기억하지 않는다', () =>
  withSetup(async (s) => {
    const cli = new CliResolver(TIMEOUT_MS, () => 'a')
    const first = cli.resolve(FAKE, s.dir)
    cli.invalidate()
    await first
    await cli.resolve(FAKE, s.dir)
    assert.equal(s.lookups(), 2)
  }))

test('기억해 둔 node가 사라지면 부르기 전에 다시 찾는다', () =>
  withSetup(async (s) => {
    const node = join(s.dir, 'node')
    symlinkSync(process.execPath, node)
    s.answer({ node, args: [s.bin], env: {}, version: '0.0.0' })
    const cli = new CliResolver(TIMEOUT_MS, () => 'a')
    assert.equal((await cli.resolve(FAKE, s.dir)).file, node)
    rmSync(node)
    s.answer({ node: process.execPath, args: [s.bin], env: {}, version: '0.0.0' })
    await cli.run(FAKE, s.statusArgs, { cwd: s.dir, timeoutMs: TIMEOUT_MS })
    assert.equal(s.lookups(), 2)
    assert.equal(s.statusCalls(), 1)
  }))

test('명령이 도는 사이 진입 파일이 지워져 실패해도 같은 명령을 다시 부르지 않는다', () =>
  withSetup(async (s) => {
    const cli = new CliResolver(TIMEOUT_MS, () => 'a')
    await cli.resolve(FAKE, s.dir)
    writeFileSync(join(s.dir, 'fake-remove-self'), '')
    writeFileSync(join(s.dir, 'fake-fail'), 'boom\n')
    let error: unknown = null
    try {
      await cli.run(FAKE, s.statusArgs, { cwd: s.dir, timeoutMs: TIMEOUT_MS })
    } catch (e) {
      error = e
    }
    assert.equal(error instanceof CliError, true)
    assert.equal(s.statusCalls(), 1)
  }))

test('옛 CLI라 명령이 없으면 시간이 지나도 다시 찾지 않는다', () =>
  withSetup(async (s) => {
    rmSync(join(s.dir, 'fake-exec-path.json'))
    let now = 0
    const cli = new CliResolver(
      TIMEOUT_MS,
      () => 'a',
      () => now
    )
    assert.equal((await cli.resolve(FAKE, s.dir)).file, FAKE)
    now = 24 * 60 * 60 * 1000
    assert.equal((await cli.resolve(FAKE, s.dir)).file, FAKE)
    assert.equal(s.lookups(), 1)
  }))

test('찾기가 제한 시간을 넘기면 잠시 뒤 다시 찾는다', () =>
  withSetup(async (s) => {
    writeFileSync(join(s.dir, 'fake-exec-path-slow'), '')
    let now = 0
    const cli = new CliResolver(
      500,
      () => 'a',
      () => now
    )
    assert.equal((await cli.resolve(FAKE, s.dir)).file, FAKE)
    assert.equal((await cli.resolve(FAKE, s.dir)).file, FAKE)
    assert.equal(s.lookups(), 1)
    rmSync(join(s.dir, 'fake-exec-path-slow'))
    now = 61_000
    assert.equal((await cli.resolve(FAKE, s.dir)).file, process.execPath)
    assert.equal(s.lookups(), 2)
  }))

test('exec-path 답의 env는 정해 둔 키만 받고 상대 경로 node는 버린다', () =>
  withSetup(async (s) => {
    s.answer({
      node: process.execPath,
      args: [s.bin],
      env: { TSX_TSCONFIG_PATH: '/x', NODE_OPTIONS: '--inspect' }
    })
    const cli = new CliResolver(TIMEOUT_MS, () => 'a')
    assert.deepEqual((await cli.resolve(FAKE, s.dir)).env, { TSX_TSCONFIG_PATH: '/x' })
    s.answer({ node: 'node', args: [s.bin], env: {} })
    cli.invalidate()
    assert.equal((await cli.resolve(FAKE, s.dir)).file, FAKE)
  }))
