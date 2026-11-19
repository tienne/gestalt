# 도구별 설치와 명령

[`device`](../SKILL.md) 스킬이 고른 도구의 절만 읽는다. 설치 명령은 승인받은 뒤에만 실행한다. 승인 때 절마다 적힌 고정 버전과 출처, 텔레메트리를 같이 보여준다.

아래 버전은 2026-11-19에 확인한 값이다. 올릴 때는 새 버전을 직접 확인하고 이 문서를 고친다. 설치 스크립트는 파일로 받아 사용자에게 보여준 뒤 실행한다.

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

## 캡처 저장 위치

스크린샷과 UI 덤프는 레포 밖 임시 폴더에만 남긴다. 작업 디렉토리에 찍으면 남의 앱 원본이 `git add` 한 번에 레포로 올라갈 수 있다.

```sh
T="${TMPDIR:-/tmp}"; RAW=$(mktemp -d "${T%/}/gestalt-device.XXXXXX")
iph screenshot -o "$RAW/<n>.png"
idb screenshot "$RAW/<n>.png"
adb exec-out screencap -p > "$RAW/<n>.png"
```

mobile-mcp는 `mobile_save_screenshot`의 저장 경로에 `$RAW/<n>.png`를 넘긴다. 이미지를 바로 돌려주는 `mobile_take_screenshot`은 research에서 쓰지 않는다. iPhone 미러링은 화면 조작 도구가 스크린샷을 파일 없이 이미지로 바로 돌려준다.

폴더 이름을 `gestalt-device.`로 시작하게 만드는 건 지울 때 아래 가드로 확인하려는 것이다. `TMPDIR`이 슬래시로 끝나는 macOS에서도 경로가 맞도록 끝 슬래시를 떼고 붙인다. 지울 경로 쪽 끝 슬래시도 남김없이 뗀다. 링크 경로 끝에 `/`가 붙은 채로 `rm -rf`를 돌리면 링크가 가리키는 폴더가 지워진다.

check와 qa, 혼자 불린 경우는 끝낼 때 아래 가드로 지운다. research로 불렸으면 멈춤이나 실패, 중단으로 끝나도 지우지 않고 `mktemp`가 찍은 경로 문자열을 `rawDir`로 돌려준다. 지우는 쪽은 research 하나이고 같은 가드를 쓴다.

셸 변수는 도구 호출 사이에 남지 않는다. 그래서 가드 첫 줄의 `<rawDir 값>` 자리에 지울 경로를 직접 넣고 돌린다. research는 device가 돌려준 `rawDir`를, check와 qa는 자기가 만든 경로를 넣는다.

```sh
RAW='<rawDir 값>'
T="${TMPDIR:-/tmp}"
while :; do case "$RAW" in */) RAW="${RAW%/}" ;; *) break ;; esac; done
case "$RAW" in
  ''|*/..|*/../*|*/.|*/./*) echo "rawDir를 지우지 않았다: $RAW" ;;
  "${T%/}"/gestalt-device.*)
    if [ -L "$RAW" ]; then echo "rawDir가 링크라 지우지 않았다: $RAW"
    elif [ -d "$RAW" ]; then rm -rf -- "$RAW"
    else echo "rawDir가 이미 없다: $RAW"; fi ;;
  *) echo "rawDir가 임시 폴더 밖이라 지우지 않았다: $RAW" ;;
esac
```

지우지 않았다는 줄이 나오면 그 경로를 사용자에게 보여주고 직접 확인해 달라고 한다. 이미 없다는 줄은 지울 게 없다는 뜻이라 따로 묻지 않는다.

## MCP 등록

mobile-mcp처럼 MCP 서버로 붙는 도구는 호스트마다 등록 방식이 다르다. 아래는 mobile-mcp 예시다. 버전과 환경변수는 각 도구 절을 따른다.

Claude Code는 명령으로 등록한다.

