import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 테스트가 사용자의 진짜 홈을 안 건드리게 한다.
 *
 * 테스트는 임시 레포에서 PR을 만들고 프로필을 쓰고 이벤트 DB를 연다. 격리하지 않으면
 * 돌릴 때마다 곧 사라질 경로와 테스트가 만든 값이 사용자 홈에 쌓인다.
 *
 * `~/.gestalt` 자리를 정하는 건 `src/core/home.ts` 하나다. 레포 목록이랑 프로필,
 * 이벤트 DB, 업데이트 캐시가 전부 그 함수를 거치므로 이 한 줄이 넷을 함께 옮긴다.
 *
 * 워커마다 도는 자리라 경로를 고정한다 — 파일마다 새 디렉토리를 만들면 정리할 자리가
 * 흩어진다. `.gestalt-test/`는 테스트 DB가 이미 쓰는 칸이다.
 */
const home = resolve('.gestalt-test', 'home');
mkdirSync(home, { recursive: true });
process.env['GESTALT_HOME'] = home;

// 인프라 그림의 벤더 아이콘은 auto면 네트워크로 받으러 간다. 테스트는 캐시만 보고 받지 않는다
process.env['GESTALT_ARCH_ICONS'] = 'offline';

// 오르카 안에서 테스트를 돌리면 컨덕터 tick이 테스트를 돌리는 그 탭 이름을 바꾼다. 탭 판정에 쓰는 값만 지운다
delete process.env['ORCA_TERMINAL_HANDLE'];
delete process.env['ORCA_STRUCTURED_SESSION'];
