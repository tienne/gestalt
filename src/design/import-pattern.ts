/**
 * 선언된 소스 경로에서 디자인 시스템 패키지 이름을 알아낸다.
 *
 * `importPattern`을 손으로 적지 않아도 되게 하는 자리다. 새로 훑어 고르는 것과는 다르다 —
 * 사용자가 이미 `ref`로 그 소스를 지목했다. 여기서는 그 경로가 어느 패키지에 속하는지만
 * 읽는다. 근거는 여전히 선언이다.
 *
 * 추론이 틀릴 수 있으므로 무엇을 어떻게 알아냈는지 함께 돌려준다. 손으로 적은
 * `importPattern`이 있으면 그쪽이 이긴다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface InferredPattern {
  /** import를 알아보는 정규식 */
  pattern: RegExp;
  /** 어떻게 알아냈는지. 보고에 그대로 싣는다 */
  reason: string;
}

/** 정규식에서 특별한 뜻을 갖는 문자를 그대로 찾도록 막는다 */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 경로에서 위로 올라가며 가장 가까운 `package.json`의 이름을 읽는다.
 *
 * `stopAt`에 도달하면 멈춘다. 이게 없으면 `ref`에 package.json이 없을 때 검사 대상
 * 레포의 루트까지 올라가 자기 이름을 집는다. 그 이름으로 패턴을 만들면 자기 소스를
 * 디자인 시스템으로 보게 된다. 디자인 시스템은 레포 밖이거나 모노레포 안의 다른
 * 패키지라, 어느 쪽이든 루트에 닿기 전에 찾힌다.
 */
function nearestPackageName(
  startDir: string,
  stopAt?: string,
  maxUp = 8,
): { name: string; at: string } | null {
  let dir = startDir;
  for (let i = 0; i <= maxUp; i++) {
    // 경계에 닿으면 그 디렉토리의 package.json은 읽지 않는다. 읽고 나서 멈추면
    // 막으려던 이름을 그대로 집는다
    if (stopAt && dir === stopAt) break;
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        // 워크스페이스 루트는 보통 private이고 이름이 소비처에서 쓰이지 않는다
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          return { name: parsed.name, at: candidate };
        }
      } catch {
        // 못 읽으면 위로 계속 올라간다
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 파일 소스의 `ref`에서 import 패턴을 뽑는다.
 *
 * 한 디자인 시스템이 패키지를 여럿으로 쪼개 배포하는 경우가 흔하다(`-recipe`, `-sauce`).
 * 찾은 이름 그대로만 잡으면 나머지를 쓰는 파일이 시스템 바깥으로 빠지므로, 마지막
 * 하이픈 뒤를 떼어낸 접두사까지 받는다. 접두사가 스코프뿐이면 (`@acme` 하나) 너무 넓어
 * 남의 패키지까지 걸리니 그때는 이름 그대로만 쓴다.
 */
export function inferImportPattern(ref: string, cwd: string): InferredPattern | null {
  const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
  if (!existsSync(path)) return null;

  const found = nearestPackageName(path, resolve(cwd));
  if (!found) return null;

  const prefix = found.name.replace(/-[^-/]+$/, '');
  const useprefix = prefix !== found.name && prefix.includes('/') && prefix.length > 2;
  const target = useprefix ? prefix : found.name;

  return {
    pattern: new RegExp(`from\\s+['"]${escape(target)}`),
    reason: useprefix
      ? `${found.at}의 ${found.name}에서 추론 (${target}* 로 넓힘)`
      : `${found.at}의 ${found.name}에서 추론`,
  };
}
