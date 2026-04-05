import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codeGraphEngine } from '../../code-graph/index.js';
import { gitHookManager } from '../../code-graph/git-hook.js';

const CONFIG_FILENAME = 'gestalt.json';

const DEFAULT_CONFIG = {
  $schema: './node_modules/@tienne/gestalt/schemas/gestalt.schema.json',
  notifications: false,
  interview: {
    ambiguityThreshold: 0.2,
    maxRounds: 10,
  },
};

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export async function initCommand(options: { skipGraph?: boolean; skipHook?: boolean }): Promise<void> {
  const repoRoot = process.cwd();
  const filePath = resolve(repoRoot, CONFIG_FILENAME);

  // Step 1: gestalt.json 생성/덮어쓰기
  if (existsSync(filePath)) {
    const overwrite = await confirm('gestalt.json이 이미 존재합니다. 덮어쓰시겠습니까? (y/N): ');
    if (!overwrite) {
      console.log('gestalt.json 생성을 건너뜁니다.');
    } else {
      writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
      console.log('✓ gestalt.json 덮어쓰기 완료: ' + filePath);
    }
  } else {
    writeFileSync(filePath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
    console.log('✓ gestalt.json 생성 완료: ' + filePath);
  }

  // Step 2: 코드 그래프 빌드
  if (!options.skipGraph) {
    console.log('\n코드 그래프를 빌드하는 중...');
    try {
      const result = codeGraphEngine.build(repoRoot, { mode: 'full' });
      console.log(
        `✓ 코드 그래프 빌드 완료: 노드 ${result.nodesBuilt}개, 엣지 ${result.edgesBuilt}개 (${result.timeTakenMs}ms)`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`⚠ 코드 그래프 빌드 실패: ${msg}`);
    }
  } else {
    console.log('코드 그래프 빌드를 건너뜁니다. (--skip-graph)');
  }

  // Step 3: post-commit 훅 설치
  if (!options.skipHook) {
    try {
      const alreadyInstalled = gitHookManager.isInstalled(repoRoot);
      gitHookManager.installHook(repoRoot);
      if (alreadyInstalled) {
        console.log('✓ post-commit 훅이 이미 설치되어 있습니다.');
      } else {
        console.log('✓ post-commit 훅 설치 완료.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`⚠ post-commit 훅 설치 실패: ${msg}`);
    }
  } else {
    console.log('post-commit 훅 설치를 건너뜁니다. (--skip-hook)');
  }

  console.log('\nGestalt 초기화 완료! 이제 /build-graph, /blast-radius 스킬을 바로 사용할 수 있습니다.');
}
