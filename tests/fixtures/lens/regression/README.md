# 읽기 렌즈 의심 표시 회귀 셋

논문 다섯 편의 ingest 결과에서 의심 표시에 필요한 표와 근거 문단만 잘라 둔 픽스처다. 편마다 폴더 하나에 네 파일이 있다.

- `source.json`: 고른 표만 남겼다. `pages`와 `figures`는 비웠고 크롭 그림 경로(`image`)는 지웠다.
- `transcript.json`: 고른 문단과 남긴 표의 캡션 문단만 남기고 0부터 다시 번호를 매겼다. `bulletCite`와 의심 표시의 `cite`는 이 번호를 쓴다.
- `index-map.json`: 새 번호 자리에 원래 문단 번호를 둔다. 원래 ingest 슬러그와 원문 주소도 여기 있다.
- `expected.json`: 기대 의심(`doubts`)과 속임 후보(`decoys`). `paper.slug`가 원래 ingest 슬러그다.

저작권 때문에 PDF와 원문 전체, 쪽 그림은 커밋하지 않는다. 다시 만들려면 원문을 ingest한 뒤 자르기 스크립트를 돌린다.

```bash
pnpm tsx bin/gestalt.ts lens ingest 'https://arxiv.org/pdf/1706.03762'
pnpm lens:fixture <slug> attention --tables table-2,table-3,table-4 --units 12,92-93,102,109 --title "Attention Is All You Need"
```

기대 의심은 lint에서 `DOUBT_*`와 표, 칸 참조 오류가 하나도 없어야 하고 속임 후보는 `expectedCode`가 나와야 한다. flavordiffusion은 2026-10-28, 나머지 넷은 2026-10-29에 ingest했고 2026-10-29에 lint로 이 조건을 확인했다.

## 편별 내용

### flavordiffusion

- 원문: https://aclanthology.org/2025.aisd-main.7.pdf (ingest 2026-10-28)
- 남긴 표: table-4(NMI), table-5(확신 조합), table-6(창의 조합). 모두 grid ok다.
- 남긴 문단(원래 번호): 74(NMI 결과), 84(창의 조합 해석), 캡션 80, 86, 87.
- 기대 의심
  - `fd-csp-50-nodes`(방향): 본문 74는 CSP 층이 임베딩을 크게 개선한다고 쓰는데 표 4 노드 50개는 CSP를 켜면 0.3236에서 0.2862로 떨어진다.
  - `fd-creative-scores`(숫자): 본문 84는 새 조합이 새 맛을 찾는 길을 연다고 쓰는데 표 6 점수는 0.0003~0.0006이고 표 5 확신 조합은 0.4663~0.7114다. 모델이 사실상 간선이 없다고 본 쌍을 제안이라 부른 자리다.
- 뺀 후보: 노드 100개도 CSP를 켜면 0.3170에서 0.3169로 내려가지만 차이가 표준편차(0.0207, 0.0257)보다 훨씬 작아서 기대 의심으로 두지 않았다.
- 고른 이유: 이 셋을 만든 계기가 된 논문이고 방향 의심과 숫자 의심이 하나씩 분명하다.

### attention

- 원문: https://arxiv.org/pdf/1706.03762 (ingest 2026-10-29)
- 남긴 표: table-2(번역 BLEU), table-3(구조 변형, **loose**), table-4(구문 분석 F1).
- 남긴 문단(원래 번호): 12(초록), 92(영독 결과), 93(영불 결과), 102(표 3 해석), 109(구문 분석 결과), 캡션 98, 107, 122.
- 기대 의심
  - `att-en-fr-bleu`(숫자): 표 2 big 줄과 초록은 EN-FR BLEU 41.8인데 본문 93은 41.0이라고 쓴다.
  - `att-parsing-luong`(방향): 본문 109는 RNNG 말고 앞서 보고된 모든 모델보다 낫다고 쓰는데 표 4에서 Luong 외(2015) multi-task가 93.0으로 Transformer semi-supervised의 92.7보다 높다. RNNG는 Dyer 외(2016)라 Luong은 예외에 들지 않는다.
- 고른 이유: 널리 읽힌 논문인데도 본문과 표가 어긋나는 자리가 둘 있고 여러 단 머리줄 표(표 3)가 loose로 잡힌다.

### resnet

