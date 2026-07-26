# 변경 이력

## Unreleased

### 신뢰성

- 응답 전 소켓 종료를 즉시 실패로 처리하고, bounded aggregate teardown 안에서 분리 세션 정리 작업을 순차적으로 best-effort 시도합니다.

### 테스트

- 응답 없이 종료되는 소켓과 지연된 다수 status 정리 경로를 검증합니다.
- 검토한 exact child profile, local·`pi-subagent` cancellation의 무attention, active-parent 고정 window·10초 fence, stale official-hook probe, capability 독립성, privacy canary, replacement/shutdown fence 및 notification failure 격리를 fake Unix socket acceptance로 검증합니다.

### 문서

- capability negotiation, 공식 hook 우선순위, usage delta 및 다이어그램·릴리스 이력을 문서화합니다.
- `PI_CMUX_PROFILE=subagent-child-v1`의 exact channel suppression, producer lifecycle 경계, 고정 450ms/100ms terminal window와 제한된 consumer-side static/fake-socket acceptance 범위를 문서화합니다.

## v0.1.0 — 2026-07-25

- 초기 릴리스.
