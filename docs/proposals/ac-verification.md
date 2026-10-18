# AC에 검증 방법 달기 (Spec 단계)

## 배경

### 현재 동작

수용 기준(AC)은 지금 문자열 배열이다. 도메인 타입은 `acceptanceCriteria: string[]`(src/core/types.ts:99)이고 Zod 스키마도 `z.array(z.string())`(src/spec/schema.ts:48)이다. 그래서 AC마다 "무엇으로 확인하는가"를 적을 자리가 없다. 평가 단계는 AC 문장과 태스크 출력만 보고 LLM이 충족 여부를 판정한다(src/execute/prompts.ts:401-458).

스펙을 만드는 경로는 세 개다.

- Passthrough 인터뷰 경로는 호스트가 만든 JSON을 `validateAndStore`가 받는다(src/spec/passthrough-generator.ts:76-147). 입력 타입은 `ExternalSpec.acceptanceCriteria: string[]`이다(src/spec/passthrough-generator.ts:28).
- Passthrough 텍스트 경로는 `validateAndStoreFromText`다(src/spec/passthrough-generator.ts:149-193).
- 일반 모드는 `SpecExtractor`가 LLM 응답을 파싱한다. 이때 `asStringArray`가 문자열이 아닌 항목을 조용히 버린다(src/spec/extractor.ts:53, src/spec/extractor.ts:68-71). AC를 객체로 바꾸면 이 경로에서는 AC가 전부 사라진다.

두 생성기는 스키마 검증을 하지만 검증 결과(`validation.data`)가 아니라 검증 전 객체를 그대로 돌려준다(src/spec/passthrough-generator.ts:109-112, src/spec/passthrough-generator.ts:139, src/spec/generator.ts:62-88). 그래서 지금은 스키마에 transform을 걸어도 결과에 반영되지 않는다. `specMetadataSchema`의 transform(src/spec/schema.ts:37-43)도 같은 이유로 결과에 안 실린다.

서버는 스펙을 파일로 저장하지 않는다. 생성 응답으로 `spec`을 돌려주면 끝이다(src/mcp/tools/spec-passthrough.ts:122-130). 그 뒤로는 호스트가 JSON을 들고 있다가 `ges_execute start`에 다시 넘긴다(src/mcp/tools/execute/planning.ts:16-18). 서버가 스펙을 영속하는 곳은 execute 이벤트 원장 하나다. `EXECUTE_SESSION_STARTED` 페이로드에 스펙 전체가 들어가고(src/execute/session.ts:135-141), `EVOLVE_SPEC_PATCHED` 페이로드에 패치된 스펙이 들어간다(src/execute/session.ts:434-439). 재구성할 때는 이 페이로드를 Zod 없이 `as Spec`으로 캐스팅해 읽는다(src/execute/repository.ts:93-103, src/execute/repository.ts:343-361).

MCP 입력 스키마 네 곳이 AC를 문자열 배열로 받는다.

| 자리                                       | 근거                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `ges_generate_spec`의 `spec` (스키마 정의) | src/mcp/schemas.ts:96                          |
| `ges_generate_spec`의 `spec` (서버 등록부) | src/mcp/server.ts:208                          |
| `ges_execute`의 `spec`                     | src/mcp/schemas.ts:183                         |
| `specPatch`와 `lateralResult.specPatch`    | src/mcp/schemas.ts:344, src/mcp/schemas.ts:430 |

### AC를 인덱스로 가리키는 자리

실행 단계는 AC를 배열 위치로 가리킨다.

- `ClassifiedAC.acIndex`와 `acText`(src/core/types.ts:140-146), `AtomicTask.sourceAC: number[]`(src/core/types.ts:154), `ACVerification.acIndex`(src/core/types.ts:307-312)가 있다. 감사 결과의 `implementedACs`, `partialACs`, `missingACs`도 숫자 배열이다(src/core/types.ts:443-445).
- 계획 검증은 0부터 n-1까지 빠짐없이 분류됐는지 본다(src/execute/orchestrators/planning.ts:281-296). `sourceAC`가 분류 단계의 인덱스 안에 드는지도 본다(src/execute/orchestrators/planning.ts:320-333).
- 평가 검증도 현재 스펙 길이 기준으로 0부터 n-1까지 다 검증됐는지 본다(src/execute/orchestrators/evaluation.ts:179-185).

### evolve에서 인덱스가 어긋나는 문제

evolve 패치는 AC 목록 전체를 갈아끼운다. 프롬프트는 "FULL list"를 내라고 시키고(src/execute/prompts.ts:627, src/resilience/prompts.ts:158), 적용기는 배열을 통째로 대입한다(src/execute/spec-patch-applier.ts:19-22). 검증기는 빈 배열만 막는다(src/execute/spec-patch-validator.ts:33-41). 패치가 끝나도 실행 계획의 `classifiedACs`와 `sourceAC`는 다시 계산하지 않는다(src/execute/orchestrators/evolution.ts:223-283).

그래서 지금도 두 가지가 어긋난다.

