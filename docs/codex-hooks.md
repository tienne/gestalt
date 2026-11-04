# Codex 훅 지원 범위

Codex 자체의 훅 지원과 Gestalt가 제공하는 훅 통합은 구분한다. Gestalt의 현재 코드 그래프 자동 주입, WebFetch 캐시, peer 보는 중 표시는 Claude Code 전용이다.

## 공식 지원 환경

2026-11-05에 OpenAI 공식 [Package your plugin — Bundled MCP servers and lifecycle hooks](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)를 실제 열어 확인했다.

- 수동 설치한 Codex desktop 플러그인은 lifecycle hooks를 지원한다.
- 플러그인 설치나 활성화만으로 훅을 신뢰하지 않는다. 사용자가 현재 훅 정의를 검토하고 명시적으로 trust하기 전에는 실행을 건너뛴다.
- 훅이 포함된 플러그인은 public plugin directory에 제출할 수 없다.
- 실행 환경에 훅 스크립트가 있어야 한다. 웹에서 플러그인을 설치해도 스크립트가 배포되지는 않는다.

이 지원을 모든 Codex CLI, IDE 확장, cloud 실행이나 Orca 채팅에 같은 방식으로 적용할 수 있다고 단정하지 않는다. Orca의 스킬 검색과 Codex desktop의 플러그인 훅 로딩은 서로 다른 기능이다. 실제 호스트의 훅 로딩과 trust 지원은 별도로 확인해야 한다.

## Gestalt의 현재 통합

| 기능 | 현재 통합 | Codex에서 사용하는 경로 |
| --- | --- | --- |
| 코드 그래프 컨텍스트 자동 주입 | Claude Code 훅, 기본 꺼짐 | `ges_code_graph`를 명시적으로 호출 |
| WebFetch 디스크 캐시 | Claude Code 훅, 기본 꺼짐 | 이 캐시 통합은 제공하지 않음 |
| peer 보는 중 표시와 승인 대기 알림 | Claude Code 훅 | `gestalt peer shares`로 확인 |

구현 근거는 루트 [`hooks/hooks.json`](../hooks/hooks.json)과 그 파일이 호출하는 `scripts/` 런처다. Codex 마켓플레이스의 [`path: "./plugin"`](../.agents/plugins/marketplace.json)은 `plugin/`만 복사한다. 루트의 훅과 런처는 그 범위 밖이고 [`plugin/.codex-plugin/plugin.json`](../plugin/.codex-plugin/plugin.json)에도 Codex 훅 통합 선언은 없다. 파일 이름이 `hooks/hooks.json`으로 같아도 현재 Gestalt의 Claude 훅이 Codex 패키지에 포함되어 실행되는 것은 아니다.

기존 Claude 이벤트와 matcher, stdin payload, `hookSpecificOutput.additionalContext`, 종료 코드의 의미, 환경변수가 Codex에서도 그대로 동작한다고 보장하지 않는다. Codex용 통합에는 해당 호스트의 계약 검증이 필요하다. 이 문서 교정은 훅 스크립트나 매니페스트를 추가하지 않으며 훅을 자동 설치하거나 활성화하거나 trust하지 않는다.

`gestalt init`이 설치하는 Git post-commit 훅은 Git이 실행한다. 위 lifecycle hooks와 별개이며 Codex 훅 통합 유무와 혼동하지 않는다.

기능별 동작은 [코드 그래프](./code-graph.md#claude-code-훅-자동-주입), [WebFetch 캐시](./webfetch-cache.md), [peer 보는 중 표시](./peer.md#보는-중-표시)에 있다.
