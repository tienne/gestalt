#!/usr/bin/env node
// 테스트와 `orca plugin check`가 진짜 컨덕터 저장소를 건드리지 않게 gestalt CLI 대신 부르는 가짜.
// `--state-dir`로 받은 폴더의 fake-*.json을 그대로 내보낸다.
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
// 플러그인이 경로를 기억해 바로 부르는지 보려고 어느 파일로 불렸는지 같이 남긴다
const via = process.argv[1]
if (args[0] === 'conductor' && args[1] === 'exec-path') {
  // 경로 찾기는 --state-dir 없이 상태 폴더를 cwd로 두고 부른다. 그 폴더의 fake-exec-path.json을 답으로 낸다
  const cwdLog = join(process.cwd(), 'fake-calls.jsonl')
  if (existsSync(cwdLog)) appendFileSync(cwdLog, JSON.stringify({ args, cwd: process.cwd(), via }) + '\n')
  // 부하로 런처가 제한 시간을 넘기는 경우를 흉내 낸다
  if (existsSync(join(process.cwd(), 'fake-exec-path-slow'))) await new Promise((r) => setTimeout(r, 5_000))
  if (existsSync(join(process.cwd(), 'fake-exec-path-fail'))) {
    process.stderr.write('error: launcher failed\n')
    process.exit(1)
  }
  const answer = join(process.cwd(), 'fake-exec-path.json')
  if (!existsSync(answer)) {
    process.stderr.write("error: unknown command 'exec-path'\n")
    process.exit(1)
  }
  process.stdout.write(readFileSync(answer, 'utf8'))
  process.exit(0)
}
const dir = args.find((a) => a.startsWith('--state-dir='))?.slice('--state-dir='.length)
if (!dir) {
  process.stderr.write('fake-gestalt: --state-dir가 없어요\n')
  process.exit(2)
}
const log = join(dir, 'fake-calls.jsonl')
if (existsSync(log)) appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), via }) + '\n')
if (existsSync(join(dir, 'fake-no-defer')) && args.includes('--defer-delivery')) {
  // 결정 전달을 tick에 넘기는 플래그가 없는 옛 CLI. commander는 모르는 옵션을 action 전에 거절한다
  process.stderr.write("error: unknown option '--defer-delivery'\n")
  process.exit(1)
}
if (existsSync(join(dir, 'fake-no-activity')) && args.includes('--with-activity')) {
  // 작업 내용 플래그가 없는 옛 CLI
  process.stderr.write("error: unknown option '--with-activity'\n")
  process.exit(1)
}
// 명령이 도는 사이 플러그인 업데이트로 진입 파일이 지워지는 경우
if (existsSync(join(dir, 'fake-remove-self'))) rmSync(process.argv[1])
if (existsSync(join(dir, 'fake-fail'))) {
  // --json 명령은 실패해도 stdout에 결과를 남길 수 있다. 그 경우를 흉내 낸다
  if (existsSync(join(dir, 'fake-fail-stdout.json'))) process.stdout.write(readFileSync(join(dir, 'fake-fail-stdout.json'), 'utf8'))
  process.stderr.write(readFileSync(join(dir, 'fake-fail'), 'utf8'))
  process.exit(1)
}
if (args[1] === 'browse') {
  // 결과 뷰어는 주소를 찍고 멈출 때까지 떠 있다
  process.stdout.write('컨덕터 결과 뷰어: http://127.0.0.1:49999\nCtrl+C로 멈춰요.\n')
  setInterval(() => {}, 60_000)
} else {
const file = { gate: 'fake-resolve.json', order: 'fake-remove.json' }[args[1]] ?? 'fake-status.json'
process.stdout.write(readFileSync(join(dir, file), 'utf8'))
}