1. 맥락 평가 프롬프트는 계획 시점의 `plan.classifiedACs`로 AC 목록을 만든다(src/execute/orchestrators/evaluation.ts:245-249, src/execute/prompts.ts:407-409). 그런데 검증 커버리지는 패치된 현재 스펙의 길이로 잰다(src/execute/orchestrators/evaluation.ts:179). evolve에서 AC를 추가하면 평가 프롬프트에는 새 AC가 안 보이는데 서버는 그 인덱스까지 검증하라고 요구한다.
2. 가운데 AC를 지우면 뒤쪽 인덱스가 한 칸씩 당겨진다. `classifiedACs[2].acText`와 `spec.acceptanceCriteria[2]`가 서로 다른 문장을 가리키게 된다. evolve 프롬프트도 `spec.acceptanceCriteria[v.acIndex]`로 문장을 찾는다(src/execute/prompts.ts:581, src/resilience/prompts.ts:86, src/resilience/prompts.ts:92). 이 경우 옛 평가 결과의 인덱스가 엉뚱한 AC에 붙는다.

영향 태스크 식별은 이 문제를 피하려고 AC가 조금이라도 바뀌면 `sourceAC`가 있는 태스크를 전부 재실행한다(src/execute/impact-identifier.ts:27-35).

### 문자열 보간을 쓰는 자리

AC를 템플릿 리터럴에 바로 넣는 자리가 여럿이다. 객체로 바꿔도 타입 검사가 잡지 못하고 프롬프트에 `[object Object]`가 찍힌다. 린트도 타입 정보 없이 `tseslint.configs.recommended`만 쓰므로(eslint.config.js:19-21) `restrict-template-expressions`가 꺼져 있다.

| 자리                                     | 근거                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Figure-Ground 프롬프트                   | src/execute/prompts.ts:63                                                                 |
| evolve 프롬프트 (미충족 AC, 현재 AC)     | src/execute/prompts.ts:581, src/execute/prompts.ts:601                                    |
| lateral 프롬프트 (미충족, 충족, 현재 AC) | src/resilience/prompts.ts:86, src/resilience/prompts.ts:92, src/resilience/prompts.ts:125 |
| 감사 프롬프트                            | src/execute/audit-engine.ts:19                                                            |
| 템플릿 렌더                              | src/spec/templates.ts:106                                                                 |
| 패치 유사도 직렬화                       | src/execute/spec-patch-applier.ts:86 (JSON이라 깨지지는 않지만 토큰 구성이 바뀐다)        |

## 설계

### 타입

공유 계약은 그대로 둔다.

```ts
// src/core/types.ts
export type AcVerifyBy = 'test' | 'command' | 'manual';

export interface AcceptanceCriterion {
  id: string; // "AC-1". 패치를 거쳐도 유지된다
  criterion: string;
  verifyBy: AcVerifyBy;
  check?: string; // test: 테스트 파일과 이름 패턴, command: 셸 명령, manual: 없음
}

export interface Spec {
  // ...
  acceptanceCriteria: AcceptanceCriterion[];
}
```

계약은 바꾸지 않고 두 가지만 덧붙인다. 둘 다 계약 위에 얹는 것이고 저장 형태는 위와 같다.

1. **입력 전용 타입을 따로 둔다.** 호스트나 LLM이 보내는 값은 `id`와 `verifyBy`가 빠져 있을 수 있고 옛 문자열일 수도 있다.

   ```ts
   export type AcceptanceCriterionInput =
     | string
     | { id?: string; criterion: string; verifyBy?: AcVerifyBy; check?: string };
   ```

2. **`check` 필수 여부는 타입이 아니라 검증 규칙으로 강제한다.** 타입에서는 `check?`가 선택으로 남는다. 다만 `verifyBy`가 `test`나 `command`인데 `check`가 없으면 생성 시점 검증에서 거절한다(아래 검증 규칙 참고).

`SpecTemplate.baseAcceptanceCriteria`(src/core/types.ts:712)는 `Omit<AcceptanceCriterion, 'id'>[]`로 바꾼다. `SpecPatch.acceptanceCriteria`(src/core/types.ts:394)는 `AcceptanceCriterionInput[]`로 바꾼다.

### 정규화 모듈

`src/spec/acceptance-criteria.ts`를 새로 만들고 AC를 다루는 로직을 여기에 모은다.

```ts
export const AC_ID_PATTERN = /^AC-[1-9]\d*$/;

export const acceptanceCriterionInputSchema: z.ZodType<AcceptanceCriterionInput>;
// 생성과 start에 쓴다. 문자열을 정규화하고 규칙 위반은 거절한다
export const acceptanceCriteriaSchema: z.ZodType<AcceptanceCriterion[], z.ZodTypeDef, unknown[]>;

/** 옛 string[]이나 섞인 배열을 AcceptanceCriterion[]로. 재구성(replay) 경로용이라 던지지 않는다 */
export function normalizeAcceptanceCriteria(raw: unknown): AcceptanceCriterion[];

/** Spec 전체를 받아 AC만 정규화한 사본을 돌려준다. repository fold가 쓴다 */
export function normalizeSpec(
  spec: Spec | (Omit<Spec, 'acceptanceCriteria'> & { acceptanceCriteria: unknown }),
): Spec;

/** 프롬프트 한 줄. 모든 프롬프트가 이 함수 하나만 쓴다 */
export function formatAcLine(ac: AcceptanceCriterion, index: number): string;
// "  [0] AC-1 (test: tests/auth.test.ts > rejects expired token) 만료 토큰은 401을 반환한다"
// "  [2] AC-3 (manual) 에러 문구가 사용자 친화적이다"

/** evolve 패치 머지. 아래 "패치와 안정 id" 절 */
export function mergeCriteriaPatch(
  current: AcceptanceCriterion[],
  entries: AcceptanceCriterionInput[],
  idFloor: number,
): { next: AcceptanceCriterion[]; changes: AcChanges };

export function maxAcIdNumber(specs: Spec[]): number;
```

