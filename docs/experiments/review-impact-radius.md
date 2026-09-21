# 리뷰어에게 영향 범위를 미리 건네면 탐색이 줄어드나

리뷰 파이프라인 3단계는 리뷰어 서브에이전트에게 변경 파일 목록만 건네고 전문을 읽으라고 시킨다. 그다음은 리뷰어가 알아서 Grep과 Read로 주변을 뒤진다. 코드 그래프의 `diff_radius`와 `co_change`는 그 주변이 어디인지를 미리 뽑아줄 수 있는데 리뷰 스킬에는 아직 안 붙어 있다.

붙일 값어치가 있는지를 숫자로 보려고 A/B를 한 번 돌렸다. **결론은 붙이지 말자는 쪽이다.** 근거는 아래에 적는다.

## 무엇을 대상으로 잡았나

대상은 `e3b7f91` "fix(config): 검사하는 값과 여는 값을 같게 맞춘다"다.

| 항목 | 값 |
| --- | --- |
| 변경 파일 | 5개 |
| diff | 428줄 (178 추가, 51 삭제) |
| 변경 파일 전문 | 합쳐서 1,873줄 |

이 커밋을 고른 이유가 셋이다. 파일이 5개라 3단계가 실제로 받는 목록 크기와 비슷하다. 건드린 `src/core/config.ts`는 레포 전반에서 import되는 자리라 import 그래프가 할 말이 많다. 내용도 경로 검증 우회를 막는 보안성 수정이라 security-reviewer와 quality-reviewer 둘 다 판정할 거리가 있다.

리뷰어가 커밋 시점의 파일을 읽도록 `git worktree add /tmp/exp-target e3b7f91`로 그 시점을 떼어내 거기서 돌렸다. HEAD 워킹트리에서 읽으면 커밋 이후에 바뀐 내용을 읽게 된다.

## 영향 범위를 어떻게 뽑았나

이 레포에는 코드 그래프가 아예 없었다. `.gestalt/`에 `memory.json`과 `reviews.db`만 있고 `code-graph.db`가 없는 상태였다. 그래서 빌드 전에 없는 상태부터 재봤다.

### 그래프가 없을 때 — 에러가 안 난다

이게 이번에 재본 것 중에 제일 손이 가는 자리다. **그래프가 없어도 어느 액션도 에러를 던지지 않는다.** 대신 말이 되는 것처럼 생긴 빈 답이 돌아온다.

```
db_exists → { "exists": false }

stats     → { "totalFiles": 0, "totalNodes": 0, "totalEdges": 0,
              "lastBuiltAt": null, "dbSizeBytes": 4096 }

diff_radius → impactedFiles 가 변경 파일 자신뿐이고
              "riskScore": 0,
              "coChangeAvailable": false,
              "coChangeReason": "co-change history has not been collected for
                this repository — run a code graph build at the repo root",
              "summary": "... Risk: LOW (0.0%). Git history signal unavailable
                (import graph only)."
```

이력 신호 쪽은 `coChangeAvailable: false`와 `coChangeReason`이 정직하게 말한다. **import 신호 쪽에는 그런 표식이 없다.** 노드가 0개라 역방향 BFS가 아무것도 못 찾은 것인데 응답은 "영향받는 파일이 없고 위험도가 낮다"와 글자 그대로 똑같이 생겼다. 그래프를 안 빌드한 레포에서 이걸 리뷰 프롬프트에 그대로 실으면 리뷰어는 "영향 범위가 비어 있다"를 사실로 읽는다.

더 까다로운 자리가 하나 더 있다. `stats`나 `diff_radius`를 한 번 부르면 그 호출이 빈 DB 파일을 만들어버린다. 그래서 그다음부터 `db_exists`가 `true`를 돌려준다.

```
db_exists  → { "exists": false }     # 처음
stats      → 전부 0                   # 이 호출이 .gestalt/code-graph.db 를 만든다
db_exists  → { "exists": true }      # 같은 레포, 같은 상태, 답이 뒤집혔다
```

폴백 조건을 거는 자리에서는 `db_exists`를 믿으면 안 된다는 뜻이다. 빈 DB와 빌드된 DB를 가르는 값은 `stats.totalNodes`이고 이력 신호가 실렸는지는 `coChangeAvailable`이 가른다. 나중에 이 기능을 붙일 일이 생기면 게이트를 그 두 값에 건다.

### 빌드하고 나서

빌드는 한 번에 끝났다.

```
nodesBuilt 2196, edgesBuilt 2485, 6.5초
coChange: pairs 4737, commitsUsed 634, commitsScanned 1042
```

