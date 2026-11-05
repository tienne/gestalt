# 실제 Codex opt-in E2E

`pnpm test:codex-e2e`는 기본적으로 `status: skipped`와 종료 코드 0을 반환한다. 이 경로에서는 Codex 실행 파일, 인증이나 네트워크에 접근하지 않는다. `pnpm test`와 `pnpm gate`에는 실제 추론이 들어가지 않는다.

직접 실행하려면 먼저 이 체크아웃에서 Node >=22, 의존성(`pnpm install --frozen-lockfile`), 인증된 Codex CLI를 준비한다. 실제 모델 사용량과 비용이 발생할 수 있다.

```sh
codex --version
codex --help
codex exec --help
codex login status
GESTALT_CODEX_E2E=1 pnpm test:codex-e2e
```

구현 시 확인한 CLI는 `codex-cli 0.166.0`이다. 실행할 때도 버전과 도움말에서 필요한 옵션을 확인하고 호환되지 않으면 실패한다. 모델 인자는 기본 생략하므로 CLI 기본 모델이 적용된다. 필요하면 `GESTALT_CODEX_E2E_MODEL`로 접근 가능한 모델 ID를 지정한다. 실행 파일은 `GESTALT_CODEX_E2E_BIN`, 추론 제한 시간은 `GESTALT_CODEX_E2E_TIMEOUT_MS`로 지정할 수 있다. 기본은 180000ms이며 1000–600000ms 범위의 정수만 허용한다. 사전 검사마다 별도의 15초 상한이 있다. 프로세스 그룹 정리를 사용하는 POSIX 환경용이며 Windows에서는 opt-in 실행을 실패 처리한다.

## 검증하는 계약

1. 임시 디렉터리에 체크아웃의 `plugin/` 전체를 실제 파일로 복사한다. interview 스킬과 상대 참조 자산을 함께 보존한다.
2. fixture의 `AGENTS.md`가 복사된 interview 스킬과 필수 호스트 참조를 읽도록 지시한다. 목표는 `tests/fixtures/codex-e2e/goal.md`의 자연어 요청이다. 첫 답변은 fixture 사용자가 미리 제공한 한 문장이고 모델이 추가 답변을 지어내면 안 된다.
3. 실제 `codex exec --json`이 스킬을 읽고 인터뷰를 시작하며 주어진 답변을 기록한 뒤 세션 상태를 조회한다. 하네스가 MCP 클라이언트로 이 호출을 대신하지 않는다.
4. 완료된 command 이벤트에서 스킬 파일 경로와 전체 본문 읽기를 확인한다. 성공한 `ges_interview start/respond`, 동일 ID의 `ges_status` 응답과 완료된 추론 turn을 검사한다. 최종 응답 문구 자체는 성공 기준이 아니다.
5. Codex와 MCP가 끝난 뒤 격리 SQLite DB를 읽기 전용으로 열어 동일 세션의 시작, 질문 및 제공된 답변의 영속 이벤트를 대조한다. 답변은 정확히 하나여야 하고 세션을 완료하거나 중단하면 실패한다. 빈 DB, 다른 세션, JSONL 폴백은 성공으로 인정하지 않는다.

**이것은 명시적 파일 자산 로딩을 통한 LLM E2E다.** 네이티브 plugin marketplace 발견, 설치, 스킬 자동 선택이나 플러그인 매니페스트의 MCP 자동 로딩을 검증하지 않는다. 결과에도 `loading: explicit-file-assets`를 남긴다. 기존 `tests/integration/codex-plugin.test.ts`는 복사 자산과 SDK 기반 실제 로컬 MCP를 검사하는 결정형 테스트이며 LLM E2E가 아니다. 새 단위 테스트의 합성 이벤트도 판정 경계 검사용일 뿐이다.

## 격리와 인증

Codex는 부모의 기존 `HOME`/`CODEX_HOME` 및 필요한 인증 환경을 그대로 사용한다. 인증 파일을 읽어 복사하거나 fixture에 저장하지 않는다. `--ignore-user-config`로 부모 `config.toml` 대신 이번 실행의 로컬 MCP 설정을 지정하고 `--ephemeral --no-daemon`으로 지속 Codex transcript와 공유 데몬 사용을 피한다. 조직에서 강제한 설정은 우회하지 않으며 필수 보안 정책과 충돌하면 실패로 보고한다. 보안 설정을 전체 해제하는 플래그는 사용하지 않는다. 모델의 셸 실행은 read-only sandbox, 승인 요청은 `never`, 셸 환경 상속은 `none`이다.