옛 데이터는 이렇게 바꾼다. 문자열 `s`가 i번째에 있으면 `{ id: 'AC-${i+1}', criterion: s, verifyBy: 'manual' }`이 된다. 객체인데 `id`가 없으면 그 배열에서 이미 쓰인 가장 큰 번호 다음 번호를 순서대로 붙인다. 객체인데 `verifyBy`가 없으면 `manual`로 둔다. 다만 생성 경로에서 이렇게 기본값이 들어간 항목은 응답의 `warnings`에 남긴다.

### 생성 시점 검증 규칙

`acceptanceCriteriaSchema`의 `superRefine`이 다음을 검사한다. 위반하면 기존과 같은 `Spec validation failed: ...` 오류로 돌려준다(src/spec/passthrough-generator.ts:110-111). 호스트는 이미 이 오류를 보고 다시 제출하는 흐름을 탄다.

| 규칙                                               | 처리                                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| `criterion`이 공백을 뺐을 때 비었다                | 거절                                                    |
| `id`가 있는데 `AC_ID_PATTERN`과 맞지 않는다        | 거절                                                    |
| `id`가 배열 안에서 겹친다                          | 거절                                                    |
| `verifyBy`가 `command`인데 `check`가 없거나 비었다 | 거절                                                    |
| `verifyBy`가 `test`인데 `check`가 없거나 비었다    | 거절                                                    |
| `check`에 줄바꿈이 있거나 500자를 넘는다           | 거절                                                    |
| `verifyBy`가 `manual`인데 `check`가 있다           | `check`를 지우고 `warnings`에 남긴다                    |
| `verifyBy`가 빠졌다                                | `manual`로 채우고 `warnings`에 남긴다                   |
| AC 배열이 비었다                                   | 거절 (지금은 빈 배열도 통과한다, src/spec/schema.ts:48) |

서버는 생성 시점에 테스트가 실제로 있는지 찾지 않고 명령도 돌리지 않는다. 이유는 셋이다.

1. greenfield 스펙에서는 테스트 파일이 아직 없다. `test`의 `check`는 "이 이름으로 테스트가 생긴다"는 약속이다. 실행 단계가 그 테스트를 쓰는 태스크를 만든다.
2. MCP 서버에는 스펙을 받을 때 작업 디렉토리 정보가 없다. `ges_generate_spec` 입력에 cwd가 없다(src/mcp/server.ts:189-213).
3. 스펙을 받는 즉시 서버가 셸 명령을 돌리면 텍스트 입력(Jira, GitHub 이슈, src/core/types.ts:717)에 심긴 명령이 사람 확인 없이 실행된다.

실제 실행과 존재 확인은 평가 단계의 몫이다. 이 문서는 데이터를 실어 나르는 데까지만 다룬다.

`test` 타입의 `check` 형식은 자유 문자열로 두고 권장 꼴만 프롬프트에 적는다. 권장 꼴은 `<파일 경로> > <테스트 이름 또는 패턴>`이다. 러너마다 필터 문법이 달라서 서버가 이 형식을 강제하면 vitest가 아닌 프로젝트에서 막힌다.

### 생성기 흐름

1. `PassthroughSpecGenerator.validateAndStore`와 `validateAndStoreFromText`는 `ExternalSpec.acceptanceCriteria`를 `AcceptanceCriterionInput[]`로 받는다. `specSchema.safeParse`를 통과하면 **`validation.data`로 만든 스펙**을 돌려준다. 지금은 `spec`을 돌려준다(src/spec/passthrough-generator.ts:139, src/spec/passthrough-generator.ts:185). 반환값을 `{ spec, warnings }`로 넓혀 핸들러가 응답에 싣게 한다.
2. `SpecGenerator`도 같은 식으로 `validation.data`를 쓴다(src/spec/generator.ts:62-88).
3. `SpecExtractor`의 `asStringArray`(src/spec/extractor.ts:53)를 `parseAcceptanceCriteriaLenient`로 바꾼다. 이 함수는 문자열과 객체를 둘 다 받는다. 규칙 검증은 그 뒤의 `specSchema`가 맡는다. 위반이 나면 기존 재시도 루프(src/spec/generator.ts:42-67)가 다시 돈다.
4. `SPEC_GENERATED` 이벤트(src/spec/passthrough-generator.ts:124-130)에 `acVerifyBy: { test, command, manual }` 집계를 덧붙인다. 해상도 효과를 증명하는 벤치마크에서 검증 가능한 AC 비율을 지표로 쓸 수 있다.

### MCP 요청과 응답 변경

**`ges_generate_spec` 2단계 요청.** 옛 문자열도 계속 받는다.

