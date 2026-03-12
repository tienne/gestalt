#!/usr/bin/env npx tsx
/**
 * Lateral Thinking Personas E2E 시뮬레이션
 *
 * 전체 플로우를 자동으로 실행하며 lateral thinking 분기를 보여줍니다.
 *
 * 흐름:
 *   Planning → Execution → Evaluation(low)
 *   → Evolution(stagnation 유발) → Lateral Thinking(4 personas 순회)
 *   → Human Escalation
 *
 * 실행: pnpm tsx scripts/simulate-lateral.ts
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { PassthroughExecuteEngine } from '../src/execute/passthrough-engine.js';
import { EventStore } from '../src/events/store.js';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  StructuralResult,
  EvaluationResult,
} from '../src/core/types.js';

// ─── Styling ─────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

function header(text: string) {
  console.log(`\n${C.bold}${C.bgBlue}${C.white} ${text} ${C.reset}\n`);
}

function subheader(text: string) {
  console.log(`\n  ${C.bold}${C.blue}── ${text} ──${C.reset}\n`);
}

function step(text: string) {
  console.log(`  ${C.cyan}→${C.reset} ${text}`);
}

function info(label: string, value: string) {
  console.log(`    ${C.dim}${label}:${C.reset} ${value}`);
}

function ok(text: string) {
  console.log(`  ${C.green}✓${C.reset} ${text}`);
}

function warn(text: string) {
  console.log(`  ${C.yellow}⚠${C.reset} ${text}`);
}

function lateral(text: string) {
  console.log(`  ${C.magenta}◆${C.reset} ${C.bold}${text}${C.reset}`);
}

function escalation(text: string) {
  console.log(`  ${C.bgRed}${C.white}${C.bold} ${text} ${C.reset}`);
}

function divider() {
  console.log(`  ${C.dim}${'─'.repeat(56)}${C.reset}`);
}

const PERSONA_EMOJI: Record<string, string> = {
  multistability: '🔄',
  simplicity: '💎',
  reification: '🧩',
  invariance: '🪨',
};

const PERSONA_DESC: Record<string, string> = {
  multistability: '다른 각도로 보기',
  simplicity: '단순하게 줄이기',
  reification: '빠진 조각 채우기',
  invariance: '성공 패턴 복제하기',
};

// ─── Test Data ───────────────────────────────────────────────

function createSpec(): Spec {
  return {
    version: '1.0.0',
    goal: '사용자 인증 시스템 구현 (JWT + OAuth2)',
    constraints: ['JWT 기반 인증 필수', 'OAuth2 지원', 'bcrypt 비밀번호 해싱'],
    acceptanceCriteria: [
      '이메일/비밀번호로 회원가입 가능',
      'JWT 토큰으로 로그인 가능',
      '토큰 리프레시 엔드포인트 존재',
    ],
    ontologySchema: {
      entities: [
        { name: 'User', description: '시스템 사용자', attributes: ['email', 'password', 'role'] },
        { name: 'Token', description: 'JWT 토큰', attributes: ['accessToken', 'refreshToken', 'expiresAt'] },
      ],
      relations: [{ from: 'User', to: 'Token', type: 'has_many' }],
    },
    gestaltAnalysis: [
      { principle: 'closure' as const, finding: '토큰 리프레시 로직이 암묵적으로 필요', confidence: 0.9 },
    ],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      ambiguityScore: 0.15,
      generatedAt: new Date().toISOString(),
    },
  };
}

const planningSteps = {
  fg: {
    principle: 'figure_ground' as const,
    classifiedACs: [
      { acIndex: 0, acText: '이메일/비밀번호로 회원가입 가능', classification: 'figure' as const, priority: 'critical' as const, reasoning: '핵심 기능' },
      { acIndex: 1, acText: 'JWT 토큰으로 로그인 가능', classification: 'figure' as const, priority: 'critical' as const, reasoning: '핵심 기능' },
      { acIndex: 2, acText: '토큰 리프레시 엔드포인트 존재', classification: 'ground' as const, priority: 'medium' as const, reasoning: '보조 기능' },
    ],
  } satisfies FigureGroundResult,
  closure: {
    principle: 'closure' as const,
    atomicTasks: [
      { taskId: 'task-0', title: 'User 모델 설정', description: 'User 엔티티 생성', sourceAC: [0], isImplicit: false, estimatedComplexity: 'low' as const, dependsOn: [] },
      { taskId: 'task-1', title: '회원가입 구현', description: '회원가입 엔드포인트', sourceAC: [0], isImplicit: false, estimatedComplexity: 'medium' as const, dependsOn: ['task-0'] },
      { taskId: 'task-2', title: '로그인 구현', description: 'JWT 로그인', sourceAC: [1], isImplicit: false, estimatedComplexity: 'medium' as const, dependsOn: ['task-0'] },
      { taskId: 'task-3', title: '토큰 리프레시', description: '리프레시 엔드포인트', sourceAC: [2], isImplicit: false, estimatedComplexity: 'low' as const, dependsOn: ['task-2'] },
    ],
  } satisfies ClosureResult,
  proximity: {
    principle: 'proximity' as const,
    taskGroups: [
      { groupId: 'group-0', name: '사용자 관리', domain: 'auth', taskIds: ['task-0', 'task-1'], reasoning: '사용자 관련' },
      { groupId: 'group-1', name: '토큰 관리', domain: 'auth', taskIds: ['task-2', 'task-3'], reasoning: '토큰 관련' },
    ],
  } satisfies ProximityResult,
  continuity: {
    principle: 'continuity' as const,
    dagValidation: {
      isValid: true, hasCycles: false, hasConflicts: false,
      topologicalOrder: ['task-0', 'task-1', 'task-2', 'task-3'],
      criticalPath: ['task-0', 'task-2', 'task-3'],
    },
  } satisfies ContinuityResult,
};

const passingStructural: StructuralResult = {
  commands: [
    { name: 'lint', command: 'npm run lint', exitCode: 0, output: 'No errors' },
    { name: 'build', command: 'npm run build', exitCode: 0, output: 'Build success' },
    { name: 'test', command: 'npm test', exitCode: 0, output: 'All tests passed' },
  ],
  allPassed: true,
};

function makeLowEval(score = 0.5): EvaluationResult {
  return {
    verifications: [
      { acIndex: 0, satisfied: true, evidence: '회원가입 구현됨', gaps: [] },
      { acIndex: 1, satisfied: false, evidence: '부분 구현', gaps: ['JWT 토큰 생성 미완성'] },
      { acIndex: 2, satisfied: false, evidence: '미구현', gaps: ['리프레시 엔드포인트 없음'] },
    ],
    overallScore: score,
    goalAlignment: score + 0.1,
    recommendations: ['JWT 토큰 생성 로직 완성 필요', '리프레시 엔드포인트 추가 필요'],
  };
}

/** evaluate 3-call 한 방에 처리 */
function runEvaluation(engine: PassthroughExecuteEngine, sessionId: string, score: number) {
  // session 상태 리셋
  const s = engine.getSession(sessionId);
  s.status = 'executing';
  s.evaluateStage = undefined;
  s.structuralResult = undefined;
  s.evaluationResult = undefined;

  engine.startEvaluation(sessionId);
  engine.submitStructuralResult(sessionId, passingStructural);
  engine.submitEvaluation(sessionId, makeLowEval(score));
}

