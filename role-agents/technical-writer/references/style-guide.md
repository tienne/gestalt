# Technical Writer Style Guide

## Korean Documentation Style

### Tone
- Use friendly informal register: "~이에요", "~해요", "~하세요" — not "~입니다", "~합니다"
- Address the reader directly: drop the subject where possible, or use "이 가이드에서는"
- Avoid "여러분" — prefer implicit subject
- Prefer "~기 전에" over "~기 전," (comma cut) for smoother sentence flow

### Header Structure
- Concept sections: Q&A form — "~은 무엇인가요?", "~을 사용하면 어떤 점이 좋나요?"
- Task sections: Action-oriented — "시작하기", "개발하기", "설치하는 방법"
- Organize in progressive disclosure order: 이해하기 → 시작하기 → 개발하기 → QA

### Formatting
- Bold key terms on first use: **소모성 아이템**
- Bullet: features, options, constraints
- Numbered: sequence-dependent steps
- Callout types by consequence:
  - 💡 Tip: optional improvement
  - 📝 Note: extra context, policy notes
  - ⚠️ Warning: incorrect usage causes problems
  - 🔴 Danger: data loss, security risk — never use Note for this
- Descriptive link text — Don't: `[여기](url)` / Do: `[설치 가이드](url)`

### Content Principles
- Lead with business value, follow with technical detail
- Real-world examples before abstract definitions
- Split platform-specific content: iOS / Android / React Native
- Include "이런 경우에 사용해요" for components and APIs
- Problem sections: describe reader's situation as a statement, not a question

### Korean Sentence Rules
- **한국어로 직접 작성. 영어로 생각하고 번역하지 말 것.**
- 한 문장 한 아이디어 — "~하고", "~하며" 복합문 분리
- 능동 구조 — Don't: "설정이 완료되어야 합니다" / Do: "설정을 완료하세요"
- 메타 전환어 제거 — "앞서 설명했듯이", "결론적으로" 삭제
- 한자어 동사 제거 — 수행하다, 진행하다, 실시하다 → 직접 동사
- 번역체 금지 — "API 키를 이용한 사용자 인증 처리가 완료된 후" → "API 키로 인증한 후"
- 용어 일관성 — 같은 개념에 다른 단어 혼용 금지
- 약어: 첫 등장 시 `SSR(Server-Side Rendering)` 형식
- 가운뎃점(·) 절제 — 본문에서 "A·B·C" 압축 나열 대신 쉼표나 "A랑 B하고 C"로 푼다. 사람은 산문에서 가운뎃점을 거의 안 쓴다 (표·용어 목록은 예외). 자세히는 `ai-tell-quick-rules.md` C-12

### Technical Term Handling

| 단계 | 기준 | 예시 |
|------|------|------|
| 영어 그대로 | 한국 개발자가 영어로 통용 | API, CLI, JSON, Git, PR, LLM |
| 한국어 + 영어 병기 | 첫 등장 전문 용어 | 이벤트 소싱(Event Sourcing) |
| 한국어만 | 자연스러운 표현 존재 | 버전 관리 (버저닝 ❌), 배포 (디플로이먼트 ❌) |

---

## English Documentation Style

Follow Stripe/Vercel conventions:
- Declarative, instructional tone — "Run the command", not "You should run the command"
- Lead with the outcome, not the process
- Use second person ("you") consistently
- One idea per sentence
- Code examples inline with narrative, not appended

---

## Document Types

Choose based on what the reader needs to do:

| Type | Reader's goal | Korean examples | Opens with | Explanation depth |
|------|---------------|-----------------|------------|-------------------|
| **Learning** | Understand end-to-end | 시작하기, 튜토리얼 | Goal statement — "이 가이드를 마치면 X를 할 수 있어요." | Define all new concepts |
| **Problem-Solving** | Fix a specific issue | 트러블슈팅, How-to | Problem statement — error, symptom, failure | Domain knowledge assumed |
| **Reference** | Look up exact specs | API 레퍼런스, Props | Declarative definition — "X는 Y다" | Let the table speak |
| **Explanation** | Deeply understand a concept | 아키텍처 개요 | Why it exists — the problem it solved | Rich context, diagrams |

- 시작하기 vs 튜토리얼: 시작하기 = 주요 흐름 + 간단한 설치 / 튜토리얼 = 결과물이 있는 단계별 실습
- 가이드 vs 트러블슈팅: 가이드 = 기능 구현 절차 / 트러블슈팅 = 이미 발생한 문제 진단

### Document Structures

**API Reference**
- Method signature → description → parameter table (name/type/required/default/description) → response schema → error codes

**Component Documentation**
- 이름 + 한 줄 설명 → 이런 경우에 사용해요 → 이런 경우엔 사용하지 마세요 → Props table → 코드 예시 → Variants

**README / Getting Started**
- What this is (1 paragraph) → Prerequisites → Installation → Minimal working example → Link to full docs

**Developer Guide / Tutorial**
- Goal statement → Step-by-step numbered sections → Expected output at each step → Troubleshooting

**Problem-Solving**
- Clear problem definition (cause vs symptom, error message) → Immediate solution → Underlying principle → Environment differences

**Explanation (Concept / Architecture)**
- Why it exists → Background → Mechanics → Diagrams → Prerequisites

---

## Information Architecture

- **One topic per page** — H4 depth = signal to split
- **Value first** — Don't: "이 기능은 2019년에 도입됐고…" / Do: "이 설정으로 네트워크 지연을 줄일 수 있어요."
- **Heading rules**: 30자 이내, 섹션 목적에 맞는 형식, 형제 헤딩 문법 일관성
- **Overview placement** — 페이지 제목 바로 아래, 섹션 전에
- **Predictable structure** — description → code (코드 먼저 금지), 기본 → 심화

---

## Collaboration — presentation-designer

프레젠테이션 요청 시 technical-writer가 Phase 1 (워딩 초안) 담당.

**슬라이드 카피 원칙**
- 제목: 명사형 ❌ → 주장·결론형 ✅
  - "Q2 성과" → "Q2에서 증명한 것"
  - "번들 최적화" → "번들을 32% 줄인 세 가지 결정"
- 수치: 단독 ❌ → 반드시 기준값과 함께 ✅
  - "98%" → "목표 90% 대비 98% — 8%p 초과 달성"
- 밀도: 슬라이드당 핵심 포인트 1개, 불릿 3개 초과 시 분리, 20초 이내

**워딩 초안 출력 형식**
```
[슬라이드 N] {슬라이드 타입: cover/stats/split/statement/...}
제목: "제목 텍스트"
핵심 포인트:
  - 포인트 1 (수치 있으면 맥락 포함)
  - 포인트 2
발표자 노트: 청중에게 강조할 말, 슬라이드에 없는 맥락
```
