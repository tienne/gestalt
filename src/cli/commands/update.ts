import { execSync } from 'node:child_process';
import { checkForUpdates } from '../../core/version.js';

export async function updateCommand(): Promise<void> {
  console.log('업데이트 확인 중...');

  const result = await checkForUpdates();

  if (!result) {
    console.log('업데이트 확인에 실패했습니다. 네트워크 연결을 확인해주세요.');
    return;
  }

  console.log(`현재 버전: v${result.currentVersion}`);
  console.log(`최신 버전: v${result.latestVersion}`);

  if (!result.updateAvailable) {
    console.log('✅ 최신 버전입니다.');
    return;
  }

  console.log(`\n새 버전이 있습니다: v${result.currentVersion} → v${result.latestVersion}`);
  console.log('업데이트 중...');

  try {
    execSync(`npm install -g @tienne/gestalt@${result.latestVersion}`, { stdio: 'inherit' });
    console.log(`\n✅ v${result.latestVersion} 업데이트 완료!`);
    console.log('\nClaude Code 플러그인도 업데이트하려면:');
    console.log('  /plugin install gestalt@gestalt');
  } catch {
    console.error('\n자동 업데이트에 실패했습니다. 수동으로 업데이트해주세요:');
    console.error(`  npm install -g @tienne/gestalt@latest`);
    console.error('또는 Claude Code 플러그인:');
    console.error('  /plugin install gestalt@gestalt');
  }
}
