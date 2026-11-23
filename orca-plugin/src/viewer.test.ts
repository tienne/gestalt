// ResultsViewer의 기록 다루기를 진짜 gestalt 없이 본다. 뷰어 대신 곧바로 끝나는 node 프로세스를 띄운다.
import { assert, test } from 'orca/testing'
import { spawn } from 'node:child_process'
import { ResultsViewer, type ViewerRecord } from './viewer'

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
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(loads >= 2, true, '끝난 뒤 기록을 다시 읽었다')
  assert.deepEqual(saves, [])
})