대상 커밋으로 `blast_radius`를 돌리니 변경 파일 5개에 딸려 **랭킹 31개**가 나왔다. 변경 파일 자신을 빼면 **영향 파일이 26개**다. import 신호가 `depthExhausted: true`로 깊이 2에서 멈췄고 안 본 노드가 6개 남았으니 26개도 하한이다.

출처별로는 이렇게 갈렸다.

| origin | 개수 | 예 |
| --- | --- | --- |
| `both` | 3 | `src/mcp/server.ts`, `tests/core/config.test.ts`, `tests/unit/mcp/server.test.ts` |
| `history` | 3 | `src/mcp/tools/agent-passthrough.ts`, `src/mcp/tools/interview.ts`, `src/core/constants.ts` |
| `import` | 20 | `src/cli/index.ts`, `src/llm/factory.ts`, `tests/unit/mcp/pr.test.ts` 외 |

`co_change`를 변경 파일별로 따로 물어본 결과도 신호 자체는 멀쩡하다. `src/core/config.ts`는 이웃 6개가 나왔고 그중 `tests/config.test.ts`가 18회에 confidence 0.86, `schemas/gestalt.schema.json`이 8회에 0.73이다. 이 커밋이 실제로 그 둘을 함께 고쳤으니 이력이 맞게 말한 셈이다. 다만 **이미 변경 파일 목록에 들어 있는 파일**이라 리뷰어에게 새로 알려줄 것은 아니었다.

## A/B를 어떻게 돌렸나

리뷰어는 security-reviewer와 quality-reviewer 둘로 잡았고 각각 두 번씩 띄웠다. 둘 다 tier가 `standard`라 sonnet으로 돌렸다.

- **A(대조)** — 지금 3단계 프롬프트 모양 그대로다. 에이전트 이름, 변경 파일 5개 목록, 전문을 읽으라는 지시, 리뷰 의도 한 줄
- **B(처치)** — A와 글자까지 같고 `영향 범위:` 블록 하나만 더 붙였다. 위에서 뽑은 26개를 출처 표시와 함께 나열하고 "어디부터 볼지 정하는 지도일 뿐이고 판정하려는 파일은 전문을 읽는다"를 덧붙였다

이번 세션에서는 MCP 서버가 안 떠서 `ges_agent get` 대신 `AGENT.md` 절대 경로를 읽게 했다. 네 번 다 같은 조건이라 A와 B의 비교에는 영향이 없다.

도구 호출 수는 에이전트에게 스스로 세서 JSON에 적게 시켰는데, 그 값을 믿지 않고 서브에이전트 트랜스크립트에서 `tool_use` 블록을 직접 세서 맞대봤다. 넷 중 셋은 자기 신고가 맞았고 B-security 하나가 10회를 9회로 적었다. 아래 표의 숫자는 전부 트랜스크립트에서 센 값이다.

## 결과

| 리뷰어 | 조건 | 도구 호출 | 내역 | 영향 목록에서 연 파일 | 이슈 | 심각도 | 토큰 |
| --- | --- | ---: | --- | ---: | ---: | --- | ---: |
| security | A | 5 | Bash 3, Read 2 | — | 0 | — | 39,421 |
| security | B | 10 | Bash 10 | **0 / 26** | 1 | warning | 49,716 |
| quality | A | 5 | Bash 3, Read 2 | — | 0 | — | 62,433 |
| quality | B | 5 | Bash 3, Read 2 | **0 / 26** | 0 | — | 68,180 |

네 번 다 `approved: true`였다.

quality 쪽은 A와 B가 도구 호출 5회에 내역까지 똑같았다. 연 파일도 `AGENT.md`, `comment-rules.md`, `config.ts`, `status.ts`로 같고 판정도 이슈 0개로 같다. 영향 범위 26줄을 프롬프트에 얹은 것이 행동을 하나도 안 바꿨다.

security 쪽은 B가 A의 두 배를 썼다. 늘어난 다섯 번이 어디서 왔는지 보면 이렇다.

```
sed -n '1,260p'   src/core/config.ts      # A는 Read 한 번으로 읽은 것을
sed -n '260,340p' src/core/config.ts      # B는 네 토막으로 나눠 읽었다
sed -n '340,620p' src/core/config.ts
sed -n '360,420p' tests/config.test.ts
git show e3b7f91~1:src/core/config.ts | grep -n "asc\|crt"
grep -n "asc\|crt" tests/config.test.ts
```

늘어난 호출은 전부 **변경 파일 자신**과 그 파일의 이전 버전을 향했다. 영향 범위 26개 중 한 개도 안 열었다.

