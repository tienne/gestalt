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

룰 ID와 심각도는 `ai-tell-quick-rules.md`가 기준이다. 고친 뒤에는 반드시 돌린다.

```bash
pnpm verify:rules
```

에이전트 문서 14곳이 룰 ID와 금지 어휘를 손으로 옮겨 적고 있어서 룰북에서 ID를 지우거나
심각도를 바꾸면 그 사본들이 조용히 어긋난다. 이 검사가 네 가지를 본다 — 없는 ID를 인용하는
문서, 자체검증 목록에서 빠진 S1, 표와 목록의 심각도 불일치, 룰 문서 본문의 금지어 사용.
`pnpm test`와 `pnpm build`에도 걸려 있다.

- **룰을 추가하면 그 문서가 스스로 그 룰을 지키는지 먼저 확인한다.** 룰 문서가 금지 어휘를
  본문에 쓰면 산출물로 샌다. 금지어를 넣었으면 같은 문서를 grep한다.
- 어투 규칙은 **S1으로 올려야 실제로 강제된다.** S2는 모델이 우선순위를 알아서 정하면서 새어나간다.
- 심각도를 바꿀 때는 근거를 남긴다. A-2, I-1, C-8은 대조 코퍼스 측정으로 조정했고 그 근거가
  룰북 §실측 근거에 있다. 감으로 올리고 내리면 다음 사람이 되돌린다.
- 경로를 참조하는 자리가 여러 곳이다. 파일을 옮기거나 이름을 바꾸면 `plugin/` 전체에서
  상대경로 참조를 다시 확인한다 (에이전트는 `../_shared/references/`, 에이전트의 `references/`
  하위 문서는 `../../_shared/references/`, 스킬은 `../../role-agents/_shared/references/`).
