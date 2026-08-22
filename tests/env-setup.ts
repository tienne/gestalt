import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 테스트가 사용자의 진짜 홈을 안 건드리게 한다.
 *
 * `pr create`가 레포 목록(`~/.gestalt/repos.json`)에 자기 레포를 넣는데 테스트는
 * 임시 레포에서 PR을 만든다. 격리하지 않으면 테스트를 돌릴 때마다 곧 사라질 경로가
 * 사용자 홈에 쌓인다.
 *
 * 워커마다 도는 자리라 경로를 고정한다 — 파일마다 새 디렉토리를 만들면 정리할 자리가
 * 흩어진다. `.gestalt-test/`는 테스트 DB가 이미 쓰는 칸이다.
 */
const home = resolve('.gestalt-test', 'home');
mkdirSync(home, { recursive: true });
process.env['GESTALT_HOME'] = home;
