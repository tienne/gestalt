---
name: presentation
version: "1.0.0"
description: "발표 자료를 콘텐츠와 디자인으로 나눠 만드는 스킬. presentation-writer가 슬라이드 콘텐츠를 쓰고 presentation-designer가 Reveal.js HTML로 조립하며, 승인 단계를 거쳐 산출한다. '발표자료 만들어줘', '슬라이드 만들어줘', '프레젠테이션 제작', '덱 만들어줘', '피치덱' 요청에 반드시 사용. 콘텐츠 자문만 필요하면 presentation-writer, 디자인 자문만 필요하면 presentation-designer를 직접 호출."
triggers:
  - "발표자료 만들"
  - "발표 자료 만들"
  - "슬라이드 만들"
  - "프레젠테이션 만들"
  - "프레젠테이션 제작"
  - "덱 만들"
  - "피치덱"
  - "피치 덱"
  - "발표 슬라이드"
  - "슬라이드 제작"
  - "reveal 슬라이드"
inputs:
  topic:
    type: string
    required: false
    description: "발표 주제. 없으면 미니 인터뷰로 확정한다."
  audience:
    type: string
    required: false
    description: "청중: exec(경영진) | team(팀 내부) | customer(고객·투자자) | public(외부 발표). 톤과 무드 템플릿을 좌우한다."
  slideCount:
    type: number
    required: false
    description: "목표 슬라이드 수. 없으면 발표 시간 기준(1분/슬라이드)으로 제안한다."
outputs:
  - presentation_html_path
---

# Presentation Skill

> **에이전트 tier로 모델 고르기** → [`../_shared/agent-model.md`](../_shared/agent-model.md)
발표 자료를 **콘텐츠 먼저, 디자인 나중** 순서로 만드는 파이프라인.
`presentation-writer`(슬라이드 콘텐츠)와 `presentation-designer`(Reveal.js HTML)를 잇고 산출 전 승인 단계를 둔다.

> **불변 규칙: 승인 없이는 최종 HTML을 산출하지 않는다.** 콘텐츠 개요를 미리보기로 보여주고 사용자의 명시적 "OK"를 받은 뒤에만 디자인, HTML 생성으로 넘어간다. 디자인에 워딩을 끼워 맞추는 실수, 방향이 어긋난 발표를 통째로 다시 그리는 낭비를 막는 게 이 단계의 이유다.

## 파이프라인

### 1. 미니 인터뷰 — 주제, 청중, 분량 확정 (추측 금지)

세 가지를 확정한다. 빠진 게 있으면 되묻고 지어내지 않는다.

- **주제**: 이 발표로 이루려는 것 한 문장. 모호하면 "무엇을 결정·설득·공유하려는 발표인가"를 묻는다.
- **청중**: exec / team / customer / public. 청중이 무드 템플릿과 톤을 좌우하므로 반드시 확인한다.
- **분량**: 목표 슬라이드 수 또는 발표 시간. 시간만 있으면 1분/슬라이드로 환산해 제안한다.

발표에 들어갈 수치, 데이터가 있으면 이 단계에서 받는다. 없으면 콘텐츠 단계에서 `[데이터 필요]`로 남긴다.

### 2. 콘텐츠 초안 (presentation-writer)

`ges_agent { action: "get", name: "presentation-writer" }`로 에이전트 시스템 프롬프트를 가져와 적용한다. 슬라이드 유형별 구조는 `role-agents/presentation-writer/references/content-playbook.md`를 따른다.

산출은 슬라이드 번호별 콘텐츠 블록(제목 / 핵심 메시지 / 본문 포인트 / 데이터+맥락 / 발표 노트 / 제안 슬라이드 성격). 수치가 없으면 지어내지 않고 `[데이터 필요: ...]`로 남겨 작성자에게 요청한다.

### 3. 승인 단계 (필수)

콘텐츠 개요를 한 화면에 모아 보여주고 명시적 승인을 받는다.

```
[발표 개요]
목적:   <한 문장>
청중:   <exec / team / customer / public>
분량:   <N>장 (약 <N>분)
핵심 메시지: <전체를 관통하는 한 문장>

[슬라이드 개요]
1. <제목> — <핵심 메시지>
2. <제목> — <핵심 메시지>
...

이 내용으로 디자인이랑 HTML을 만들까요? (수정할 곳 있으면 말씀해주세요)
```

