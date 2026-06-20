import { GestaltPrinciple } from '../core/types.js';
import { PRINCIPLE_QUESTION_STRATEGIES } from '../core/constants.js';

export const KOREAN_TONE_GUIDE = `## Korean Tone Guidelines (한국어 응답 시)

한국어로 답변할 때는 아래 규칙을 반드시 따른다.

**리액션 추임새 금지**: "물론이죠", "알겠습니다", "네, 이해했습니다", "감사합니다", "좋아요", "완벽합니다", "당연하죠", "그렇군요" 등 AI 특유의 추임새를 시작 문장에 쓰지 않는다. 바로 본론으로 들어간다.

**번역투 금지**:
- "~를 통해" → "~로" / "~해서"
- "~에 있어서" → "~에서" / 삭제
- "~의 경우" → "~은/는" / 직접 서술
- "~에 대해" → 목적격 직결 / "~을/를"
- "진행하다" → "하다" / 구체적 동사
- "확인하다" → 구체적 동사 (검토하다, 살피다 등)

**팀 동료 톤**: 격식 없이 직접적으로 말한다. 정보를 전달할 때는 "~입니다" 보다 "~야", "~이에요" 수준의 자연스러운 어조를 쓴다. 단, 전문성은 유지한다.`;

export const INTERVIEW_SYSTEM_PROMPT = `You are a Gestalt-trained requirements analyst. Your goal is to transform vague ideas into crystal-clear specifications by applying Gestalt psychology principles.

## Core Principles
- **Closure**: Fill in missing requirements — identify what's implied but unstated
- **Proximity**: Group related requirements — find natural clusters
- **Similarity**: Identify patterns — spot recurring themes across requirements
- **Figure-Ground**: Separate essential from optional — clarify MVP scope
- **Continuity**: Cross-validate consistency — detect contradictions

## Rules
1. Ask ONE focused question at a time
2. Each question should target a specific Gestalt principle
3. Build on previous answers — don't repeat what's already clear
4. Be conversational but precise
5. When detecting contradictions (Continuity), address them directly but diplomatically
6. Always respond in the user's language

${KOREAN_TONE_GUIDE}`;

export function buildQuestionPrompt(
  topic: string,
  principle: GestaltPrinciple,
  previousRounds: { question: string; response: string | null }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const strategy = PRINCIPLE_QUESTION_STRATEGIES[principle];
  const history = previousRounds
    .map((r, i) => `Round ${i + 1}:\nQ: ${r.question}\nA: ${r.response ?? '(no response)'}`)
    .join('\n\n');

  return `Topic: "${topic}"
Project type: ${projectType}
Current Gestalt focus: ${principle}
Strategy: ${strategy}

${history ? `Previous rounds:\n${history}\n\n` : ''}Generate the next interview question. Apply the ${principle} principle.

Respond with ONLY a JSON object:
{
  "question": "Your question here",
  "reasoning": "Brief explanation of why this question matters for ${principle}"
}`;
}

export function buildResolutionPrompt(
  topic: string,
  rounds: { question: string; response: string | null }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const history = rounds
    .filter((r) => r.response)
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.response}`)
    .join('\n\n');

  return `Analyze the clarity of this interview for: "${topic}" (${projectType} project)

Interview transcript:
${history}

Score each dimension from 0.0 (completely ambiguous) to 1.0 (crystal clear).
Also detect any contradictions between answers.

Respond with ONLY a JSON object:
{
  "goalClarity": 0.0-1.0,
  "constraintClarity": 0.0-1.0,
  "successCriteria": 0.0-1.0,
  "priorityClarity": 0.0-1.0,
  ${projectType === 'brownfield' ? '"contextClarity": 0.0-1.0,' : ''}
  "contradictions": [],
  "reasoning": "Brief analysis"
}`;
}

export function buildSpecPrompt(
  topic: string,
  rounds: { question: string; response: string }[],
  projectType: 'greenfield' | 'brownfield',
): string {
  const history = rounds
    .map((r, i) => `Q${i + 1}: ${r.question}\nA${i + 1}: ${r.response}`)
    .join('\n\n');

  return `Generate a complete project specification (Spec) from this interview about: "${topic}" (${projectType} project)

Interview transcript:
${history}

Respond with ONLY a JSON object:
{
  "goal": "Clear, concise project goal",
  "constraints": ["constraint 1", "constraint 2", ...],
  "acceptanceCriteria": ["criterion 1", "criterion 2", ...],
  "ontologySchema": {
    "entities": [{"name": "EntityName", "description": "what it is", "attributes": ["attr1", "attr2"]}],
    "relations": [{"from": "Entity1", "to": "Entity2", "type": "relationship_type"}]
  },
  "gestaltAnalysis": [
    {"principle": "closure|proximity|similarity|figure_ground|continuity", "finding": "what was discovered", "confidence": 0.0-1.0}
  ]
}`;
}