```json
{
  "sessionId": "<id>",
  "spec": {
    "goal": "...",
    "constraints": ["..."],
    "acceptanceCriteria": [
      {
        "criterion": "만료된 JWT로 보호 엔드포인트를 부르면 401을 반환한다",
        "verifyBy": "test",
        "check": "tests/auth.test.ts > rejects expired token"
      },
      { "criterion": "프로덕션 빌드가 성공한다", "verifyBy": "command", "check": "pnpm build" },
      { "criterion": "로그인 에러 문구가 원인을 알려준다", "verifyBy": "manual" }
    ],
    "ontologySchema": { "entities": [], "relations": [] },
    "gestaltAnalysis": []
  }
}
```

**응답.** `spec.acceptanceCriteria`에 `id`가 붙어서 돌아온다. `warnings`는 비어 있으면 생략한다. 스킬이 `content[0]`을 JSON으로 파싱하므로(src/mcp/CLAUDE.md) 필드를 더하는 것은 안전하다.

```json
{
  "status": "generated",
  "spec": {
    "acceptanceCriteria": [
      {
        "id": "AC-1",
        "criterion": "...",
        "verifyBy": "test",
        "check": "tests/auth.test.ts > rejects expired token"
      },
      { "id": "AC-2", "criterion": "...", "verifyBy": "command", "check": "pnpm build" },
      { "id": "AC-3", "criterion": "...", "verifyBy": "manual" }
    ],
    "...": "..."
  },
  "warnings": ["AC-3: verifyBy가 없어 manual로 채웠다"]
}
```

**오류 예.** `{ "error": "Spec validation failed: acceptanceCriteria[1].check: verifyBy 'command' requires check" }`

스키마 정의는 `src/mcp/schemas.ts:96`과 `src/mcp/server.ts:208` 두 곳에 중복돼 있다. 두 곳 모두 `acceptanceCriterionInputSchema` 배열로 바꾼다. 서버 등록부의 shape는 MCP 도구 설명으로 호스트에 노출되므로, 여기서 문자열만 받으면 호스트가 객체를 보낼 엄두를 못 낸다.

**`ges_execute start`.** `spec.acceptanceCriteria`(src/mcp/schemas.ts:183)를 `acceptanceCriteriaSchema`로 바꾼다. 호스트가 들고 있던 옛 문자열 스펙을 그대로 넘겨도 `manual` AC로 정규화된 뒤 이벤트에 저장된다. 응답의 `executeContext.spec`에는 정규화된 객체가 실린다.

**`specPatch`와 `lateralResult.specPatch`.** `acceptanceCriteria`(src/mcp/schemas.ts:344, src/mcp/schemas.ts:430)를 `acceptanceCriterionInputSchema` 배열로 바꾼다. 여기서는 transform을 걸지 않는다. 문자열을 기존 AC에 대응시키려면 현재 스펙이 필요해서 머지는 적용기가 한다.

**실행 단계의 인덱스 필드(3번째 PR).** `classifiedACs[].acIndex`, `evaluationResult.verifications[].acIndex`, `atomicTasks[].sourceAC`는 지금처럼 받는다. 여기에 선택 필드 `acId`와 `sourceACIds`를 더한다. 둘 중 하나만 있으면 된다. 감사의 `implementedACs` 같은 숫자 배열은 그대로 둔다. 감사는 현재 스펙 하나를 한 번에 보는 단발 호출이라 패치에 따른 어긋남이 없다.

### 인덱스를 유지할지, id로 옮길지

**결정: 서버 안의 기준 키는 id로 옮긴다. 호스트와 주고받는 필드에서는 인덱스를 계속 받는다.**

- 플러그인 스킬과 서버 버전은 어긋날 수 있다. 전역 설치된 서버가 최신이고 스킬은 플러그인 캐시의 옛 버전인 상황이 문서화돼 있다(src/mcp/CLAUDE.md). 옛 execute 스킬은 `acIndex`만 보낸다(plugin/skills/execute/SKILL.md:550). 그러니 인덱스 입력을 끊으면 안 된다.
- 서버는 제출을 받는 시점에 **현재 스펙 기준으로** 인덱스를 id로 바꿔 둘 다 저장한다. figure-ground 제출 때 `acIndex → acId`, closure 제출 때 `sourceAC → sourceACIds`, 평가 제출 때 `verifications[].acIndex → acId`를 채운다. 호스트가 `acId`를 보내면 그쪽을 우선한다. 둘이 서로 다른 AC를 가리키면 거절한다.
- 타입에는 `ClassifiedAC.acId: string`, `AtomicTask.sourceACIds?: string[]`, `ACVerification.acId?: string`을 더한다. 옛 이벤트를 재구성하면 이 필드가 없을 수 있어서 `sourceACIds`와 `ACVerification.acId`는 선택으로 둔다. 재구성할 때 그 시점의 스펙으로 다시 채운다.
- 검증은 id로 한다. 계획 검증(src/execute/orchestrators/planning.ts:281-296)은 "현재 스펙의 모든 id가 분류됐는가"를 본다. 평가 검증(src/execute/orchestrators/evaluation.ts:179-185)은 "현재 스펙의 모든 id가 검증됐는가"를 본다.
- 맥락 평가 프롬프트는 `plan.classifiedACs`가 아니라 **현재 스펙의 AC**로 목록을 만든다. 분류 정보는 id로 붙인다. 분류되지 않은 새 AC는 `(unclassified)`로 표시한다. 배경에서 짚은 1번 어긋남이 이걸로 고쳐진다.
- evolve와 lateral 프롬프트의 미충족 AC 조회(src/execute/prompts.ts:581, src/resilience/prompts.ts:86, src/resilience/prompts.ts:92)는 `acId`로 찾는다. `acId`가 없는 옛 결과일 때만 인덱스로 떨어진다. 배경의 2번 어긋남이 이걸로 고쳐진다.
- 프롬프트에는 `[인덱스] id`를 같이 보여 준다(`formatAcLine`). 옛 스킬이든 새 스킬이든 자기가 아는 쪽 키를 쓸 수 있다.

