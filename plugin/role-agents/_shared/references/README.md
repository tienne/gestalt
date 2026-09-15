# 공유 레퍼런스

여러 에이전트가 함께 쓰는 어투, 문체, 코드 주석 룰북이다. 특정 에이전트 소유가 아니라서 `_shared/` 아래 둔다.
`_shared`에는 `AGENT.md`가 없으므로 `RoleAgentRegistry`가 에이전트로 로드하지 않는다
(`plugin/skills/_shared/`와 같은 규칙).

| 파일 | 무엇 | 주 참조자 |
|---|---|---|
| `author-voice.md` | 작성자 고유 어투 모델 (제안형, 물결, 이모지). "더하기" 레퍼런스 | `code-review-writer`, `code-review-responder`, `change-context-writer`, `humanize-monolith`, `/review`, `/review-reply` |
| `ai-tell-quick-rules.md` | AI-tell 탐지·처방 룰북 (A~J 카테고리, S1/S2). "빼기" 레퍼런스 | `humanize-monolith`(primary), `code-review-writer`, `code-review-responder`, `jira-writer`, `slack-messenger` |
| `style-guide.md` | 한국어 문장·용어·문서 구조 규칙 | `technical-writer`, `impact-writer`, `presentation-writer`, `presentation-designer`, `jira-writer` |
| `comment-rules.md` | 코드 주석 위생 룰북 (`CM-` ID, 리뷰 파이프라인 심각도). 어투가 아니라 코드 품질 쪽 | `quality-reviewer` |
| `truncation-rules.md` | 잘린 결과 룰북 (`TR-` ID, 리뷰 파이프라인 심각도). 일부만 가져와놓고 전부인 것처럼 돌려주는 코드 | `quality-reviewer` |

## 고칠 때

어투 룰의 ID와 심각도는 `ai-tell-quick-rules.md`가 기준이다. 코드 룰은 `comment-rules.md`(`CM-`)와
`truncation-rules.md`(`TR-`)가 각각 따로 기준이다. 세 문서의 ID를 섞지 않는다 — 층위가 다르고
아래 검사도 어투 룰만 정합 대상으로 본다. 고친 뒤에는 반드시 돌린다.

```bash
pnpm verify:rules
pnpm verify:output-style
pnpm build:output-style
```

에이전트 문서 14곳이 룰 ID와 금지 어휘를 손으로 옮겨 적고 있어서 룰북에서 ID를 지우거나
심각도를 바꾸면 그 사본들이 조용히 어긋난다. 이 검사가 네 가지를 본다 — 없는 ID를 인용하는
문서, 자체검증 목록에서 빠진 S1, 표와 목록의 심각도 불일치, 룰 문서 본문의 금지어 사용.
`pnpm test`와 `pnpm build`에도 걸려 있다.

**둘째 줄은 output style 생성기가 보는 것이다.** 두 가지를 본다 — 금지 목록과 자가점검이
인용한 룰 ID가 룰북에 살아있고 대화 기준 S1인지, 그리고 `scripts/build-output-style.ts`의
`HOIST`가 조각 문자열로 가리키는 처방 문장이 그대로인지. `verify:rules`는 둘 다 모른다.
지금 `HOIST`에 걸린 건 F-9 한 자리다. 이것도 `pnpm test`와 `pnpm build`(postbuild)에
걸려 있다. `pnpm gate`를 돌리면 따로 부를 일이 없다.

**셋째 줄은 홈의 산출 파일을 다시 뽑는다.** 룰 문구나 심각도를 고쳐도
`~/.claude/output-styles/tienne-voice.md`는 저절로 안 바뀐다. 위 둘은 그 파일을 안 보므로
이걸 안 돌리면 룰북과 실제로 켜져 있는 어투 지시가 갈라진 채로 남는다.

- **룰을 추가하면 그 문서가 스스로 그 룰을 지키는지 먼저 확인한다.** 룰 문서가 금지 어휘를
  본문에 쓰면 산출물로 샌다. 금지어를 넣었으면 같은 문서를 grep한다.
- 어투 규칙은 **S1으로 올려야 실제로 강제된다.** S2는 모델이 우선순위를 알아서 정하면서 빠져나간다.
- 심각도를 바꿀 때는 근거를 남긴다. A-2, I-1, C-8은 대조 코퍼스 측정으로 조정했고 그 근거가
  [룰북 측정 근거](ai-tell-quick-rules.md#측정-근거)에 있다. 감으로 올리고 내리면 다음 사람이 되돌린다.
- 경로를 참조하는 자리가 여러 곳이다. 파일을 옮기거나 이름을 바꾸면 `plugin/` 전체에서
  상대경로 참조를 다시 확인한다 (에이전트는 `../_shared/references/`, 에이전트의 `references/`
  하위 문서는 `../../_shared/references/`, 스킬은 `../../role-agents/_shared/references/`).
