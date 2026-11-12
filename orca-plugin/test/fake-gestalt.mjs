#!/usr/bin/env node
// 테스트와 `orca plugin check`가 진짜 컨덕터 저장소를 건드리지 않게 gestalt CLI 대신 부르는 가짜.
// `--state-dir`로 받은 폴더의 fake-*.json을 그대로 내보낸다.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dir = args.find((a) => a.startsWith('--state-dir='))?.slice('--state-dir='.length)
if (!dir) {
  process.stderr.write('fake-gestalt: --state-dir가 없어요\n')
  process.exit(2)
}
const log = join(dir, 'fake-calls.jsonl')
if (existsSync(log)) appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\n')
if (existsSync(join(dir, 'fake-fail'))) {
  // --json 명령은 실패해도 stdout에 결과를 남길 수 있다. 그 경우를 흉내 낸다
  if (existsSync(join(dir, 'fake-fail-stdout.json'))) process.stdout.write(readFileSync(join(dir, 'fake-fail-stdout.json'), 'utf8'))
  process.stderr.write(readFileSync(join(dir, 'fake-fail'), 'utf8'))
  process.exit(1)
}
const file = { gate: 'fake-resolve.json', order: 'fake-remove.json' }[args[1]] ?? 'fake-status.json'
process.stdout.write(readFileSync(join(dir, file), 'utf8'))