- 사용자가 "OK/좋아/만들어" 등 **명시 승인**하기 전엔 4단계로 넘어가지 않는다.
- 수정 요청이 오면 2단계로 돌아가 콘텐츠를 고치고 다시 확인한다.
- 승인 문구가 모호하면("음..", "글쎄") 진행하지 말고 재확인한다.

### 4. 디자인 조립 (presentation-designer)

승인 후에만 진행한다. `ges_agent { action: "get", name: "presentation-designer" }`로 에이전트를 가져와 적용한다.

1. **무드 템플릿 선택** — 청중, 목적에 맞는 템플릿을 `role-agents/presentation-designer/templates/`에서 고른다. exec, 투자자는 권위/신뢰 계열(Signal, Broadside), 제품 런치, 키노트는 크리에이티브 계열(Neo-Grid, Studio) 등 무드 가이드를 따른다.
2. **슬라이드 타입 매핑** — writer의 "제안 슬라이드 성격"을 designer 슬라이드 타입(stats/statement/compare/process/quote)에 배정한다.
3. **카피 압축** — 콘텐츠 문장을 슬라이드 공간에 맞게 의미 손실 없이 압축한다.
4. **HTML 생성** — 선택한 템플릿 기반 Reveal.js HTML을 생성한다.

### 5. 산출 — HTML 경로 반환

완성한 Reveal.js HTML을 파일로 저장하고 절대 경로를 반환한다. 브라우저로 열어 확인하는 법과, PDF가 필요하면 decktape 명령(`npx decktape reveal "file:///<abs>/slide.html" out.pdf --size 1600x900`)을 안내한다.

### 6. 완료 보고

산출 경로, 슬라이드 수, 사용한 템플릿을 사용자에게 돌려준다. 수정 요청이 오면 콘텐츠 변경이면 2단계, 디자인 변경이면 4단계로 돌아간다.

## Do-NOT

- **승인 전 HTML 산출 금지.** 콘텐츠 개요 미리보기와 명시 승인을 건너뛰지 않는다.
- **주제, 청중 불명확 시 진행 금지.** 미니 인터뷰로 확정되지 않으면 콘텐츠 작성으로 넘어가지 않는다.
- 사용자가 주지 않은 수치, 인용, 출처를 지어내지 않는다(`[데이터 필요]`로 남기고 확인).
- **콘텐츠와 디자인 역할을 섞지 않는다.** writer 단계에서 템플릿, 색상을 정하지 않고 designer 단계에서 새 메시지를 지어내지 않는다.
- 슬라이드 한글 텍스트에서 가운뎃점(·)으로 항목을 압축하지 않는다(짧은 불릿 라벨은 예외).

## 에러 처리

| 상황 | 대응 |
|------|------|
| 주제·청중 불명확 | 미니 인터뷰로 되묻고, 확정 전 진행 보류 |
| 필요한 수치 없음 | `[데이터 필요]`로 표시하고 작성자에게 요청, 지어내지 않음 |
| 승인 응답 모호 | 산출 보류, 명시 승인 재요청 |
| 슬라이드 수 과다(발표 시간 대비) | 1분/슬라이드 기준으로 재조정 제안 |
| 디자인만/콘텐츠만 필요 | 파이프라인 대신 presentation-designer / presentation-writer 직접 호출 안내 |

## 테스트 시나리오

**정상 흐름**: `/presentation "3분기 성과 발표" audience=exec` → 주제, 청중, 분량 확정 → presentation-writer 콘텐츠 블록 → 콘텐츠 개요 미리보기 → 사용자 "OK" → presentation-designer가 Signal 템플릿으로 HTML 생성 → 경로 반환.

**입력 부족 흐름**: `/presentation` 만 입력 → 주제, 청중, 분량을 미니 인터뷰로 확정 → 수치가 없는 슬라이드는 `[데이터 필요]`로 남기고 요청 → 콘텐츠 확정 후 승인 단계.

**승인 단계 흐름**: 콘텐츠 개요 제시 후 사용자가 "3번 슬라이드 메시지 바꿔줘" → 2단계로 돌아가 콘텐츠 수정 → 재확인 → 승인 후에만 HTML 생성.
