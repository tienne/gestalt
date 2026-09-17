import type { InterviewEngine } from '../../interview/engine.js';
import type { StatusInput } from '../schemas.js';
import type { EventStore } from '../../events/store.js';
import type { GestaltConfig } from '../../core/config.js';
import { ExecuteSessionRepository } from '../../execute/repository.js';
import { getVersion, getCachedUpdateResult, getSessionVersion } from '../../core/version.js';
import { resolveStatusSessionId } from '../session-selector.js';

/** 응답 하나에 실어 보낼 오류 줄 수. 넘는 만큼은 개수로만 알린다 */
const MAX_ERROR_LINES = 20;

/**
 * 깨진 선언의 이유를 응답에 실을 꼴로 줄인다.
 *
 * zod 가 받은 값을 에러 문구에 되풀이하므로 줄 길이도 줄 수도 묶는다. 이 값은
 * 매 응답에 실려 에이전트 컨텍스트로 들어간다.
 *
 * **ruleSources 는 자르지 않는다.** 스킬이 읽는 ref 가 이 값뿐이라 한 글자만 바뀌어도
 * 못 읽는 경로가 된다. 그 실패는 onMissing 을 타고 조용히 지나간다. 길이는 스키마가
 * 거부로 막는다.
 */
function projectErrorLines(lines: string[]): string[] {
  return lines.slice(0, MAX_ERROR_LINES).map((message) => clamp(message, 200));
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 두 status 경로가 공유하는 config 정보.
 *
 * claude-code는 항상 passthrough라 handleStatus가 아니라 server.ts의
 * handleStatusPassthrough를 탄다. 두 곳이 각자 이 객체를 만들면 한쪽에만 필드를
 * 넣어도 테스트는 통과하고 실제 호출에는 안 나온다. 그래서 한 곳에서 만든다.
 */
export function buildStatusConfigInfo(config?: GestaltConfig) {
  return {
    reasoningModel: config?.reasoningModel ?? null,
    reasoningModelFallback: config?.reasoningModelFallback ?? null,
    // 등록 에이전트가 없는 인라인 서브에이전트(예: review-reply의 스레드 분류)도
    // tier 모델을 골라야 한다. ges_agent get은 에이전트 이름을 요구하므로
    // 그런 자리에서는 이 표가 유일한 조회 경로다. 소비처 개수는 여기 적지 않는다 —
    // 스킬이 늘 때 같이 안 고쳐져서 어긋난다. 규칙은 _shared/agent-model.md에 있다.
    tierModels: config?.tierModels ?? null,
    // execute Phase 0이 레포 밖 기준을 읽을 때 쓴다. 스킬이 gestalt.json을 직접
    // 파싱하면 resolve 규칙이 두 벌이 되므로 서버가 resolve한 값만 내보낸다.
    // 적용 규칙은 _shared/rule-sources.md에 있다.
    ruleSources: config?.ruleSources ?? [],
    // 비어 있지 않으면 선언 일부가 빠진 것이다. 무엇이 빠졌는지 모르면
    // onMissing: "stop"으로 걸어둔 검사가 안 돈 채 지나간다.
    // 안에 든 문구는 대상 레포가 쓴 값이다 — 읽는 쪽 규칙은 rule-sources.md에 있다.
    ruleSourceErrors: projectErrorLines(config?.ruleSourceErrors ?? []),
    // 멈출 사유는 아니고 짚어줄 거리다. 둘을 한 필드에 담으면 탐지기를 넓힐 때마다
    // 그게 세션을 세우는 레버가 된다
    ruleSourceWarnings: projectErrorLines(config?.ruleSourceWarnings ?? []),
    // 몇 줄이 안 실렸는지는 문자열이 아니라 수로 싣는다. 스킬이 이 배열을 사용자에게
    // 옮겨 적으므로, 문장으로 끼워 넣으면 그게 오류 한 건처럼 읽힌다
    ruleSourceErrorCount: (config?.ruleSourceErrors ?? []).length,
    ruleSourceWarningCount: (config?.ruleSourceWarnings ?? []).length,
  };
}

export function handleStatus(
  engine: InterviewEngine,
  rawInput: StatusInput,
  eventStore?: EventStore,
  config?: GestaltConfig,
): string {
  const updateResult = getCachedUpdateResult();
  // current 는 이 세션이 실제로 로드한 플러그인 버전이다. 서버 자기 버전과 어긋날 수
  // 있어서 server 를 따로 싣는다 — 둘이 다르면 전역 설치가 핀을 이긴 상태다.
  const session = getSessionVersion();
  const versionInfo = {
    current: session.version,
    source: session.source,
    server: getVersion(),
    latest: updateResult?.latestVersion ?? null,
    updateAvailable: updateResult?.updateAvailable ?? false,
  };
  const statusConfigInfo = buildStatusConfigInfo(config);

  const sessionType = rawInput.sessionType ?? 'all';

  const resolvedSessionId = rawInput.sessionId
    ? resolveStatusSessionId(rawInput.sessionId, sessionType, {
        listInterviewSessions: () => engine.listSessions(),
        listExecuteSessions: () =>
          eventStore ? new ExecuteSessionRepository(eventStore).reconstructAll() : [],
      })
    : null;
  if (resolvedSessionId && !resolvedSessionId.ok) {
    return JSON.stringify({ ...statusConfigInfo, error: resolvedSessionId.error }, null, 2);
  }
  const input: StatusInput = { ...rawInput, sessionId: resolvedSessionId?.sessionId };

  try {
    if (input.sessionId) {
      // Try interview first
      try {
        const session = engine.getSession(input.sessionId);
        const answeredRounds = session.rounds.filter((r) => r.userResponse).length;
        const scoreStr = session.resolutionScore
          ? ` (score ${session.resolutionScore.overall.toFixed(2)})`
          : '';
        const interviewSummary = `세션 ${session.sessionId.slice(0, 8)}: ${session.status} — ${answeredRounds}/${session.rounds.length} 라운드 완료${scoreStr}`;
        return JSON.stringify(
          {
            versionInfo,
            ...statusConfigInfo,
            type: 'interview',
            summary: interviewSummary,
            session: {
              sessionId: session.sessionId,
              topic: session.topic,
              status: session.status,
              projectType: session.projectType,
              totalRounds: session.rounds.length,
              answeredRounds,
              resolutionScore: session.resolutionScore
                ? {
                    overall: session.resolutionScore.overall.toFixed(2),
                    isReady: session.resolutionScore.isReady,
                    contradictions: session.resolutionScore.contradictions ?? [],
                  }
                : null,
              rounds: session.rounds.map((r) => ({
                roundNumber: r.roundNumber,
                gestaltFocus: r.gestaltFocus,
                contradictions: r.contradictions ?? [],
              })),
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
            },
          },
          null,
          2,
        );
      } catch {
        // Not found in interview — try execute if eventStore available
        if (eventStore) {
          const repo = new ExecuteSessionRepository(eventStore);
          const execSession = repo.reconstruct(input.sessionId);
          if (execSession) {
            const formatted = formatExecuteSessionBasic(execSession);
            return JSON.stringify(
              {
                versionInfo,
                ...statusConfigInfo,
                type: 'execute',
                summary: formatted.summary,
                session: formatted,
              },
              null,
              2,
            );
          }
        }
        throw new Error(`Session not found: ${input.sessionId}`);
      }
    }

    // List mode
    const interviewSessions =
      sessionType === 'interview' || sessionType === 'all'
        ? engine.listSessions().map((s) => ({
            sessionId: s.sessionId,
            topic: s.topic,
            status: s.status,
            projectType: s.projectType,
            totalRounds: s.rounds.length,
            resolutionScore: s.resolutionScore?.overall.toFixed(2) ?? 'N/A',
            hasContradictions: (s.resolutionScore?.contradictions?.length ?? 0) > 0,
            createdAt: s.createdAt,
          }))
        : [];

    let executeSessions: ReturnType<typeof formatExecuteSessionBasic>[] = [];
    if ((sessionType === 'execute' || sessionType === 'all') && eventStore) {
      const repo = new ExecuteSessionRepository(eventStore);
      executeSessions = repo.reconstructAll().map(formatExecuteSessionBasic);
    }

    return JSON.stringify(
      {
        versionInfo,
        ...statusConfigInfo,
        interviewSessions,
        executeSessions,
        total: { interview: interviewSessions.length, execute: executeSessions.length },
      },
      null,
      2,
    );
  } catch (e) {
    return JSON.stringify(
      {
        ...statusConfigInfo,
        error: e instanceof Error ? e.message : String(e),
      },
      null,
      2,
    );
  }
}

function formatExecuteSessionBasic(session: import('../../core/types.js').ExecuteSession) {
  const totalTasks = session.executionPlan?.atomicTasks.length ?? 0;
  const completedTasks = session.taskResults.filter((t) => t.status === 'completed').length;

  let summary: string;
  const shortId = session.sessionId.slice(0, 8);
  if (session.status === 'completed') {
    const scoreStr =
      session.evaluationResult?.overallScore != null
        ? ` score ${session.evaluationResult.overallScore.toFixed(2)}`
        : '';
    const alignStr =
      session.evaluationResult?.goalAlignment != null
        ? `, alignment ${session.evaluationResult.goalAlignment.toFixed(2)}`
        : '';
    summary = `세션 ${shortId}: completed —${scoreStr}${alignStr}`;
  } else if (totalTasks > 0) {
    const pct = Math.round((completedTasks / totalTasks) * 100);
    summary = `세션 ${shortId}: ${session.status} 단계, ${completedTasks}/${totalTasks} 태스크 완료 (${pct}%)`;
  } else {
    summary = `세션 ${shortId}: ${session.status} 단계, 0개 태스크 완료`;
  }

  return {
    sessionId: session.sessionId,
    specId: session.specId,
    status: session.status,
    goal: session.spec.goal,
    summary,
    taskProgress: totalTasks > 0 ? `${completedTasks}/${totalTasks}` : null,
    evaluationScore: session.evaluationResult?.overallScore ?? null,
    goalAlignment: session.evaluationResult?.goalAlignment ?? null,
    currentGeneration: session.currentGeneration,
    terminationReason: session.terminationReason ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
