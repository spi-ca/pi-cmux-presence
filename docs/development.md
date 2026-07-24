# 개발 안내

## 도구와 타입 경로

이 패키지는 `package.json`의 `packageManager`에 선언된 `bun@1.3.14`를 사용합니다. `tsconfig.json`의 Pi 타입 경로는 Pi 설치 레이아웃 상대 경로 `../../npm/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`입니다. 패키지를 다른 위치로 옮기면 먼저 이 경로를 확인해야 합니다.

```bash
bun install
bun run check
bun run test
bun run ci
bun pm pack --dry-run
```

`ci`는 타입 검사와 테스트를 순서대로 실행합니다. `pack --dry-run`은 배포하지 않고 패키지 포함 파일을 확인합니다.

## 구조

- `index.ts`: 안정적인 Pi 확장 진입점
- `src/presence.ts`: 설정을 해석하고 runtime과 hook adapter를 조합하는 얇은 composition root
- `src/hooks.ts`: Pi lifecycle과 process-local event observer 등록
- `src/runtime.ts`: 세션 상태 머신, 직렬 teardown, replay, client lifecycle과 opt-in 조정
- `src/presentation.ts`: status/progress 선택, style, label·meta·terminal 상태의 순수 렌더링 정책
- `src/text.ts`: control/bidi 정규화와 code-point-safe UTF-8 byte 축약
- `src/official-hook.ts`: home-relative agent directory와 공식 cmux hook 감지
- `src/config.ts`: public 환경 변수, 기본값, 범위
- `src/identity.ts`: workspace/surface UUID와 안전한 소켓 경로
- `src/transport.ts`: 소켓 재검증, 단일 직렬 queue, keyed latest-write-wins 병합, 제한된 응답 교환
- `src/protocol.ts`: 목적지별 byte 한도와 cmux V1/V2 request·response 검증·인코딩
- `src/client.ts`: capability-gated V2와 설정-gated V1 cmux 쓰기, resume ownership 확인
- `src/usage.ts`: assistant 토큰·비용·context 사용률 집계
- `src/events.ts`: update/ready contract, session/source fence와 retained state
- `src/todo.ts`: provenance와 전체 task ID 고유성을 확인한 RPIV todo count/progress adapter

## 변경 불변 조건

- cmux CLI나 다른 프로세스를 실행하지 않고 Unix 소켓만 사용합니다.
- 유효한 `CMUX_WORKSPACE_ID`/`CMUX_SURFACE_ID`와 안전한 소켓이 없으면 대상·포커스를 추측하지 않습니다.
- V2 선택 메서드는 `system.capabilities`가 광고한 정확한 메서드만 호출합니다. V1 응답은 정확히 `OK`여야 합니다.
- observer 오류와 잘못된 host session ID는 Pi 작업 실패가 아니라 해당 presence 비활성화 또는 출력 유실로 끝나야 합니다.
- progress가 비활성일 때는 초기화·종료 cleanup도 보내지 않습니다. 활성화된 progress는 workspace 전역 슬롯이므로 session teardown과 startup을 직렬화합니다.
- 전송 text를 추가하면 `src/protocol.ts`의 목적지별 UTF-8 byte 한도와 `src/text.ts`의 Unicode-safe 축약을 함께 적용합니다.
- status key는 surface를 포함해 해시하고 `set_status`는 해당 surface panel에 범위 지정합니다. 새 state를 추가하면 style·priority와 event validator를 함께 갱신합니다.
- `pi`와 `pi-todo`는 예약 source입니다. generic update/ready contract와 count 확장은 [event-contract.md](event-contract.md)의 strict validator를 먼저 갱신해야 합니다.
- todo adapter는 descriptive task text나 tool result text를 보관·전송하지 않습니다. provenance와 deleted-task 제외 규칙을 약화하지 않습니다.
- 공식 cmux hook이 감지되면 이 패키지는 native lifecycle/opt-in hook 대체 기능을 보내지 않습니다. precedence를 무시하는 중복 출력을 추가하지 않습니다.
- feed, meta block, auto-title, resume fallback은 opt-in 데이터 경로입니다. 새 필드나 메서드는 protocol allowlist와 개인정보 문서를 함께 검토합니다.

## 검증 범위

`bun run ci`는 설정 파싱, V1/V2 codec과 multibyte 경계, capability gate, event/ready contract, 전체 todo ID 고유성, status state, invalid session fail-closed, lifecycle 전이·teardown race, keyed queue 병합과 가짜 Unix 소켓의 대상·권한 검증을 실행합니다. `bun pm pack --dry-run`은 패키징 범위를 확인합니다.

이 검증은 실행 중인 cmux에 연결하지 않습니다. 따라서 실제 cmux 서버의 버전·capability·hook 동작과 live 호환성은 자동 테스트가 보장하지 않습니다. 변경 후 실제 환경에서 확인할 항목은 UUID/소켓 안전성, capability advertisement, 공식 hook precedence, 필요한 opt-in flag입니다.

## 관련 문서

- [설정과 소켓 조건](configuration.md): socket/identity, capability, 공식 hook, privacy opt-in
- [이벤트 계약](event-contract.md): generic producer, ready replay, todo progress
- [`pi-subagent` generic producer 연동](pi-subagent-integration.md): dependency 없는 producer와 lifecycle authority 경계
