// ResultsViewer의 기록 다루기를 진짜 gestalt 없이 본다. 뷰어 대신 node 프로세스를 띄우고 응답 확인은 주입한다.
import { assert, test } from 'orca/testing'
import { spawn, type ChildProcess } from 'node:child_process'
import { ResultsViewer, type ViewerRecord } from './viewer'

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('기다리던 상태가 안 됐어요')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 지난 워커가 남긴 뷰어 대신 오래 사는 프로세스를 띄운다 */
function longLived(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: ['ignore', 'ignore', 'ignore'] })
}

const ended = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null
const noLaunch = async (): Promise<ChildProcess> => {
  throw new Error('새로 띄우면 안 된다')
}

test('끝난 뷰어는 다른 pid의 기록을 지우지 않는다', async () => {
  const other: ViewerRecord = { pid: 424_242, url: 'http://127.0.0.1:7999', key: 'k' }
  let loads = 0
  const saves: (ViewerRecord | null)[] = []
  const viewer = new ResultsViewer({
    // 첫 읽기는 이어받을 기록이 없고 그 뒤로는 다른 워커가 새로 남긴 기록이 보인다
    load: async () => (loads++ === 0 ? null : other),
    save: async (rec) => {
      saves.push(rec)
    },
    probe: async () => false
  })
  const out = await viewer.ensure('k', async () => spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['ignore', 'pipe', 'pipe'] })).then(
    () => 'resolved',
    (e: Error) => e.message
  )
  assert.match(out, /종료 코드 3/)
  await until(() => loads >= 2)
  // forget이 기록을 읽은 뒤 지울지 정하는 데 한 틱이 걸린다
  await tick()
  assert.deepEqual(saves, [])
})

test('이어받을 뷰어의 응답을 보는 사이 워커가 멈추면 그 뷰어를 끈다', async () => {
  const child = longLived()
  try {
    const rec: ViewerRecord = { pid: child.pid!, url: 'http://127.0.0.1:7999', key: 'k' }
    const saves: (ViewerRecord | null)[] = []
    let answer: (ok: boolean) => void = () => undefined
    let probing = false
    const viewer = new ResultsViewer({
      load: async () => (saves.length ? null : rec),
      save: async (r) => {
        saves.push(r)
      },
      probe: () => {
        probing = true
        return new Promise<boolean>((r) => (answer = r))
      }
    })
    const out = viewer.ensure('k', noLaunch).then(
      () => 'resolved',
      (e: Error) => e.message
    )
    await until(() => probing)
    await viewer.stop()
    answer(true)
    assert.match(await out, /멈췄어요/)
    await until(() => ended(child))
    assert.deepEqual(saves, [null])
  } finally {
    child.kill()
  }
})

test('이어받은 뷰어가 끄기 직전에 응답하지 않으면 그 pid를 끄지 않는다', async () => {
  const child = longLived()
  try {
    const rec: ViewerRecord = { pid: child.pid!, url: 'http://127.0.0.1:7999', key: 'k' }
    let answers = true
    const viewer = new ResultsViewer({
      load: async () => rec,
      save: async () => undefined,
      probe: async () => answers
    })
    assert.equal(await viewer.ensure('k', noLaunch), rec.url)
    // 그사이 뷰어가 끝나고 pid가 다른 프로그램에 쓰인 경우를 흉내 낸다
    answers = false
    await viewer.stop()
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(ended(child), false)
  } finally {
    child.kill()
  }
})
