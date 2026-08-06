# 공유 레퍼런스

여러 에이전트가 함께 쓰는 어투·문체 룰북이다. 특정 에이전트 소유가 아니라서 `_shared/` 아래 둔다.
`_shared`에는 `AGENT.md`가 없으므로 `RoleAgentRegistry`가 에이전트로 로드하지 않는다
(`plugin/skills/_shared/`와 같은 규칙).

| 파일 | 무엇 | 주 참조자 |
|---|---|---|
| `author-voice.md` | 작성자 고유 어투 모델 (제안형, 물결, 이모지). "더하기" 레퍼런스 | `code-review-writer`, `code-review-responder`, `change-context-writer`, `humanize-monolith`, `/review`, `/review-reply` |
| `ai-tell-quick-rules.md` | AI-tell 탐지·처방 룰북 (A~J 카테고리, S1/S2). "빼기" 레퍼런스 | `humanize-monolith`(primary), `code-review-writer`, `code-review-responder`, `jira-writer`, `slack-messenger` |
| `style-guide.md` | 한국어 문장·용어·문서 구조 규칙 | `technical-writer`, `impact-writer`, `presentation-writer`, `presentation-designer`, `jira-writer` |

## 고칠 때

- **룰을 추가하면 그 문서가 스스로 그 룰을 지키는지 먼저 확인한다.** 룰 문서가 금지 어휘를
  본문에 쓰면 산출물로 샌다. 금지어를 넣었으면 같은 문서를 grep한다.
- 어투 규칙은 **S1으로 올려야 실제로 강제된다.** S2는 모델이 우선순위를 알아서 정하면서 새어나간다.
- 경로를 참조하는 자리가 여러 곳이다. 파일을 옮기거나 이름을 바꾸면 `plugin/` 전체에서
  상대경로 참조를 다시 확인한다 (에이전트는 `../_shared/references/`, 에이전트의 `references/`
  하위 문서는 `../../_shared/references/`, 스킬은 `../../role-agents/_shared/references/`).