### 패치와 안정 id

`mergeCriteriaPatch`가 패치의 AC 목록 전체를 현재 AC와 맞춘다. 항목마다 규칙은 다음과 같다.

| 패치 항목                                      | 처리                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| 객체이고 `id`가 현재 스펙에 있다               | 그 AC를 고친 것으로 본다. 빠진 `verifyBy`와 `check`는 현재 값을 물려받는다 |
| 객체이고 `id`가 현재 스펙에 없다               | 거절. 오류에 "새 AC는 id를 빼고 보내라"고 적는다                           |
| 객체이고 `id`가 없다                           | 새 AC. `AC-${idFloor+1}`부터 번호를 붙인다                                 |
| 문자열이고 현재 AC의 `criterion`과 정확히 같다 | 그 AC를 그대로 유지한다 (옛 스킬 호환)                                     |
| 문자열이고 일치하는 AC가 없다                  | 새 `manual` AC                                                             |
| 현재 스펙에 있는데 패치에 없는 id              | 삭제                                                                       |

`idFloor`는 현재 스펙과 `session.evolutionHistory`(src/core/types.ts:483)에 있는 모든 스펙의 AC 번호 가운데 가장 큰 값이다. 지운 id는 다시 쓰지 않는다. 옛 평가 결과나 태스크가 들고 있는 `AC-5`가 나중에 다른 문장을 가리키는 일을 막으려는 것이다. 히스토리 스냅샷은 패치를 적용하기 전에 이미 기록되므로(src/execute/orchestrators/evolution.ts:236-243) 계산에 필요한 정보는 이미 다 있다.

검증 위치는 이렇다. `validateSpecPatch`(src/execute/spec-patch-validator.ts:22)는 모르는 id, 겹치는 id, 생성 시점과 같은 `check` 규칙을 검사한다. `precheckPatch`가 이 함수를 부르므로(src/execute/orchestrators/evolution.ts:428-438) lateral 경로도 같은 검사를 거친다. lateral은 시도를 기록하기 전에 거르므로(src/execute/orchestrators/evolution.ts:406-408) 잘못된 id 때문에 페르소나 기회를 날리지 않는다. `applySpecPatch`(src/execute/spec-patch-applier.ts:10)에는 `idFloor` 인자를 더한다.

`SpecDelta`(src/core/types.ts:402)에는 선택 필드를 하나 더한다.

```ts
acChanges?: { added: string[]; removed: string[]; modified: string[] };
```

`modified`는 id는 같은데 `criterion`, `verifyBy`, `check` 중 하나가 바뀐 경우다.

영향 태스크 식별(src/execute/impact-identifier.ts:27-35)은 `acChanges`가 있고 태스크에 `sourceACIds`가 있을 때만 좁혀서 고른다. `removed`나 `modified`와 겹치는 태스크만 재실행 대상으로 잡는다. `added`가 비어 있지 않으면 지금처럼 AC에 연결된 태스크를 전부 재실행한다. 새 AC를 맡을 태스크가 계획에 없기 때문이다. `acChanges`가 없는 옛 delta도 지금과 똑같이 동작한다.

### 프롬프트 변경

**스펙 생성 프롬프트.** `buildSpecPrompt`(src/llm/prompts.ts:99-125)와 `buildTextSpecPrompt`(src/spec/text-based-spec-generator.ts:41-63)의 JSON 예시를 객체 배열로 바꾸고 규칙 블록을 붙인다. 두 함수가 같은 블록을 쓰도록 `AC_VERIFICATION_RULES` 상수 하나를 `src/llm/prompts.ts`에 둔다.

```
"acceptanceCriteria": [
  {"criterion": "observable, testable statement", "verifyBy": "test|command|manual", "check": "..."}
]

Acceptance criteria verification rules:
- Choose verifyBy in this order of preference: test > command > manual.
- "test": an automated test can assert it. check = "<test file path> > <test name or pattern>".
  The test may not exist yet; name the test that should prove this criterion.
- "command": a single non-interactive shell command proves it by exit code 0
  (e.g. "pnpm build", "node dist/cli.js --version"). One line, no destructive operations,
  no long-running servers.
- "manual": only when human judgment is required (UX, copy, visual quality). Omit check.
- Do not invent ids; the server assigns them.
```

`projectType`가 `brownfield`이면 "기존 테스트 파일과 러너 이름을 우선한다"는 한 줄을 더한다. 이 값은 프롬프트에 이미 들어가 있다(src/llm/prompts.ts:108).

**템플릿.** `baseAcceptanceCriteria`(src/spec/templates.ts:16, src/spec/templates.ts:37, src/spec/templates.ts:59)를 객체로 바꾼다. 렌더(src/spec/templates.ts:106)는 `- [test] GET /health ...` 꼴로 찍는다. 포트나 경로를 가정한 `command`는 넣지 않고 `test`나 `manual`로 둔다.

