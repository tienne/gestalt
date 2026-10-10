### 문서 레포 알아보기

아래 신호가 겹치면 문서 레포로 본다. 하나만 보이면 코드 레포에 딸린 `docs/`일 수 있으니 사용자에게 무엇을 그릴지 묻는다.

- 코드 파일보다 md 파일이 훨씬 많다.
- 본문에 `[evidence: …]`, `[GAP: …]`, `[UNVERIFIED: …]` 같은 표시가 있다.
- `INDEX.md`나 `KNOWLEDGE_INDEX.md` 같은 안내 문서가 있고 그 안에 키워드 열과 문서 링크로 된 질문 안내 표가 있다.
- `> 최종 수정: YYYY-MM-DD` 머리줄이나 front matter의 `updated`가 붙어 있다.

표시 형식이 기본과 다르면(`[근거: …]`처럼) 문서 몇 개를 열어 정규식을 정하고 `docPatterns`로 넘긴다. 바꿀 수 있는 필드는 `evidence`, `gap`, `unverified`, `updated`, `keywordHeader`, `routeHeader`, `screenNameHeader`다. 앞 넷은 정규식의 첫 캡처가 값이 되고 뒤 셋은 표의 열 이름에 맞추는 정규식이다.

### 순서

1. **`scan_docs`로 문서를 훑는다.** 문서 레포마다 `docRoots`에 하나씩 넣는다. 문서 레포에는 쓰지 않는다.

   ```json
   {
     "action": "scan_docs",
     "docRoots": [{ "repoId": "kb", "name": "acme-kb", "path": "../acme-kb", "exclude": ["archive/"] }]
   }
   ```

   응답 `summary`에서 문서 수와 구멍 수, `questionRoutes.orphans`(질문 길로 안 닿는 문서), `freshness.aged`(반년 넘게 안 고친 문서)를 본다. `docCount`가 0이거나 `evidenceMix`가 비었으면 표시 형식이 안 맞은 것이다. `docPatterns`를 고쳐 다시 돈다.

2. **기술 그림이 있으면 `link_docs`로 엮는다.** 기술 그림은 이 스킬로 먼저 render한 `<view>.json`이다. 없으면 이 단계를 건너뛰고 문서 지도만 그린다.

   ```json
   {
     "action": "link_docs",
     "irPath": ".gestalt/architecture/screen-chain.json",
     "codeRoots": { "acme-api": "../acme-api", "acme-web": "../acme-web" },
     "repoAliases": { "acme-api": "api" },
     "screenIndexPrefixes": ["kb/design/"]
   }
   ```

   - `codeRoots`는 문서가 적은 레포 이름을 체크아웃 경로로 바꾼다. 빼면 가리킨 파일을 확인 못 해 링크가 전부 unchecked가 된다. 로컬에 없는 레포는 [로컬 클론 받기](../SKILL.md#로컬-클론-받기)대로 받는다.
   - `repoAliases`는 문서의 레포 이름과 기술 IR의 repo id가 다를 때만 준다.
   - `screenIndexPrefixes`는 문서 레포에 디자인 화면 색인이 있을 때만 준다. 꼴은 `<repoId>/<경로 접두>`다.
   - 응답에서 `uncoveredCount`(문서 없는 기술 노드)와 `staleCount`(코드가 문서보다 늦게 바뀜), `apiMismatchCount`를 본다.

3. **render한다.** 기존 render 그대로이고 초안 경로를 `irPath`로 준다. 문서 지도는 `knowledge.draft.json`, 기술 그림에 엮은 것은 `knowledge-link.draft.json`이다. 둘 다 그리려면 두 번 부른다.

4. **보고한다.** Step 8의 세 덩어리 대신 아래를 적는다.
   - 문서 수, 열린 구멍 수, 고립 문서 수, 오래된 문서 수
   - `link_docs`를 돌렸으면 문서 없는 기술 노드 수와 낡은 문서 수, 담당별 열린 구멍(`gapsByOwner`)
   - 막다른 안내(`deadRoutes`)와 키워드 충돌(`keywordConflicts`)이 있으면 그 수와 `doc-routes.json` 경로
   - 다른 사람에게 넘길 때는 `.shared.html`만 넘긴다. 절 제목과 구멍 설명, 안내 키워드, 담당이 빠진다.

### 바뀐 코드로 손볼 문서 찾기

코드 PR이나 브랜치가 어느 문서를 낡게 만드는지 알고 싶을 때 `stale_docs`를 부른다. `scan_docs`를 먼저 돌려 둬야 한다. `link_docs`까지 돌려 뒀으면 문서가 설명하는 기술 노드의 파일이 바뀐 경우도 잡는다.

```json
{
  "action": "stale_docs",
  "diffBase": "origin/main",
  "changedRepo": "acme-api",
  "codeRoots": { "acme-api": "../acme-api" }
}
```

바뀐 파일 목록이 이미 있으면 `diffBase` 대신 `changedFiles`에 `["acme-api:src/orders/service.ts"]`처럼 넘긴다. 응답의 `sample`을 문서마다 걸린 파일과 함께 보여주고 전체 목록은 `stale-docs.json` 경로로 알린다. `linkedIr`가 `false`면 문서가 직접 가리킨 파일만 본 결과라고 덧붙인다.

---