```sh
claude mcp add mobile-mcp -e MOBILEMCP_DISABLE_TELEMETRY=1 -- npx -y @mobilenext/mobile-mcp@1.0.18
```

Codex는 `~/.codex/config.toml`에 적는다.

```toml
[mcp_servers.mobile-mcp]
command = "npx"
args = ["-y", "@mobilenext/mobile-mcp@1.0.18"]
env = { MOBILEMCP_DISABLE_TELEMETRY = "1" }
```

그 밖의 호스트는 그 호스트의 MCP 설정 자리에 같은 command와 args, env를 넣는다. 방식을 모르면 지어내지 말고 사용자에게 묻는다. `npx -y`는 버전을 고정한 이 명령을 사용자가 승인했을 때만 쓴다.

## iph (research와 check, iOS 27 이상 실기기)

설치와 셋업이다. 바이너리는 `~/.local/bin/iph`에 깔린다.

```sh
DL=$(mktemp -d)
curl -fsSL -o "$DL/install.sh" https://raw.githubusercontent.com/HyunSeob/iphone-cli/v0.1.7/install.sh
cat "$DL/install.sh"                        # 사용자에게 보여준다
IPH_VERSION=v0.1.7 sh "$DL/install.sh"
iph setup                    # 승인 필요. 폰에 필요한 걸 단계별로 안내한다
iph doctor --no-touch-test   # 승인 필요. 개발자 디스크 이미지가 없으면 받아서 깐다
```