**실행과 evolve 프롬프트.** 배경 표에 있는 보간 자리를 전부 `formatAcLine`으로 바꾼다. evolve와 lateral의 패치 JSON 예시(src/execute/prompts.ts:617, src/resilience/prompts.ts:146)는 다음처럼 바꾸고 규칙 두 줄을 붙인다.

```
"acceptanceCriteria": [{"id": "AC-1", "criterion": "...", "verifyBy": "test", "check": "..."}, {"criterion": "new AC", "verifyBy": "manual"}]
- Keep the id of every criterion you keep or modify. Omit id for new criteria. Never reuse a removed id.
```

figure-ground와 평가 프롬프트의 JSON 예시에는 `"acId": "AC-1"`을 `acIndex` 옆에 더한다(src/execute/prompts.ts:84, src/execute/prompts.ts:341, src/execute/prompts.ts:438). closure 예시에는 `"sourceACIds": ["AC-1"]`을 더한다(src/execute/prompts.ts:125).

**감사 프롬프트.** `AC[${i}]: ${ac}`(src/execute/audit-engine.ts:19)를 `formatAcLine`으로 바꾼다. 응답 형식은 인덱스 배열 그대로 둔다.

## 바꿀 파일

| 파일                                                                                                                   | 변경                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| src/core/types.ts                                                                                                      | `AcVerifyBy`, `AcceptanceCriterion`, `AcceptanceCriterionInput`, `AcChanges` 추가. `Spec`, `SpecPatch`, `SpecTemplate`, `SpecDelta` 필드 타입 변경. `ClassifiedAC.acId`, `AtomicTask.sourceACIds`, `ACVerification.acId` 추가 |
| src/spec/acceptance-criteria.ts (신규)                                                                                 | 입력 스키마, 정규화, `formatAcLine`, `mergeCriteriaPatch`, `maxAcIdNumber`                                                                                                                                                    |
| src/spec/schema.ts                                                                                                     | `acceptanceCriteria`를 `acceptanceCriteriaSchema`로 교체                                                                                                                                                                      |
| src/spec/passthrough-generator.ts                                                                                      | `ExternalSpec` 타입 변경, `validation.data` 반환, `warnings` 반환, 이벤트에 `acVerifyBy` 집계 추가                                                                                                                            |
| src/spec/generator.ts                                                                                                  | `validation.data` 반환, 이벤트 집계 추가                                                                                                                                                                                      |
| src/spec/extractor.ts                                                                                                  | AC 파싱을 문자열과 객체 둘 다 받게 변경                                                                                                                                                                                       |
| src/spec/text-based-spec-generator.ts                                                                                  | 프롬프트 JSON 예시와 규칙 블록                                                                                                                                                                                                |
| src/spec/templates.ts                                                                                                  | 템플릿 AC를 객체로 바꾸고 렌더 변경                                                                                                                                                                                           |
| src/llm/prompts.ts                                                                                                     | `buildSpecPrompt` 예시 변경, `AC_VERIFICATION_RULES` 추가                                                                                                                                                                     |
| src/mcp/schemas.ts                                                                                                     | 96, 183, 344, 430행 AC 스키마 교체. `acId`와 `sourceACIds` 선택 필드 추가                                                                                                                                                     |
| src/mcp/server.ts                                                                                                      | `ges_generate_spec` 등록부 AC 스키마 교체(208행)                                                                                                                                                                              |
| src/mcp/tools/spec-passthrough.ts                                                                                      | 응답에 `warnings` 싣기                                                                                                                                                                                                        |
| src/execute/repository.ts                                                                                              | fold에서 시작 스펙과 패치 스펙을 `normalizeSpec`으로 정규화(103, 343-361행). `buildShortCircuitEvaluation`(32-44행)에 `acId` 채우기                                                                                           |
| src/execute/prompts.ts                                                                                                 | 보간 자리를 `formatAcLine`으로, JSON 예시에 `acId`와 `sourceACIds` 추가, 맥락 평가 목록을 현재 스펙 기준으로                                                                                                                  |
| src/resilience/prompts.ts                                                                                              | 보간 자리 교체, 패치 예시와 id 규칙                                                                                                                                                                                           |
| src/resilience/lateral.ts                                                                                              | `AC[${v.acIndex}]` 표기를 id로(97행)                                                                                                                                                                                          |
| src/execute/audit-engine.ts                                                                                            | AC 목록 표기 교체                                                                                                                                                                                                             |
| src/execute/orchestrators/planning.ts                                                                                  | 인덱스를 id로 바꿔 저장, 커버리지와 참조 검증을 id로                                                                                                                                                                          |
| src/execute/orchestrators/evaluation.ts                                                                                | 인덱스를 id로 바꿔 저장, 커버리지를 id로, 맥락 평가 컨텍스트를 현재 스펙으로                                                                                                                                                  |
| src/execute/orchestrators/evolution.ts                                                                                 | `idFloor` 계산 후 적용기에 넘기기                                                                                                                                                                                             |
| src/execute/spec-patch-validator.ts                                                                                    | id 규칙과 `check` 규칙 검사                                                                                                                                                                                                   |
| src/execute/spec-patch-applier.ts                                                                                      | `mergeCriteriaPatch` 사용, `acChanges` 산출                                                                                                                                                                                   |
| src/execute/impact-identifier.ts                                                                                       | `acChanges`와 `sourceACIds` 기반으로 좁혀 고르기                                                                                                                                                                              |
| tests/helpers/execute-fixture.ts                                                                                       | `makeSpec`이 문자열을 받아 객체로 바꾸게(20, 74행)                                                                                                                                                                            |
| benchmarks/types.ts, benchmarks/run.ts, benchmarks/runners/passthrough-benchmark-runner.ts, benchmarks/scenarios/\*.ts | 타입 변경 반영                                                                                                                                                                                                                |
| plugin/skills/spec/SKILL.md                                                                                            | 입력 표(94행)와 예시(118행), `verifyBy` 고르는 기준, "응답의 spec을 execute에 넘긴다" 지시                                                                                                                                    |
| plugin/skills/execute/SKILL.md                                                                                         | 평가와 패치 예시(550, 597, 629행)에 `acId`와 객체 AC 반영                                                                                                                                                                     |
| docs/02-spec.md, docs/04-evaluate.md, docs/05-evolve.md, docs/mcp-reference.md                                         | 타입과 예시 갱신                                                                                                                                                                                                              |