/** lateral 결과 제출 + re-execute + re-evaluate 일괄 처리 */
function handleLateral(
  engine: PassthroughExecuteEngine,
  sessionId: string,
  persona: string,
  reEvalScore: number,
) {
  const lrResult = engine.submitLateralResult(sessionId, {
    persona: persona as any,
    specPatch: {
      acceptanceCriteria: [
        '이메일/비밀번호로 회원가입 가능',
        `JWT 로그인 (${persona} 관점 리프레이밍)`,
        '토큰 리프레시 엔드포인트 존재',
      ],
    },
    description: `${persona} 관점에서 요구사항을 재구성: ${PERSONA_DESC[persona] ?? ''}`,
  });

  if (!lrResult.ok) {
    warn(`  lateral result 제출 실패: ${lrResult.error.message}`);
    return;
  }

  const impacted = lrResult.value.impactedTaskIds;
  info('Impacted Tasks', `${impacted.length}개 (${impacted.join(', ')})`);

  // Re-execute
  for (const taskId of impacted) {
    engine.submitReExecuteTaskResult(sessionId, {
      taskId,
      status: 'completed',
      output: `${taskId} 재실행 완료 (${persona})`,
      artifacts: [],
    });
  }
  if (impacted.length > 0) step('Impacted tasks 재실행 완료');

  // Re-evaluate
  runEvaluation(engine, sessionId, reEvalScore);
  warn(`Re-evaluation 완료: score=${reEvalScore.toFixed(2)} (여전히 threshold 미달)`);
}

// ─── Simulation ─────────────────────────────────────────────

