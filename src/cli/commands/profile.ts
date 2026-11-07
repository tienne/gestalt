import { loadUserProfile } from '../../core/user-profile.js';

/**
 * `gestalt profile show`.
 *
 * 스킬은 남의 레포에서 돌아서 홈 아래 파일 경로를 스스로 계산하지 못한다. `GESTALT_HOME`
 * 해석까지 여기서 끝내고 값만 넘긴다. 프로필이 정한 칸만 싣는다 — 기본값은 스킬이 들고
 * 있어서 여기서 채우면 두 자리가 갈린다.
 *
 * 깨진 파일도 종료 코드 0이다. 경고를 싣고 그 칸을 비워 두면 스킬은 기본값으로 계속 돈다.
 */
export function profileShowCommand(opts: { json?: boolean }): void {
  const profile = loadUserProfile();
  if (opts.json) {
    console.log(JSON.stringify(profile));
    return;
  }

  console.log(`프로필: ${profile.path}${profile.exists ? '' : ' (파일 없음, 전부 기본값)'}`);
  const entries = Object.entries(profile.review);
  if (entries.length === 0) console.log('review: 프로필이 정한 값 없음');
  for (const [key, value] of entries) console.log(`review.${key} = ${JSON.stringify(value)}`);
  for (const w of profile.warnings) console.log(`경고: ${w}`);
}
