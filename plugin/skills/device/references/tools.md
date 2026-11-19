# 도구별 설치와 명령

[`device`](../SKILL.md) 스킬이 고른 도구의 절만 읽는다. 설치 명령은 승인받은 뒤에만 실행한다.

## 기기 확인

```sh
xcrun devicectl list devices        # iOS 실기기. Xcode가 있어야 한다
xcrun simctl list devices booted    # 켜진 iOS 시뮬레이터
iph devices                         # iph가 있으면 iOS 버전까지 나온다
xcrun devicectl device info details --device <UDID>   # iph가 없을 때 iOS 버전(osVersionNumber)
adb devices -l                      # Android 실기기와 에뮬레이터
emulator -list-avds                 # 띄울 수 있는 Android 에뮬레이터
```

`xcrun`이 도구를 못 찾으면 `xcode-select -p`가 CommandLineTools를 가리키는 경우다. 조회만 할 거면 앞에 `DEVELOPER_DIR=<Xcode.app 경로>/Contents/Developer`를 붙인다. 아예 바꾸려면 `sudo xcode-select -s`가 필요하니 사용자에게 맡긴다.

`adb`가 PATH에 없으면 Android SDK의 `platform-tools` 폴더를 먼저 찾아본다.

## iph (iOS 27 이상 실기기)

설치와 셋업이다. 바이너리는 `~/.local/bin/iph`에 깔린다.

```sh
curl -fsSL https://raw.githubusercontent.com/HyunSeob/iphone-cli/main/install.sh | sh
iph setup     # 폰에 필요한 걸 단계별로 안내한다
iph doctor    # 확인. 개발자 디스크 이미지가 없으면 여기서 깐다
```

사람이 할 일은 USB 연결, "신뢰" 누르기, 개발자 모드 켜기, 잠금 해제다. 첫 연결 뒤에는 `iph connect --ip <IP>`로 Wi-Fi 연결을 저장할 수 있다.

자주 쓰는 명령이다.

| 하는 일 | 명령 |
|---|---|
| 화면 읽기 | `iph read` (화면 밖까지 `--all`, 식별자까지 `--full`) |
| 요소 찾기 | `iph find <selector>` |
| 탭 | `iph tap "라벨"` 또는 `iph tap x,y` |
| 스크롤 | `iph scroll down --until "라벨"` |
| 입력 | `iph type "텍스트" [--clear] [--submit]` |
| 앱 열기 | `iph launch <번들 id나 이름>`, 목록은 `iph apps` |
| 스크린샷 | `iph screenshot -o <파일>` |
| 방해 금지 | `iph dnd on`, 끝나면 `iph dnd off` |
| 여러 동작 한 번에 | `iph batch <JSON 파일>` 또는 `iph script <js 파일>` |
| MCP 서버 | `iph mcp` |

selector는 그냥 문자열이면 라벨 정확히 일치이고 `id=…`는 접근성 식별자다.

주의할 점이다.

- 결과가 `unknown`이면 다시 보내지 않고 `iph read`로 먼저 확인한다.
- `iph type`가 경고를 내면 값을 바꾸지 않은 것일 수 있다. 다시 입력하지 말고 화면부터 읽는다. 다시 치면 같은 글자가 두 번 들어갈 수 있다.
- 화면 공유 중이라는 표시가 폰 위쪽에 뜬다. 입력을 보내려면 이 상태가 필요하다. 화면 공유를 막는 앱이면 설정 파일(`~/.config/iph/config.toml`)에 `input_idle_secs = 0`을 넣는다. 입력마다 3~4초 늦어진다.
- 결제와 전송 버튼을 가리지 않는다. 누를지는 [`device`](../SKILL.md#안전-규칙) 스킬의 결제 규칙으로 정한다.

## mobile-mcp (iOS 26 이하 실기기, Android)

MCP 서버로 붙인다.

```sh
claude mcp add mobile-mcp -- npx -y @mobilenext/mobile-mcp@latest
```

- Android는 `adb devices`에 기기가 보이면 바로 된다. 폰에 깔 것이 없다.
- iOS 실기기는 폰에 mobilecli 에이전트 앱을 서명해서 깔아야 한다. provisioning profile이 필요하고 무료 Apple ID 서명은 7일 뒤 만료된다. 예전 WebDriverAgent 방식은 `MOBILEMCP_LEGACY_ROBOT=1`로 쓴다.
- 도구 이름은 버전마다 바뀌니 MCP 목록에서 확인한다. 기기 목록, 요소 목록, 스크린샷, 좌표 탭, 입력, 앱 실행이 있다.

## Maestro (QA, Android 에뮬레이터와 iOS 시뮬레이터)

```sh
curl -fsSL "https://get.maestro.mobile.dev" | bash
maestro --version
```

| 하는 일 | 명령 |
|---|---|
| flow 실행 | `maestro test <flow.yaml>` |
| 화면 트리 | `maestro hierarchy` |
| flow 만들면서 보기 | `maestro studio` |

Java 17 이상이 필요하다. 기본 `java`가 더 낮으면 전역 설정은 두고 `JAVA_HOME=$(/usr/libexec/java_home -v 17+) maestro …`처럼 실행할 때만 잡는다.

flow는 YAML이라 레포에 커밋해 두고 CI에서 돌린다. qa 용도면 제어 루프에서 성공한 동작을 이 파일로 옮긴다.

## idb (QA, iOS 시뮬레이터)

brew 공식 하나로 companion과 client가 같이 깔린다. companion만 있고 client가 없으면 `pip3 install fb-idb`로 client만 깐다.

```sh
brew tap meta/fb
brew trust meta/fb
brew install meta/fb/idb
idb list-targets
```

| 하는 일 | 명령 |
|---|---|
| 화면 트리 | `idb ui describe-all` |
| 탭 | `idb ui tap <x> <y>` |
| 입력 | `idb ui text "텍스트"` |
| 앱 설치와 실행 | `idb install <app>`, `idb launch <번들 id>` |
| 스크린샷 | `idb screenshot <파일>` |

접근성 트리는 시뮬레이터에서만 나온다. 실기기에는 쓰지 않는다.

`idb list-targets`가 `Failed to run ['--list', '1']`로 실패하면 xcode-select가 CommandLineTools를 가리키는 경우다. [기기 확인](#기기-확인)처럼 `DEVELOPER_DIR`을 붙인다.

## adb 직접 (mobile-mcp가 없을 때)

```sh
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml
adb shell input tap <x> <y>
adb shell input text "텍스트"
adb exec-out screencap -p > screen.png
adb shell monkey -p <패키지> 1     # 앱 실행
```

`input text`는 한글과 공백을 제대로 못 넣는다. 한글 입력이 필요하면 mobile-mcp나 Maestro를 쓴다.

## iPhone 미러링 (다른 방법이 안 될 때)

macOS의 iPhone 미러링 창을 화면 조작 도구로 다룬다. 설정은 필요 없지만 접근성 트리가 없어 스크린샷으로만 읽는다. 창이 맨 앞에 있어야 하고 사용자의 마우스와 키보드를 같이 쓰니 시작 전에 알린다.