async function simulate() {
  const dbPath = `.gestalt-test/simulate-lateral-${randomUUID()}.db`;

  console.log(`\n${C.bold}${C.bgMagenta}${C.white} Lateral Thinking Personas — E2E 시뮬레이션 ${C.reset}`);
  console.log(`${C.dim}DB: ${dbPath}${C.reset}`);

  const store = new EventStore(dbPath);
  const engine = new PassthroughExecuteEngine(store);

  try {
    // ═══════════════════════════════════════════════════════
    // Phase 1: Planning
    // ═══════════════════════════════════════════════════════
    header('Phase 1: Planning');

    const spec = createSpec();
    step(`Spec: "${spec.goal}"`);

    const startResult = engine.start(spec);
    if (!startResult.ok) throw new Error(startResult.error.message);
    const sessionId = startResult.value.session.sessionId;
    info('Session ID', sessionId.slice(0, 8) + '...');

    engine.planStep(sessionId, planningSteps.fg);
    engine.planStep(sessionId, planningSteps.closure);
    engine.planStep(sessionId, planningSteps.proximity);
    engine.planStep(sessionId, planningSteps.continuity);
    engine.planComplete(sessionId);
    ok('4단계 Planning 완료 (Figure-Ground → Closure → Proximity → Continuity)');

    // ═══════════════════════════════════════════════════════
    // Phase 2: Execution
    // ═══════════════════════════════════════════════════════
    header('Phase 2: Execution');

    engine.startExecution(sessionId);
    for (const taskId of ['task-0', 'task-1', 'task-2', 'task-3']) {
      engine.submitTaskResult(sessionId, {
        taskId, status: 'completed', output: `${taskId} 구현 완료`, artifacts: [`src/${taskId}.ts`],
      });
    }
    ok('4개 태스크 실행 완료');

    // ═══════════════════════════════════════════════════════
    // Phase 3: Evaluation (의도적 낮은 점수)
    // ═══════════════════════════════════════════════════════
    header('Phase 3: Evaluation');

    engine.startEvaluation(sessionId);
    engine.submitStructuralResult(sessionId, passingStructural);
    ok('Structural 통과 (lint, build, test)');

    engine.submitEvaluation(sessionId, makeLowEval(0.50));
    warn('Contextual 평가: score=0.50, goalAlignment=0.60');
    info('AC[0]', `${C.green}충족${C.reset}`);
    info('AC[1]', `${C.red}미충족${C.reset} — JWT 토큰 생성 미완성`);
    info('AC[2]', `${C.red}미충족${C.reset} — 리프레시 엔드포인트 없음`);

    // ═══════════════════════════════════════════════════════
    // Phase 4: Evolution Loop → Stagnation 유발
    // ═══════════════════════════════════════════════════════
    header('Phase 4: Evolution Loop → Stagnation 유발');
    console.log(`  ${C.dim}score를 거의 변하지 않게 유지하여 stagnation 조건을 트리거합니다${C.reset}\n`);

    // EVOLVE_MAX_CONTEXTUAL=3, EVOLVE_STAGNATION_COUNT=2 이므로
    // 3번의 contextual evolution (거의 동일한 score)으로 stagnation + hard_cap 유발
    for (let gen = 0; gen < 3; gen++) {
      const evolveResult = engine.startContextualEvolve(sessionId);
      if (!evolveResult.ok) { warn(`실패: ${evolveResult.error.message}`); break; }

      if (evolveResult.value.lateralContext) {
        // 일찍 lateral 진입 — Phase 5로 넘어감
        lateral(`조기 lateral 진입! (gen ${gen})`);
        break;
      }

      if (evolveResult.value.evolveContext) {
        const score = 0.50 + gen * 0.002; // 거의 변화 없는 점수
        step(`Gen ${gen}: evolve → patch 제출 → re-evaluate (score=${score.toFixed(3)})`);

        engine.submitSpecPatch(sessionId, {
          acceptanceCriteria: [
            '이메일/비밀번호로 회원가입 가능',
            `JWT 로그인 (gen-${gen} 수정)`,
            '토큰 리프레시 엔드포인트 존재',
          ],
        });

        runEvaluation(engine, sessionId, score);
      }

      if (evolveResult.value.terminated) {
        ok(`종료: ${evolveResult.value.terminationReason}`);
        break;
      }
    }

    // ═══════════════════════════════════════════════════════
    // Phase 5: Lateral Thinking — 4 Personas 순회
    // ═══════════════════════════════════════════════════════
    header('Phase 5: Lateral Thinking Personas');
    console.log(`  ${C.dim}stagnation/hard_cap 감지 시 4개 persona가 순차적으로 대안 접근을 시도합니다${C.reset}`);
    console.log(`  ${C.dim}Pattern → Persona 매핑:${C.reset}`);
    console.log(`    ${C.dim}spinning     → multistability (다른 각도로 보기)${C.reset}`);
    console.log(`    ${C.dim}oscillation  → simplicity     (단순하게 줄이기)${C.reset}`);
    console.log(`    ${C.dim}no_drift     → reification    (빠진 조각 채우기)${C.reset}`);
    console.log(`    ${C.dim}diminishing  → invariance     (성공 패턴 복제하기)${C.reset}`);
    console.log();

    let personaCount = 0;

    for (let attempt = 0; attempt < 10; attempt++) {
      const session = engine.getSession(sessionId);
      // failed = terminal (human_escalation 등), 즉시 종료
      if (session.status === 'failed') break;

      // lateral을 이미 시도했으면 startLateralEvolve, 아니면 startContextualEvolve
      // (startContextualEvolve도 내부에서 lateral 자동 분기)
      const result = session.lateralAttempts > 0
        ? engine.startLateralEvolve(sessionId)
        : engine.startContextualEvolve(sessionId);

      if (!result.ok) { warn(`실패: ${result.error.message}`); break; }

      // ── Human Escalation (4개 persona 소진) ──
      if (result.value.humanEscalation) {
        const esc = result.value.humanEscalation;

        divider();
        console.log();
        escalation(' HUMAN ESCALATION — 모든 Lateral Persona 소진 ');
        console.log();
        info('시도한 Personas', esc.triedPersonas.map((p) => `${PERSONA_EMOJI[p] ?? ''} ${p}`).join(', '));
        info('최고 점수', `${C.yellow}${esc.bestScore.toFixed(2)}${C.reset} (threshold: 0.85)`);
        info('Termination', `${C.red}human_escalation${C.reset}`);
        console.log();
        step('제안 사항:');
        for (const s of esc.suggestions) {
          console.log(`      ${C.dim}-${C.reset} ${s}`);
        }
        console.log();
        info('메시지', esc.message);
        break;
      }

      // ── Terminated (success 등) ──
      if (result.value.terminated) {
        ok(`Evolution 종료: ${result.value.terminationReason}`);
        break;
      }

      // ── Lateral Context 반환 ──
      if (result.value.lateralContext) {
        personaCount++;
        const ctx = result.value.lateralContext;
        const emoji = PERSONA_EMOJI[ctx.persona] ?? '◆';
        const desc = PERSONA_DESC[ctx.persona] ?? '';

        divider();
        lateral(`${emoji} Persona ${personaCount}/4: ${ctx.persona.toUpperCase()}`);
        info('전략', desc);
        info('감지 패턴', ctx.pattern);
        info('Attempt', `${ctx.attemptNumber}`);
        info('System Prompt', ctx.systemPrompt.slice(0, 80) + '...');
        console.log();

        // lateral result 제출 → re-execute → re-evaluate
        step(`${ctx.persona} spec patch 제출 + 재실행 + 재평가...`);
        handleLateral(engine, sessionId, ctx.persona, 0.52 + personaCount * 0.02);
        continue;
      }

      // ── evolveContext (normal evolve — stagnation 미도달) ──
      if (result.value.evolveContext) {
        step(`Normal evolve 계속 (stagnation 미트리거)`);
        engine.submitSpecPatch(sessionId, {
          acceptanceCriteria: ['회원가입', `JWT 로그인 (attempt-${attempt})`, '토큰 리프레시'],
        });
        runEvaluation(engine, sessionId, 0.50);
        continue;
      }
    }

    // ═══════════════════════════════════════════════════════
    // Final State
    // ═══════════════════════════════════════════════════════
    header('Final Session State');
    const final = engine.getSession(sessionId);

    const statusColor = final.status === 'completed' ? C.green
      : final.status === 'failed' ? C.red : C.yellow;

    info('Status', `${statusColor}${final.status}${C.reset}`);
    info('Termination Reason', `${final.terminationReason ?? 'none'}`);
    info('Evolution Generations', `${final.evolutionHistory.length}`);
    info('Lateral Attempts', `${final.lateralAttempts}`);
    info('Tried Personas', final.lateralTriedPersonas.map((p) => `${PERSONA_EMOJI[p] ?? ''} ${p}`).join(', ') || 'none');
    info('Current Generation', `${final.currentGeneration}`);
    info('Current Spec ACs', final.spec.acceptanceCriteria.join(' | '));

    console.log(`\n${C.bold}${C.bgGreen}${C.white} 시뮬레이션 완료 ${C.reset}\n`);

  } finally {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  }
}

simulate().catch((e) => {
  console.error(`\n${C.red}Error:${C.reset}`, e);
  process.exit(1);
});
