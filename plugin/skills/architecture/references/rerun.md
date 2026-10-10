1. `.gestalt/architecture/<view>.json`을 읽어 지난 IR을 가져온다. 처음부터 다시 탐색하지 않는다.
2. **노드 id를 유지한다.** 같은 노드는 같은 id로 쓴다. render가 kind와 repo와 label이 같은 노드에 이전 id를 물려주긴 한다. 그런데 label을 바꾸면 다른 노드로 본다. 엔드포인트 label은 Step 3의 꼴을 그대로 지킨다. 사람이 읽을 이름을 고치고 싶으면 label 대신 `displayName`을 고친다.
3. **`previousSourcesUsed`를 먼저 간 본다.** `probeHit`가 `true`였던 소스부터 본다. 이번에도 `filter_tools`는 다시 거친다. 도구 이름이 같아도 이번 세션에 붙은 서버가 다를 수 있다.
4. **지난 실행 이후 바뀐 곳 주변만 다시 탐색한다.** `generatedAt` 이후의 `git log`와 `git diff`로 바뀐 파일을 뽑는다. 그 파일에 걸린 노드와 엣지만 근거 줄을 다시 확인한다. 안 바뀐 파일의 근거도 줄이 밀렸을 수 있으니 validate의 `CODE_EVIDENCE_NOT_FOUND`가 나면 그 근거는 다시 찾는다.
5. **질문별 그림은 지난 것을 다시 적지 않아도 된다.** 새 IR에 같은 id 그림이 없으면 render가 지난 그림을 이어 붙인다. 단 가리킨 노드와 엣지가 다 남아 있고 그림 id와 메시지 id가 이번 것과 안 겹칠 때만이다. 하나라도 어긋나면 버려지니 응답의 `viewPaths`에서 빠진 그림이 있는지 본다. 빠졌으면 지도를 고친 뒤 다시 적는다.
6. 답이 달린 지난 질문은 render가 물려준다. 답 안 달린 질문은 Step 7에서 다시 묻는다. `user` 근거로 정해진 기능영역 경계는 Step 3-1대로 그대로 둔다.