- 원문: https://arxiv.org/pdf/1512.03385 (ingest 2026-10-29)
- 남긴 표: table-2(plain과 ResNet의 18층, 34층), table-3(ImageNet 오차), table-5(**loose**).
- 남긴 문단(원래 번호): 62(깊은 plain 망이 더 나쁘다), 69(34층 ResNet이 낫다), 80(지름길 A, B, C 비교), 캡션 73, 85, 86.
- 기대 의심: 없다. 본문 62, 69, 76, 80, 90, 104가 표 2, 3, 6과 맞는지 하나씩 대조했고 어긋난 자리를 못 찾았다.
- 속임 후보 `res-x-plain-degradation`은 34층 plain 망이 18층보다 오차가 높다는(27.94에서 28.54) 자리다. 본문이 스스로 밝힌 사실이라 의심이 아니다.
- 고른 이유: 어긋남 없는 대조군이다. 주장대로 움직인 자리와 낮을수록 좋은 오차율 지표를 속임 후보로 쓴다.

### bert

- 원문: https://arxiv.org/pdf/1810.04805 (ingest 2026-10-29)
- 남긴 표: table-3(**loose**), table-5(사전학습 과제 절제), table-6(모델 크기 절제).
- 남긴 문단(원래 번호): 92(NSP 절제 해석), 97(모델 크기 해석), 캡션 88, 99, 108.
- 기대 의심
  - `bert-sst2-base`(숫자): 표 5 BERT BASE 줄과 표 6의 12층, 768, 12 줄은 같은 설정이고 MNLI-m(84.4)과 MRPC(86.7)도 같은데 SST-2만 92.7과 92.9로 다르다.
- 고른 이유: 표끼리 어긋나는 숫자 의심이 있고 낮을수록 좋은 perplexity 칸이 있어 `better: lower` 속임 후보를 만들 수 있다.

### vit

- 원문: https://arxiv.org/pdf/2010.11929 (ingest 2026-10-29)
- 남긴 표: table-2(최신 모델 비교), table-6(**loose**).
- 남긴 문단(원래 번호): 68(표 2 해석), 94(모델 크기 해석), 캡션 77, 201.
- 기대 의심
  - `vit-l16-vs-bit-l`(숫자): 본문 68은 ViT-L/16이 BiT-L보다 모든 과제에서 낫다고 쓰는데 표 2에서 ImageNet ReaL은 90.54로 같고 VTAB은 76.28 대 76.29로 BiT-L이 높다.
  - `vit-flowers-h14`(숫자): 본문 68은 더 큰 ViT-H/14가 성능을 더 올린다고 쓰는데 표 2 Oxford Flowers-102에서 ViT-H/14는 99.68 ± 0.02로 ViT-L/16의 99.74 ± 0.00보다 낮다.
- 고른 이유: 표 칸 대부분이 `88.55 ± 0.04`처럼 표준편차를 달고 있다. 이런 칸은 방향 의심을 받지 않는다는 걸(`vit-x-plus-minus-cells`) 확인하는 자리다. Flowers-102에서 ViT-H/14(99.68)가 ViT-L/16(99.74)보다 낮은 것도 본문 68과 어긋난다. 두 칸이 모두 ± 칸이라 방향 의심은 속임 후보로 둔다. 근거 문단을 함께 건 숫자 의심은 기대 의심 `vit-flowers-h14`로 넣었다. 첫 실행 평가에서 lens-reader가 이 자리를 숫자 의심으로 찾아서 옮겼다.

## loose 표

attention의 table-3, resnet의 table-5, bert의 table-3, vit의 table-6이다. attention 표 3은 칸은 갈렸지만 여러 단 머리줄이 한 칸에 뭉쳤다. 나머지 셋은 원문 표 두 개가 한 칸짜리 줄로 이어 붙었다. resnet은 원문 표 4와 5, bert는 표 3과 2, vit는 표 5와 6이 뭉쳤다.

## ingest에서 본 것

- attention과 vit는 제목을 잘못 뽑았다("Provided proper attribution is provided…", "A"). 슬러그도 그 제목에서 나왔다. 픽스처는 `--title`로 제목만 바로잡았고 슬러그는 그대로 뒀다. 6차 후속에서 ingest가 첫 쪽의 가장 큰 줄을 제목으로 잡게 고쳐 지금은 둘 다 제목이 맞게 나온다. 슬러그는 평가가 레포 복사본을 찾는 이름이라 바꾸지 않았다.
- attention 본문 93은 소수점이 띄어져 `41 . 0`으로 뽑힌다. lint는 이 문단에서 41과 0을 따로 읽는다. 41.0을 note에 적으면 41로 읽혀 통과하지만 41.5 같은 값이었다면 막혔을 것이다.
