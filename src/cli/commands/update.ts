import { execSync } from 'node:child_process';
import { checkForUpdates } from '../../core/version.js';

function hasBinary(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isCodexGestaltNpx(): boolean {
  try {
    const out = execSync('codex mcp get gestalt 2>/dev/null', { encoding: 'utf-8', stdio: 'pipe' });
    return out.includes('npx') && out.includes('@tienne/gestalt');
  } catch {
    return false;
  }
}

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

  console.log(`\n새 버전이 있습니다: v${result.currentVersion} → v${result.latestVersion}\n`);

  const hasClause = hasBinary('claude');
  const hasCodex = hasBinary('codex');

  // Claude Code 플러그인 업데이트
  if (hasClause) {
    console.log('● Claude Code 플러그인 업데이트 중...');
    try {
      execSync('claude plugin install gestalt@gestalt', { stdio: 'inherit' });
      console.log('✅ Claude Code 플러그인 업데이트 완료!');
    } catch {
      console.error('✗ Claude Code 플러그인 업데이트 실패. 수동으로 실행해주세요:');
      console.error('  claude plugin install gestalt@gestalt');
    }
  }

  // Codex MCP 업데이트
  if (hasCodex) {
    if (isCodexGestaltNpx()) {
      // npx 방식은 Codex 재시작 시 자동으로 최신 버전을 가져옴
      console.log('✅ Codex: 다음 시작 시 자동으로 v' + result.latestVersion + '이 적용됩니다. (npx 방식)');
    } else {
      // global 설치 방식 — MCP 재등록
      console.log('● Codex MCP 재등록 중...');
      try {
        execSync('codex mcp remove gestalt', { stdio: 'pipe' });
        execSync('codex mcp add gestalt -- npx -y @tienne/gestalt', { stdio: 'inherit' });
        console.log('✅ Codex MCP 재등록 완료!');
      } catch {
        console.error('✗ Codex MCP 재등록 실패. 수동으로 실행해주세요:');
        console.error('  codex mcp remove gestalt');
        console.error('  codex mcp add gestalt -- npx -y @tienne/gestalt');
      }
    }
  }

  // Claude Code도 Codex도 없으면 npm global 업데이트
  if (!hasClause && !hasCodex) {
    console.log('● npm 글로벌 업데이트 중...');
    try {
      execSync(`npm install -g @tienne/gestalt@${result.latestVersion}`, { stdio: 'inherit' });
      console.log(`✅ v${result.latestVersion} npm 글로벌 업데이트 완료!`);
    } catch {
      console.error('✗ 업데이트 실패. 수동으로 실행해주세요:');
      console.error('  npm install -g @tienne/gestalt@latest');
    }
  }
}