MCP는 `/usr/bin/env -i`를 거쳐 **현재 체크아웃의** 절대 Node 실행 파일, `node_modules/tsx/dist/loader.mjs`, `bin/gestalt.ts serve`로 기동한다. 부모 인증이나 LLM 키를 전달하지 않고 여섯 자산 디렉터리는 복사된 plugin을 가리킨다. home, DB와 프로젝트는 매 실행 새 temp 디렉터리를 사용한다. 허용 MCP 도구는 `ges_status`와 `ges_interview`뿐이다. 이 격리 서버에만 `default_tools_approval_mode: approve`를 지정해 해당 두 도구의 무인 호출을 허용한다. 기본 승인 모드에서는 `never` 정책 때문에 호출이 거부되는 것을 실제 실행으로 확인했다. 전역 승인 설정이나 부모 설정 파일은 바꾸지 않는다. 배포 매니페스트를 바꾸거나 `npx @tienne/gestalt`를 실행하지 않는다.

stdout/stderr 원문은 합계 8 MiB 이내에서 메모리로만 처리하고 저장하거나 출력하지 않는다. 결과 로그는 고정된 상태, 실패 분류와 체크포인트, 검증된 CLI 버전, 세션 ID와 증거 개수만 출력한다. 예외 메시지, 모델 산문, 실행 명령, 인증 상태 원문, 환경변수를 노출하지 않는다. 종료, timeout, SIGINT/SIGTERM 시 자식 프로세스 그룹을 종료하고 임시 자산과 DB를 삭제한다. SIGKILL이나 호스트 장애에는 cleanup을 보장할 수 없다.

## 결과 해석

| 결과                           | 종료 코드 | 의미                                                                                      |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| `skipped`                      | 0         | `GESTALT_CODEX_E2E=1`이 없어 실제 추론 미실행                                             |
| `passed`                       | 0         | 실제 CLI 추론, 자산 읽기, MCP 호출 및 영속 상태 증거가 모두 일치                          |
| `failed: prerequisite`         | 1         | 실행 파일, 옵션, OS, 의존성이나 fixture 준비 실패                                         |
| `failed: auth`                 | 1         | opt-in 뒤 CLI 인증 사전 검사 실패                                                         |
| `failed: inference`            | 1         | opt-in 뒤 CLI 실행 실패 또는 인터럽트 (인증 만료, 정책, 네트워크, 모델 접근 실패 등 포함) |
| `failed: timeout/output-limit` | 1         | 제한 시간이나 출력 상한 초과                                                              |
| `failed: evidence`             | 1         | 종료 코드 0이어도 스킬/MCP/DB 증거 불충분                                                 |

추론 중 인증이 만료되면 CLI의 원문을 해석하지 않으므로 `inference`로 분류한다. 실패를 skipped나 성공으로 바꾸지 않는다. 지원되는 필드가 다른 CLI 버전에서도 증거가 없으면 실패하며 산문 주장으로 보완하지 않는다.

## 근거와 오프라인 검사

공식 OpenAI 문서의 [non-interactive mode](https://developers.openai.com/codex/noninteractive)는 JSONL 이벤트, 기존 인증 재사용과 `--ignore-user-config`를 설명한다. [MCP 설정](https://developers.openai.com/codex/mcp)의 stdio 서버, `required`, `enabled_tools` 및 timeout 설정과 [스킬 문서](https://developers.openai.com/codex/skills)를 참고했다. CLI 플래그의 실제 사용 가능 여부는 설치된 `--help`로 다시 확인한다.

```sh
pnpm exec vitest run tests/scripts/codex-e2e.test.ts tests/integration/codex-plugin.test.ts
```

이 명령은 인증 없이 opt-in, 실패, 출력/시간 제한 및 증거 판정 경계를 검사한다. 실제 실행 증거는 별도의 opt-in 명령 결과로 보고해야 한다.