## 하위 호환

- **호스트가 들고 있는 옛 스펙.** 서버는 스펙을 저장하지 않으므로(src/mcp/tools/spec-passthrough.ts:122-130) 옛 문자열 스펙은 호스트 쪽에 남아 있다. `ges_execute start`가 이것을 받아 `manual` AC로 정규화한다. 기존 세션은 검증 방법 없이 지금처럼 LLM 판정으로 돈다.
- **이벤트 원장의 옛 세션.** `EXECUTE_SESSION_STARTED`와 `EVOLVE_SPEC_PATCHED` 페이로드의 문자열 AC는 fold에서 `normalizeSpec`이 바꾼다. 한 세션 안에서 시작 스펙과 패치 스펙이 같은 규칙(i번째는 `AC-${i+1}`)으로 정규화된다. 다만 옛 패치에서 가운데 AC를 지운 세션은 정규화된 id가 패치 전후로 다른 문장을 가리킨다. 그 세션들은 원래 인덱스 기준으로 돌던 세션이고 저장된 평가 결과에 `acId`가 없다. 그래서 인덱스로 떨어지는 경로를 그대로 탄다. 동작은 지금과 같다.
- **옛 스킬.** `acIndex`만 보내는 스킬, 문자열 AC를 보내는 스펙 스킬, 문자열 목록을 보내는 패치 스킬이 모두 그대로 동작한다. 패치 문자열은 정확히 같은 문장이면 기존 id를 물려받는다.
- **새 스킬과 옛 서버.** 새 스킬이 객체 AC를 옛 서버에 보내면 `z.array(z.string())`에서 거절된다. 스펙 스킬은 오류 메시지에 `Expected string`이 보이면 `criterion`만 뽑아 문자열 배열로 다시 보내라고 안내한다. 매니페스트 버전 핀(scripts/CLAUDE.md)이 맞으면 이 상황은 생기지 않는다.
- **응답 형태.** `spec.acceptanceCriteria`가 객체 배열로 바뀌는 것이 응답에서 유일하게 깨지는 변화다. 이 배열을 문자열로 읽는 소비자는 스킬 문서와 벤치마크 러너(benchmarks/runners/passthrough-benchmark-runner.ts:500) 정도다. 러너는 `.length`만 쓰므로 그대로 동작한다. CHANGELOG에 breaking으로 적고 minor 버전을 올린다.

## 테스트

| 파일                                                                            | 확인할 것                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/unit/spec/acceptance-criteria.test.ts (신규)                              | 문자열 배열 정규화, 섞인 배열의 id 부여 순서, 표의 거절 규칙 각각, `manual`의 `check`를 지우고 경고 `formatAcLine` 출력                                |
| tests/unit/spec/passthrough-generator.test.ts                                   | 옛 문자열 입력 통과, 객체 입력에 id 부여, 반환 스펙이 `validation.data`인지, `command`에 `check`가 없으면 오류                                          |
| tests/unit/spec/extractor.test.ts                                               | 객체 응답과 문자열 응답과 섞인 응답에서 AC가 빠지지 않는지                                                                                              |
| tests/unit/spec/generator.test.ts                                               | 규칙을 어긴 응답 뒤 재시도                                                                                                                              |
| tests/unit/execute/spec-patch-ac.test.ts (신규)                                 | id 유지, 지운 id를 다시 안 쓰는지(히스토리 포함), 모르는 id 거절, 같은 문장 문자열이 기존 id를 물려받는지, `acChanges` 계산                             |
| tests/unit/execute/evolution-loop.test.ts                                       | 가운데 AC를 지운 뒤 평가 커버리지가 id 기준으로 통과하는지, 새 AC를 추가한 뒤 맥락 평가 프롬프트에 그 AC가 보이는지                                     |
| tests/unit/execute/planning-orchestrator.test.ts                                | `acIndex`만 보낸 제출에 `acId`가 채워지는지, `acId`만 보낸 제출이 통과하는지, 둘이 어긋나면 거절                                                        |
| tests/unit/execute/execution-evaluate.test.ts                                   | 평가 제출의 `acId` 채움과 커버리지                                                                                                                      |
| tests/unit/execute/repository.test.ts                                           | 문자열 AC를 담은 옛 시작 이벤트와 패치 이벤트를 재구성하면 정규화되는지                                                                                 |
| tests/unit/execute/impact-identifier 관련                                       | `removed`와 `modified`만 있으면 좁혀 고르고 `added`가 있으면 전부 고르는지                                                                              |
| tests/unit/execute/prompt-no-object.test.ts (신규)                              | figure-ground, closure, 평가, evolve, lateral, 감사, 템플릿 프롬프트 출력에 `[object Object]`가 없는지. 타입 검사가 못 잡는 보간 회귀를 막는 안전장치다 |
| tests/integration/interview-to-spec.test.ts, tests/integration/pipeline.test.ts | 객체 AC로 인터뷰부터 평가까지 끝나는지                                                                                                                  |

