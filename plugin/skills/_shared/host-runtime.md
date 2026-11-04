# 호스트별 도구 호출

스킬 본문의 `Agent`, `Explore`, `AskUserQuestion`, `TaskCreate`는 Claude Code 표기다.
실행 전에 이 문서를 읽고 **현재 호스트가 실제로 제공한 도구**로 옮긴다. Codex에서는 이 문서가
다른 문서의 Claude 전용 타입, 모델 필수 인자, `sonnet` 폴백 지시보다 우선한다.
MCP 도구의 입력과 2-Call 제출 계약은 호스트가 바뀌어도 그대로다.

모든 호스트에서 스킬의 `gestalt ...` 예시는 먼저 [CLI 실행 지침](./cli-launcher.md)을 읽고
버전 고정 런처로 실행한다. 개별 스킬에 이 링크가 없어도 적용하며 파이프라인과 `xargs` 호출도 포함한다.

## Codex

`ges_status {}`의 `hostClient`가 `codex`이면 Codex 모델 기본값은 `inherit`다.
`client`는 실행 컨텍스트를 기록할 파일의 선택이라 `both`일 수도 있다. 이 값을 호스트 판정과 혼동하지 않는다.
`hostClient`가 없는 이전 서버와 연결돼 있어도 현재 호스트가 Codex이면 서버의 Claude 별칭을 그대로 모델 인자로 보내지 않는다. `fable`, `haiku`, `sonnet`, `opus`는 이때 `inherit`로 취급한다. 명시한 다른 모델 ID는 유지한다. 이전 서버에는 `ges_execute` 요청의 `client: "codex"`도 명시해 컨텍스트 기록 대상을 맞추고 플러그인 갱신을 안내한다.
사용자가 명시한 모델 ID와 실제 도구의 지원 여부를 우선한다. Claude 모델 별칭을 GPT 모델로 추측해서 바꾸지 않는다.
실행 태스크의 자동 `task.model`이 `haiku`, `sonnet`, `opus`이면 기존 tier 힌트다. 각각 `ges_status`의
`tierModels.frugal`, `tierModels.standard`, `tierModels.frontier`로 해석한 뒤 아래 모델 규칙을 적용한다.
명시적인 Codex 모델 ID는 다시 매핑하지 않는다.

| 본문의 표기 | Codex에서 수행할 일 |
|---|---|
| `Agent`의 `gestalt:` 에이전트 타입 | [`agent-delegation.md`](./agent-delegation.md)의 Explore 폴백 프롬프트를 사용해 범용 서브에이전트 안에서 `ges_agent get`으로 페르소나를 받는다. 해당 문서의 절차대로 룰북 디렉토리를 절대 경로로 풀어 프롬프트에 직접 넣는다. 경로를 못 풀었으면 그 사실을 보고한다. `subagent_type`은 전달하지 않는다. |
| `Explore` | 읽기 전용 조사를 위임한다. 실제 읽기 전용 타입이 없으면 파일 수정, 커밋, 외부 전송 금지를 프롬프트에 명시하고 도구로 강제된 제한이라고 말하지 않는다. |
| `Agent.model`, `reasoningModel`, `tierModels` | `inherit`이면 모델 인자를 생략한다. 명시 모델 ID는 스폰 도구가 받는 경우에만 전달한다. |
| `effort` | 해당 도구가 받는 `reasoning_effort` 또는 동등한 인자로 옮긴다. 지원하지 않는 인자는 보내지 않는다. |
| `AskUserQuestion` | 현재 모드의 질문 도구가 있으면 쓰고, 없으면 일반 대화로 묻는다. 필수 답변과 승인 없이 종속 단계를 실행하지 않는다. |
| `TaskCreate`, `TaskUpdate`, `TaskList` | 호스트의 진행 계획 도구가 있으면 쓰고, 없으면 짧은 진행 메시지로 알린다. 진행 패널 부재는 작업을 막지 않는다. |
| `Bash`, `Read`, `Grep`, `Glob`, `Edit`, `Write` | 호스트의 셸, 파일 읽기, 검색, 패치 도구를 사용한다. 명령 인자와 쓰기 범위는 그대로 지킨다. |