B-security가 A가 못 찾은 것을 하나 찾긴 했다. `SECRET_FILE_REFS`에서 `.crt`와 `.asc`가 조용히 빠졌고 테스트가 그 자리를 안 덮는다는 warning이다. 그런데 그 의견이 나온 경로는 부모 커밋의 같은 파일을 `git show e3b7f91~1:src/core/config.ts`로 꺼내 grep한 것이다. 영향 범위 목록에는 부모 커밋이 없고 `config.ts`는 애초에 변경 파일이다. **영향 범위가 알려준 덕에 찾은 게 아니다.** 같은 프롬프트로 다시 돌리면 A가 찾고 B가 못 찾을 수도 있는, 리뷰어 한 번의 편차 쪽에 가깝다.

## 판정 — 붙이지 않는다

**`diff_radius`와 `co_change` 결과를 3단계 리뷰어 프롬프트에 싣지 않는다.** 숫자 셋이 근거다.

첫째로 **리뷰어가 그 목록을 안 쓴다.** B 두 번을 합쳐 도구 호출 15회 가운데 영향 범위 26개 파일을 향한 것이 0회다. 붙여준 줄이 읽히지도 않았으므로 탐색을 줄일 기회 자체가 안 생겼다.

둘째로 **탐색이 줄기는커녕 같거나 늘었다.** quality는 5회로 동일했고 security는 5회에서 10회로 늘었다. 애초에 세울 가설이 "덜 읽는다"였는데 반대 방향이 한 번 나오고 나머지 한 번은 변화가 없다. 원인은 간단하다. 변경 파일이 5개에 1,873줄이면 리뷰어가 전문을 읽는 것만으로 호출 대여섯 번에 끝난다. 줄일 여지가 있을 만큼 헤매고 있지 않았다.

셋째로 **값을 못 받는 대신 비용은 확실히 낸다.** 영향 범위 블록은 26줄이고 리뷰어 하나마다 프롬프트에 그대로 들어간다. 실제로 토큰이 security에서 39,421에서 49,716으로(26% 증가), quality에서 62,433에서 68,180으로(9% 증가) 늘었다. 3단계는 리뷰어를 4개에서 6개까지 띄우므로 이 증가분에 그만큼이 곱해진다. 여기에 그래프 빌드가 6.5초 붙는다. 빌드가 안 된 레포에서는 위에서 본 조용한 0건을 리뷰어에게 사실처럼 먹이는 위험까지 딸려 온다.

이슈 쪽은 결과가 갈리지 않았다고 보는 게 맞다. 4회 중 이슈가 나온 것이 1건뿐이라 이 표본으로는 "덜 찾는다"도 "더 찾는다"도 말할 수 없다. 다만 처치가 노린 효과가 도구 호출에서 0으로 나온 이상, 이슈 쪽에서 재실험할 근거도 약하다.

### 다시 볼 만한 조건

이 판정은 이번에 잡은 대상에 매인 것이다. 아래 조건이 달라지면 다시 재볼 값어치가 있다.

- **변경 파일이 20개를 넘는 큰 PR.** 전문을 읽는 것만으로 호출이 수십 번 나가면 그때는 읽을 순서를 정해주는 것이 값을 낼 수 있다
- **시그니처나 공용 유틸을 바꿔 호출부를 봐야 하는 변경.** 지금 스킬의 1단계는 의존 파일을 목록에 얹지 않기로 정해뒀다. 그 경우 "3단계에서 리뷰어가 직접 읽는다"로 넘긴다. 리뷰어가 실제로 그 호출부를 헤매 찾는지부터 재보고 나서 붙일지 정한다
- **`origin: history` 항목만 골라 싣는 좁은 형태.** 이번에는 26개를 통째로 실었는데 그중 import 신호만 있는 20개는 리뷰어가 마음만 먹으면 grep으로 찾을 수 있는 것들이다. 이력에만 걸린 3개는 다르다. 그 셋만 싣는 형태는 프롬프트 비용이 훨씬 싸므로 따로 재볼 만하다

### 재현

```bash
git worktree add /tmp/exp-target e3b7f91
# 코드 그래프는 gestalt init 또는 ges_code_graph build 로 빌드한다
# 대상 커밋의 영향 범위는 blast_radius 에 changedFiles 와 base: "e3b7f91~1" 을 넘겨 뽑는다
```

리뷰어 프롬프트 두 벌과 조건별 트랜스크립트는 이 문서의 표로 옮겨 적은 것이 전부고 따로 보관하지 않았다.