기존 테스트 30여 개가 `makeSpec(['AC0', ...])`처럼 문자열로 픽스처를 만든다. 픽스처 헬퍼가 문자열을 객체로 바꿔 주면 대부분은 손대지 않아도 된다. `spec.acceptanceCriteria[i]`를 문자열과 비교하는 단언만 `.criterion`으로 고친다.

## PR 나누기

1. **데이터 모델과 호환 계층.** 타입, `src/spec/acceptance-criteria.ts`, `specSchema`, MCP 입력 스키마, 생성기의 `validation.data` 반환, 추출기 파싱, repository 정규화, 패치 머지(`mergeCriteriaPatch`와 `idFloor`), 모든 보간 자리의 `formatAcLine` 교체, `[object Object]` 회귀 테스트, 픽스처와 벤치마크를 담는다. 생성 프롬프트는 아직 바꾸지 않아서 새 스펙도 전부 `manual`이 된다. 동작은 지금과 같고 데이터 형태만 바뀐다.
2. **생성 시점의 검증 방법.** 생성 프롬프트의 규칙 블록, 템플릿, 거절 규칙과 `warnings`, 이벤트 집계, spec 스킬 문서와 docs/02-spec.md를 담는다. 이 PR부터 AC에 `test`와 `command`가 실린다.
3. **실행 단계의 id 기준화.** `acId`와 `sourceACIds` 채움, 계획과 평가 커버리지의 id 검증, 맥락 평가 프롬프트를 현재 스펙 기준으로 바꾸기, evolve와 lateral 조회의 id 전환, `acChanges`, 좁혀 고르는 영향 식별, execute 스킬 문서와 docs/04, docs/05를 담는다. 배경에서 짚은 패치 뒤 어긋남 두 가지를 이 PR이 고친다.

1번과 2번은 순서대로 들어가야 한다. 3번은 1번 위에서 2번과 따로 진행할 수 있다.

## 열린 질문

1. **`test`에 `check`를 필수로 둘 것인가.** 이 문서는 필수로 정했다. greenfield에서 LLM이 아직 없는 테스트 이름을 지어내야 하는 부담이 있다. 거절이 잦으면 `test`는 `check` 없이 받고 경고만 남기는 쪽으로 완화할 수 있다. PR 2 뒤에 `SPEC_GENERATED` 집계와 거절 빈도를 보고 정한다.
2. **`command` 명령의 신뢰 경계.** 텍스트 입력이 Jira나 GitHub 이슈에서 오면(src/core/types.ts:717) 이슈 본문에 심긴 명령이 `check`로 흘러들 수 있다. 서버는 실행하지 않지만 평가 단계를 맡는 쪽이 이 명령을 호스트에서 돌리게 된다. 허용 접두어 목록을 둘지, 실행 전에 사람 확인을 강제할지, 출처가 텍스트 입력인 스펙만 `command`를 `manual`로 떨어뜨릴지 평가 설계와 함께 정해야 한다.
3. **구조 평가와의 관계.** 구조 평가는 서버가 정한 명령을 그대로 돌렸는지 문자열로 대조한다(src/execute/orchestrators/evaluation.ts:105). `command` AC를 이 목록에 합칠지, 별도 단계로 둘지는 평가 쪽 설계가 정한다. 이 문서는 `check` 문자열을 바꾸지 않고 실어 나르는 것까지만 보장한다.
4. **evolve에서 새로 생긴 AC를 맡을 태스크.** 지금은 재계획 없이 기존 태스크를 재실행한다(src/execute/orchestrators/evolution.ts:249-276). 그래서 새 AC는 어느 태스크의 `sourceACIds`에도 없다. 새 AC만 대상으로 closure를 한 번 더 돌리는 짧은 단계가 필요한지 정해야 한다.
5. **brownfield에서 러너 힌트를 줄 것인가.** 구조 평가는 프로젝트 루트에서 패키지 매니저와 테스트 명령을 감지한다(src/execute/orchestrators/evaluation.ts:51-52). 같은 감지 결과를 스펙 프롬프트에 넣으면 `check` 품질이 오른다. 다만 스펙 도구에는 cwd 입력이 없어서 입력 필드를 하나 늘려야 한다.
6. **사용자에게 분포를 보여 줄 것인가.** spec 스킬이 생성 직후 "test 4, command 1, manual 2"처럼 보여 주고 `manual` 비율이 높으면 다시 물을지 정해야 한다. 해상도 점수 옆에 두는 두 번째 품질 신호로 쓸 수 있다.
