# pi-cmux-presence

Pi 세션과 같은 Pi 프로세스 안의 선택 생산자가 내는 짧은 상태를 cmux에 **Unix 소켓으로만** 전달하는 로컬 Pi 패키지입니다. 프로세스나 cmux CLI를 실행하지 않으며 Pi TUI, LLM 도구, 프롬프트, 스키마를 추가하지 않습니다.

## 설치

공개 Git 패키지는 Pi `>=0.80.10`에서 설치합니다. `cmux`가 제공한 `CMUX_WORKSPACE_ID`·`CMUX_SURFACE_ID`와 현재 사용자만 접근할 수 있는 Unix 소켓 환경이 필요합니다. 이 패키지는 `private: true`이므로 npm 설치를 제공하거나 안내하지 않습니다.

Pi extension을 포함한 제3자 패키지는 **full system access**로 실행됩니다. 설치 전 소스와 Git ref를 검토하고 신뢰할 수 있는 패키지만 설치하세요.

```bash
# v0.1.0 전역 설치
pi install git:github.com/spi-ca/pi-cmux-presence@v0.1.0

# 이후 새 release ref로 갱신하는 예시
pi install git:github.com/spi-ca/pi-cmux-presence@v0.2.0

# 제거
pi remove git:github.com/spi-ca/pi-cmux-presence
```

프로젝트에만 설치하려면 프로젝트 루트에서 설치 명령에 `-l`을 붙입니다.

```bash
pi install -l git:github.com/spi-ca/pi-cmux-presence@v0.1.0
```

### 로컬 경로 설치·개발

개발 중에는 현재 디렉터리를 로컬 패키지로 설치할 수 있습니다. Pi는 경로를 복사하지 않고 참조합니다.

```bash
bun install
bun run ci
pi install /absolute/path/to/pi-cmux-presence
# 프로젝트 범위 로컬 설치
pi install -l /absolute/path/to/pi-cmux-presence
```

코드나 패키지 설정을 바꾼 뒤 실행 중인 Pi에서 `/reload`를 실행합니다. 일회성 진입점 점검에는 `pi -e /absolute/path/to/pi-cmux-presence/index.ts`를 사용할 수 있습니다.

## 동작 요약

- `CMUX_WORKSPACE_ID`와 `CMUX_SURFACE_ID`가 모두 RFC variant UUID v1–v5이고 안전한 Unix 소켓을 찾을 때만 전송합니다. 대상·포커스·`/tmp/cmux.sock`을 추측하지 않습니다.
- 상태 키는 `surfaceId:sourceId`를 SHA-256으로 해시한 `pi-presence:<hash>`입니다. `set_status`는 해당 surface의 `--panel=<CMUX_SURFACE_ID>`를 포함하므로 상태 표시는 surface 범위입니다.
- 상태별 cmux 스타일은 `idle`(gray/circle/10), `waiting`(amber/clock/20), `running`(blue/play/30), `success`(green/check/20), `error`(red/x/40), `cancelled`(gray/minus/20)입니다.
- 내장 Pi lifecycle 관찰은 기본 활성(`PI_CMUX_PRESENCE_NATIVE_LIFECYCLE=true`)입니다. Pi PID와 `running`/`idle` lifecycle을 panel 범위로 보냅니다. `idle`은 cmux가 Pi가 유휴 상태임을 알 수 있게 하는 관찰 신호일 뿐, 이 패키지가 surface를 hibernate·resume하거나 Pi 작업을 제어한다는 뜻은 아닙니다.
- 최종 상태는 `agent_settled`에서 확정합니다. assistant 토큰, 양수 비용, 가능한 context 사용률과 `tool_result.isError`를 반영합니다. 내장 Pi 이벤트는 progress를 추정하지 않습니다.
- host session ID가 이벤트 계약의 safe text 조건(1–96 Unicode code points)을 만족하지 않거나 조회 중 오류가 나면 해당 세션의 presence를 fail-closed로 비활성화하고 기존에 소유한 출력을 정리합니다. Pi lifecycle 오류로 전파하지 않습니다.
- 상태·progress·notification·auto-title 문자열은 control/bidi 문자를 정규화하고 Unicode code point를 자르지 않으면서 설정의 글자 수와 목적지별 UTF-8 byte 한도를 모두 만족하도록 축약합니다.
- 모든 관찰 쓰기는 best-effort입니다. 소켓 오류·시간 초과·큐 포화·응답 오류는 Pi 작업을 실패시키지 않으며 해당 출력만 유실될 수 있습니다. 같은 key로 대기 중인 UI 쓰기는 하나의 promise를 공유하며 최신 요청으로 교체되는 latest-write-wins 방식으로 병합되고, 이미 실행 중인 요청은 교체하지 않습니다.

### 공식 cmux hook 우선순위

`$PI_CODING_AGENT_DIR/extensions/cmux-session.ts`(기본 `~/.pi/agent/extensions/cmux-session.ts`)에 `cmux-pi-session-extension-marker v2`가 있고 `CMUX_PI_HOOKS_DISABLED`가 `1`이 아니면 공식 hook이 우선합니다. `PI_CODING_AGENT_DIR`의 선두 `~` 또는 `~/`는 현재 사용자의 home directory로 확장합니다. 이때 이 패키지는 내장 Pi의 PID/lifecycle, feed, meta block, auto-title, resume fallback 및 Pi 완료 attention을 보내지 않습니다. 상태·progress와 다른 생산자의 attention은 계속 처리합니다. marker가 없거나 `CMUX_PI_HOOKS_DISABLED=1`이면 아래 설정대로 이 패키지의 경로를 사용합니다.

## cmux 프로토콜