`spawn_agent`, `send_message`, `followup_task`, `wait_agent`가 제공되면 그 도구로 위임하고 결과를 기다린다.
일반 위임에서 스폰 스키마가 `fork_turns: "all"`일 때 모델 재지정을 금지하면, 상속 모델은 그대로 둔다.
모델이나 effort를 명시해야 하면 지원되는 `fork_turns: "none"`으로 필수 맥락과 절대 경로를 직접 전달한다.
독립 판정은 모델 선택과 무관하게 아래 **독립 판정 컨텍스트** 규칙을 우선한다.
이 매개변수가 없는 호스트에는 그 인자를 보내지 않는다. 특정 Codex 버전의 도구명을 필수 조건으로 삼지 않는다.

스폰 도구가 명시한 모델을 거절했을 때만 아래 순서로 재시도한다.
`ges_status.hostClient`가 `codex`인 새 서버에서는 `reasoningModelFallback`이 `inherit`가 아니면 그 값으로 한 번 재시도한다. `hostClient`가 없는 이전 서버에서는 Claude 기본 별칭이 아닌 폴백 ID만 사용한다. 그것도 거절되거나 별도 폴백 ID가 없으면 세션 상속으로 한 번 재시도하고 끝낸다. 서버 기본값인 Claude 별칭으로 재시도하지 않는다. `inherit`를 지원 모델 이름처럼 전달하지 않는다. 모델 선택을 지원하지 않는 호스트에서는
상속으로 실행하고 완료 보고에 모델 지정이 적용되지 않았음을 적는다.

서브에이전트가 없으면 일반 위임은 메인이 `ges_agent get`으로 페르소나를 받아 직접 수행할 수 있다.
이때 컨텍스트가 메인에 실렸음을 완료 보고에 밝힌다.

### 독립 판정 컨텍스트

**독립된 판정자가 필요한 단계**는 `doubt`, review의 3.5 `continuity-judge`, 3.7 `suggestion-verifier`다.
이 셋은 모델 재지정 여부와 무관하게 부모 이력을 상속하지 않는 새 컨텍스트에서 실행한다.
`model`이 `inherit`여서 인자를 생략하더라도, 실제 스폰 도구가 지원하면 **`fork_turns: "none"`을 지정한다.**
`fork_turns: "all"`이나 기본 이력 상속에 기대지 않는다. 일반 위임의 모델/effort 조건으로 이 규칙을 완화하지 않는다.

판정자에게는 **산출물, 계약, 필수 절대 경로만** 직접 전달한다. 산출물에는 검토 대상 diff와 제안 초안,
계약에는 목표와 스펙 제약, 판정 기준이 포함된다. 페르소나와 룰북 등 필수 참조도 절대 경로로 제공한다.
**작성자 추론, 부모 이력, 대화 요약, 앞선 자기 검토의 결론은 넘기지 않는다.**
각 호출부의 입력 제한도 지킨다. 특히 `continuity-judge`에는 다른 리뷰어의 `issues`를 보내지 않는다.

`fork_turns` 인자가 없는 도구에는 그 인자를 보내지 않는다. 대신 동등한 새 컨텍스트 격리가 보장되는
호스트 기능만 사용한다. 서브에이전트가 없거나 격리를 보장할 수 없으면 **미실행으로 보고하고
자기 검토를 독립 승인으로 보고하지 않는다.** `doubt`는 멈춘다. review의 제안 검증은 미실행을 알리고
초안을 유지한다. 정합 심급은 미실행 사실을 적고 Pass를 승인으로 게시하지 않는다.
MCP 자체의 부재는 [`tool-availability.md`](./tool-availability.md)를 따르며 도구 없이 세션이나 검사 결과를 만들지 않는다.

## Claude Code와 그 밖의 호스트

Claude Code는 기존 `Agent` 타입과 모델 별칭을 그대로 쓴다. `inherit`를 명시했다면 모델 인자를 생략한다.
Grok 등 다른 호스트도 실제 제공된 도구에 맞춰 같은 의미로 옮기며 지원 여부를 모르는 도구 이름이나 모델을 만들지 않는다.
