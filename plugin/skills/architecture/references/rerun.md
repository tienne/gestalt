1. `.gestalt/architecture/<view>.json`을 읽어 지난 IR을 가져온다. 처음부터 다시 탐색하지 않는다.
2. **노드 id를 유지한다.** 같은 노드는 같은 id로 쓴다. render가 kind와 repo와 label이 같은 노드에 이전 id를 물려주긴 한다. 그런데 label을 바꾸면 다른 노드로 본다. 엔드포인트 label은 Step 3의 꼴을 그대로 지킨다. 사람이 읽을 이름을 고치고 싶으면 label 대신 `displayName`을 고친다.
3. **`previousSourcesUsed`를 먼저 간 본다.** `probeHit`가 `true`였던 소스부터 본다. 이번에도 `filter_tools`는 다시 거친다. 도구 이름이 같아도 이번 세션에 붙은 서버가 다를 수 있다.
4. **지난 실행 이후 바뀐 곳 주변만 다시 탐색한다.** `generatedAt` 이후의 `git log`와 `git diff`로 바뀐 파일을 뽑는다. 그 파일에 걸린 노드와 엣지만 근거 줄을 다시 확인한다. 안 바뀐 파일의 근거도 줄이 밀렸을 수 있으니 validate의 `CODE_EVIDENCE_NOT_FOUND`가 나면 그 근거는 다시 찾는다.
5. **질문별 그림은 지난 것을 다시 적지 않아도 된다.** 새 IR에 같은 id 그림이 없으면 render가 지난 그림을 이어 붙인다. 단 가리킨 노드와 엣지가 다 남아 있고 그림 id와 메시지 id가 이번 것과 안 겹칠 때만이다. lifecycle과 blueprint는 가리킨 흐름도 이번 IR `flows`에 있고 그릴 단계가 남아 있어야 한다(lifecycle은 `state`를 단 단계, blueprint는 갈림길이 아닌 단계). 흐름은 render가 지난 IR에서 이어받지 않으니 다시 적는다. 하나라도 어긋나면 버려지니 응답의 `viewPaths`에서 빠진 그림이 있는지 본다. 빠졌으면 지도를 고친 뒤 다시 적는다.
6. 답이 달린 지난 질문은 render가 물려준다. 답 안 달린 질문은 Step 7에서 다시 묻는다. `user` 근거로 정해진 기능영역 경계는 Step 3-1대로 그대로 둔다.
7. **화면 캡처는 지난 IR의 `capture`를 그대로 이어받는다.** 이미지는 읽지 말고 파일째 옮긴다. 4번에서 바뀐 파일로 뽑힌 화면이거나 `capture.commit` 이후 그 화면 코드가 바뀌었으면 낡았을 수 있다. 다시 찍을지 사용자에게 묻는다. 안 찍기로 하면 그대로 둔다.
8. **render 응답의 `delta`로 지난번과 무엇이 바뀌었는지 알린다.** render는 병합 전에 읽은 지난 IR과 이번 병합 결과를 id로 맞춰 생김(ADDED), 빠짐(REMOVED), 속성 변경(CHANGED), 부모나 계정, 구간 이동(MOVED), 연결 끝 변경(REWIRED)을 뽑는다. 2번처럼 label을 바꾼 노드는 빠짐과 생김 두 건으로 잡힌다. 이름만 고친 것을 변경 한 건으로 보이고 싶으면 `displayName`을 고친다. 알리는 법은 SKILL.md Step 8에 있다. 테이블 `columns`가 생기거나 빠지거나 바뀐 것도 그 테이블의 CHANGED 한 건에 컬럼 이름과 함께 실린다. 끝점이 바뀌어 짝지은 연결도 액션이 다르면 CHANGED와 REWIRED 두 건으로 잡힌다.
9. **테이블 `columns`는 render가 지난 IR에서 이어받지 않는다.** 이번 IR에 다시 적는다. 빠뜨리면 지운 컬럼과 구별이 안 돼 전부 빠짐으로 잡힌다. 마이그레이션이 늘었으면 새 파일만 읽어 지난 목록에 더한다.