- 출처: 개인 계정 레포(`HyunSeob/iphone-cli`)다. 고정 버전은 v0.1.7이다. 설치 스크립트가 릴리스 바이너리의 sha256을 확인하지만 체크섬도 같은 릴리스에서 받아서 릴리스 자체가 바뀌면 못 막는다.
- `iph doctor`는 개발자 디스크 이미지를 GitHub 개인 레포(`doronz88/DeveloperDiskImage`)에서 받는다. 그래서 첫 실행은 승인 대상이다.
- 텔레메트리: 확인 못함.

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
- 결제와 전송 버튼을 가리지 않는다. 누를지는 [`device`](../SKILL.md#안전-규칙) 스킬의 확정 직전 멈춤 규칙으로 정한다.

## mobile-mcp (research와 check, iOS 26 이하 실기기와 Android)

MCP 서버로 붙인다. 호스트별 등록 명령은 [MCP 등록](#mcp-등록)에 있다.

- 출처: npm `@mobilenext/mobile-mcp`. 고정 버전은 1.0.18이다. `@latest`로 등록하지 않는다. 등록하면 세션마다 기기 제어 권한으로 돌아서 버전이 바뀌면 다시 승인받는다.
- 텔레메트리: 기본으로 보낸다. 등록할 때 `MOBILEMCP_DISABLE_TELEMETRY=1`을 넣어 끈다.
- 스크린샷은 `mobile_save_screenshot`으로 파일에 저장한다. `mobile_take_screenshot`은 이미지를 바로 돌려주니 research에서는 쓰지 않는다.
- `mobile_batch_commands`는 동작 여러 개를 한 번에 보내서 동작마다 판단하는 루프를 건너뛴다. 보내기 전에 steps에 확정 동작이 있는지 훑어 사용자에게 보여준다. research에서는 steps에 `mobile_take_screenshot`을 넣지 않는다.

- Android는 `adb devices`에 기기가 보이면 바로 된다. 폰에 깔 것이 없다.
- iOS 실기기는 폰에 mobilecli 에이전트 앱을 서명해서 깔아야 한다. provisioning profile이 필요하고 무료 Apple ID 서명은 7일 뒤 만료된다. 예전 WebDriverAgent 방식은 `MOBILEMCP_LEGACY_ROBOT=1`로 쓴다.
- 도구 이름은 버전마다 바뀌니 MCP 목록에서 확인한다. 기기 목록, 요소 목록, 스크린샷, 좌표 탭, 입력, 앱 실행이 있다.

## Maestro (qa, Android 에뮬레이터와 흐름을 파일로 남길 iOS 시뮬레이터)

```sh
DL=$(mktemp -d)
curl -fsSL -o "$DL/maestro-install.sh" "https://get.maestro.mobile.dev"
cat "$DL/maestro-install.sh"                # 사용자에게 보여준다
MAESTRO_VERSION=2.12.1 bash "$DL/maestro-install.sh"
MAESTRO_CLI_NO_ANALYTICS=1 maestro --version
```

- 출처: 공식 설치 스크립트가 GitHub `mobile-dev-inc/maestro` 릴리스에서 받는다. 고정 버전은 2.12.1이고 `MAESTRO_VERSION`으로 고른다.
- 텔레메트리: 기본으로 익명 사용 통계를 보낸다. 실행할 때마다 `MAESTRO_CLI_NO_ANALYTICS=1`을 붙이거나 셸 설정에 넣는다.

| 하는 일 | 명령 |
|---|---|
| flow 실행 | `maestro test <flow.yaml>` |
| 화면 트리 | `maestro hierarchy` |
| flow 만들면서 보기 | `maestro studio` |

Java 17 이상이 필요하다. 기본 `java`가 더 낮으면 전역 설정은 두고 `JAVA_HOME=$(/usr/libexec/java_home -v 17+) maestro …`처럼 실행할 때만 잡는다.

flow는 YAML이라 레포에 커밋해 두고 CI에서 돌린다. qa 용도면 제어 루프에서 성공한 동작을 이 파일로 옮긴다. 로그인 값은 flow에 쓰지 않고 `${MAESTRO_TEST_USER}`처럼 `MAESTRO_`로 시작하는 변수로 둔다. Maestro가 이 접두어가 붙은 셸 환경변수를 flow에 알아서 넣으니 `-e` 없이 `maestro test <flow.yaml>`만 돌린다. 값은 사용자가 셸 환경이나 CI 시크릿으로 올리고 로컬 `.env`는 `git check-ignore -q .env`가 통과할 때만 `set -a; . ./.env; set +a`로 불러온다. 에이전트는 `.env`를 열거나 출력하지 않는다.

## idb (check와 qa, iOS 시뮬레이터)

brew 공식 하나로 companion과 client가 같이 깔린다. companion만 있고 client가 없으면 `pip3 install fb-idb==1.1.7`로 client만 깐다.

- 출처: Meta 공식 tap(`meta/fb`)과 PyPI `fb-idb`다. brew 공식 버전은 1.7.8이고 client는 1.1.7로 고정한다.
- 텔레메트리: 확인 못함.

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

## adb 직접 (research와 check, Android에서 mobile-mcp가 없을 때)

```sh
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml "$RAW/ui.xml" && adb shell rm /sdcard/ui.xml
adb shell input tap <x> <y>
adb shell input text "텍스트"
adb exec-out screencap -p > "$RAW/<n>.png"
adb shell monkey -p <패키지> 1     # 앱 실행
```

- 출처: Android SDK `platform-tools`다. 따로 깔지 않는다.
- 텔레메트리: 확인 못함.

`input text`는 한글과 공백을 제대로 못 넣는다. 한글 입력이 필요하면 mobile-mcp나 Maestro를 쓴다.

## iPhone 미러링 (research와 check, iOS 26 이하에서 mobile-mcp 서명이 안 될 때)

macOS의 iPhone 미러링 창을 화면 조작 도구로 다룬다. 설정은 필요 없지만 접근성 트리가 없어 스크린샷으로만 읽는다. 창이 맨 앞에 있어야 하고 사용자의 마우스와 키보드를 같이 쓰니 시작 전에 알린다. 화면 조작 도구의 스크린샷은 파일을 거치지 않고 이미지로 바로 넘어와서 원본 화면이 그대로 LLM에 넘어간다. research에서는 이 점을 먼저 알리고 승인받는다.