초기화 때 V2 `system.capabilities`를 조회하고, 성공적으로 광고된 메서드만 선택 V2 호출에 사용합니다. 광고가 없거나 응답이 형식에 맞지 않으면 선택 V2 기능은 호출하지 않습니다. V1은 LF-구분 텍스트를 소켓에 직접 쓰며 각 응답은 정확히 대문자 `OK` 한 줄이어야 합니다.

| 계층 | 현재 사용 명령/메서드 | gate |
| --- | --- | --- |
| V1 | `set_status`, `clear_status`, `set_progress`, `clear_progress`, `log` | 각각 sidebar/progress/log 설정; progress가 꺼지면 초기·종료 clear도 보내지 않음 |
| V1 native | `set_agent_pid`, `set_agent_lifecycle`, `clear_agent_pid` | native lifecycle 설정과 공식 hook 부재 |
| V1 opt-in | `report_meta_block`, `clear_meta_block` | meta block 설정과 공식 hook 부재 |
| V2 probe | `system.capabilities` | 초기화마다 시도 |
| V2 attention | `notification.create_for_surface`, `surface.trigger_flash` | 해당 기능 flag와 서버 capability |
| V2 opt-in | `feed.push`, `workspace.set_auto_title`, `surface.resume.get/set/clear` | 해당 flag, 공식 hook 부재, 서버 capability |

V1의 workspace 대상은 항상 `--tab=<CMUX_WORKSPACE_ID>`입니다. `set_status`에는 `--panel=<CMUX_SURFACE_ID>`도 포함됩니다. V2의 surface 메서드는 workspace/surface UUID를 모두 포함합니다.

## 프로세스-로컬 이벤트

`pi-presence:update:v1`은 같은 Pi 프로세스의 event bus 입력입니다. V1 payload, 순서 fence, 추가 count와 progress 선택 규칙은 [이벤트 계약](docs/event-contract.md)을 따릅니다. 내장 source `pi`와 todo source `pi-todo`는 예약되어 외부 payload로는 수락하지 않습니다.

소비자는 세션 시작 시 다음 ready 광고를 냅니다. 이는 생산자에게 현재 상태 재발행을 요청하는 신호일 뿐 실행·취소·재시도 권한을 주지 않습니다.

```ts
pi.events.emit("pi-presence:ready:v1", {
  version: 1,
  sessionId,
  consumer: {
    id: "pi-cmux-presence",
    capabilities: ["cmux-status", "cmux-progress", "cmux-attention"],
  },
});
```

내장 Pi와 todo 생산자는 matching ready를 받으면 retained 상태를 새 sequence 및 `attention: "none"`으로 재발행합니다. 외부 생산자는 필요하면 같은 방식으로 자기 상태를 재발행해야 합니다.

## 개인정보와 전송 범위

내장 Pi producer와 todo adapter의 기본 상태 출력은 source label/state/count/선택 usage·progress·attention처럼 계약에서 허용한 축약 데이터만 사용합니다. 이 내장 경로는 사용자 프롬프트, 파일 경로, 도구 인수·출력, task 설명·제목, credential을 수집하거나 소켓으로 보내지 않습니다.

같은 프로세스의 외부 producer가 제공하는 `source.label`과 `progress.label`은 형식·control/bidi·길이를 검증하고 목적지 byte 한도로 축약하지만, 내용의 민감도를 판별하거나 redaction하지는 않습니다. 수락된 label은 status, progress, log, notification으로 cmux에 표시될 수 있으므로 외부 producer가 비밀, credential, 경로, prompt나 신뢰할 수 없는 원문을 넣지 않아야 합니다.

비기본 기능은 다음 데이터를 추가로 cmux에 보낼 수 있으므로 명시적으로 opt-in해야 합니다.

- `PI_CMUX_PRESENCE_FEED=true`: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`의 session ID와, tool 이벤트일 때 tool call ID·tool name만 전송합니다. cmux feed의 session/tool call ID는 `[A-Za-z0-9_.:-]{1,128}` token이어야 하며, 더 넓은 process-local safe text에는 해당하지만 이 token 형식이 아닌 ID의 feed 요청은 생략됩니다. 프롬프트와 tool 인수·결과는 넣지 않습니다.
- `PI_CMUX_PRESENCE_META_BLOCK=true`: source/작업 텍스트 없이 active/completed/failed/queued/cancelled/total, 반올림 token, 두 자리 cost, 반올림 context percent의 아홉 숫자만 newline으로 전송합니다.
- `PI_CMUX_PRESENCE_AUTO_TITLE=true`: Pi가 제공한 session name을 최대 길이로 축약한 `Pi · <name>` workspace title을 전송합니다.
- `PI_CMUX_PRESENCE_RESUME_FALLBACK=true`: `[A-Za-z0-9_.:-]{1,128}` token인 session ID를 checkpoint ID로, `pi --session '<sessionId>'` 명령을 resume binding으로 전송합니다. token 형식이 아닌 session ID에는 resume fallback을 설치하지 않습니다. 기존 binding은 비어 있거나 같은 checkpoint일 때만 설정하고, 설정 뒤 소유권을 확인한 경우에만 종료 시 지웁니다.

## 문서

- [설정과 소켓 조건](docs/configuration.md)
- [이벤트 계약](docs/event-contract.md)
- [개발 안내](docs/development.md)
- [`pi-subagent` generic producer 연동](docs/pi-subagent-integration.md)
- [기능 소유권과 `pi-cmux` 대비 현황](docs/feature-ownership.md)

## 검증

```bash
bun run ci
bun pm pack --dry-run
```

자동 검증은 가짜 Unix 소켓과 단위/통합 경로를 사용합니다. 실행 중인 cmux 서버에 대한 live 검증은 이 저장소에서 주장하지 않습니다.
