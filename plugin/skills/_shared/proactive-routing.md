# Role Agent 자동 라우팅 (공유 규칙)

이 표가 **기준 문서**다. 어느 상황에 어느 에이전트나 스킬을 사용자가 명시하지 않아도 proactively
쓸지는 여기서만 고친다. `CLAUDE.md`와 `plugin/skills/agent/SKILL.md`는 이 파일을 가리킬 뿐 표를
복제하지 않는다 — 복제본은 표가 늘어날 때 같이 안 고쳐져 조용히 갈라진다.

`/agent [이름] "태스크"` 또는 `ges_agent` MCP 도구로 호출한다.

| 상황 | 에이전트 |
|------|---------|
| 영상/비디오 URL이 포함되거나 "요약해줘" 요청 | `video-summarizer` |
| 번역투·AI 말투·어색한 한국어 교정 요청 | `humanize-monolith` (윤문 모드) |
| 고치지 말고 AI 티만 짚어달라는 요청 ("이거 AI 같아?", "슬롭인지 봐줘", "패턴만 짚어줘") | `humanize-monolith` (탐지 모드 — 원문 무수정, 패턴 인용만, 저자 판정·등급 금지) |
| README, API 문서, 가이드, 개발자 문서 작성 | `technical-writer` |
| 발표 슬라이드 콘텐츠·문구·데이터 요약·발표 노트 작성 | `presentation-writer` |
| 슬라이드 Reveal.js 구조·템플릿·비주얼 디자인 자문 | `presentation-designer` |
| 발표자료·슬라이드·프레젠테이션 제작 요청 ("발표자료 만들어줘", "슬라이드 만들어줘", "피치덱") | `presentation` 스킬 사용 (presentation-writer 콘텐츠 → 승인 단계 → presentation-designer 디자인 → Reveal.js HTML) |
| 시스템 설계, 아키텍처 리뷰, 설계 패턴 | `architect` |
| 보안 취약점, 인증/인가, 시크릿 노출 검토 | `security-reviewer` |
| 성능 병목, N+1, 메모리 누수 분석 | `performance-reviewer` |
| 코드 가독성, SOLID, 에러 처리 리뷰 | `quality-reviewer` |
| 테스트 케이스, 엣지 케이스, QA | `qa-engineer` |
| UX 문구 작성·교정, 버튼 텍스트, 에러 메시지, 토스트, 온보딩 카피 | `ux-writer` |
| 슬랙·메신저 메시지 작성 또는 딱딱한/AI스러운 초안을 본인 말투로 다듬기 | `slack-messenger` |
| 슬랙 메시지 전송·예약 발송 요청 ("~라고 보내줘", "공지해줘", "예약 발송해줘") | `slack-send` 스킬 사용 (내부적으로 slack-messenger 다듬기 → 승인 단계 → 전송) |
| 지라 티켓 본문 작성·구조화 (제목, 설명, 완료 조건, 이슈타입 추천) | `jira-writer` |
| 지라 티켓 생성 요청 ("티켓 만들어줘", "이슈 생성해줘", "지라에 올려줘") | `jira-create` 스킬 사용 (내부적으로 jira-writer 구조화 → 프로젝트·필드 확정 → 승인 단계 → createJiraIssue) |
| UI, React, 접근성, 컴포넌트 설계 | `frontend-developer` |
| UI·React 코드 리뷰, 접근성·번들 최적화 검토 | `frontend-reviewer` |
| 주석 검토 ("주석 좀 봐줘", 불필요한 주석·죽은 코드·티켓 없는 TODO 확인) | `comment-reviewer` |
| API, DB, 인증, 서버 로직 | `backend-developer` |
| CI/CD, 인프라, 모니터링 | `devops-engineer` |
| 요구사항 정리, 로드맵, 유저 스토리 | `product-planner` |
| 성과 분석·KPI 해석·분기 성과 보고·회고 리포트 | `impact-writer` |
| 제안서, RFC, 의사결정 메모 등 설득·합의용 기획 산문 | `impact-writer` |
| 성과 보고서·제안서·RFC·회고 작성 요청 ("성과 보고서 써줘", "제안서 작성", "RFC 써줘") | `brief` 스킬 사용 |
| 기술 분석, 벤치마크, 사례 조사 | `researcher` |
| 내 PR에 달린 리뷰 코멘트 답변 본문 작성 (반영·대안·보류·질문) | `code-review-responder` |
| PR·브랜치·커밋 코드 리뷰 요청 | `/review` 스킬 사용 |
| 받은 리뷰 반영·답글 게시 요청 ("리뷰 반영해줘", "리뷰 코멘트에 답해줘", "받은 리뷰 처리해줘") | `review-reply` 스킬 사용 (스레드 수집 → 유형 분류 승인 → 수정·커밋 → 답글 승인 → 게시) |
| PR 작성·생성 요청 ("PR 만들어줘", "PR 작성해줘", "PR 올려줘") | `gestalt:pr` 스킬 사용 |
| 실행 태스크를 외부 런타임 워커로 뿌리는 요청 ("orca로 실행", "codex로 실행", "워커 띄워서 실행") | `dispatch` 스킬 사용 (런타임 감지 → 같은 워크트리에 터미널 → worker_done 대기 → ready 재계산). 런타임 없으면 execute의 기본 병렬 경로 |

## 표를 늘릴 때

여기 한 줄 추가하면 끝이다. `CLAUDE.md`와 `agent/SKILL.md`를 따라가서 고칠 필요가 없다 — 둘 다
이 파일을 가리키기만 하기 때문이다.
