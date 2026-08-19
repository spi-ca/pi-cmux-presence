# 변경 이력

## Unreleased

### 신뢰성

- `BoundedSocketQueue`는 포화 시 primary 출력을 대기 feed보다 앞에 넣고 가장 최근의 displaceable feed만 교체하며, 남은 feed의 FIFO 순서를 유지합니다.
- consumer-side `pi-presence:withdraw:v2`을 추가해 수락된 외부 source의 retained status를 철회하고, 공유 generation/sequence tombstone fence를 유지한 채 progress와 opt-in meta block을 다시 계산합니다. exact `subagent` remove는 pending terminal 집계를 무효화하고 보류된 local parent attention을 고정 fallback으로 복원합니다.
- `settled` notification policy를 추가했습니다. 기본값은 계속 `background`이며, settled는 local success/error와 external error를 허용하고 generic external info/success는 억제합니다. 성공 부모 settlement와 exact `subagent` 성공 집계의 병합은 finalized local completion으로 허용합니다.
- local Pi sidebar/notification을 canonical fixed wording으로 통일하고, terminal sidebar clear와 cmux notification retention의 소유권을 분리했습니다.
- 고정 `interaction` source의 strict V2 `waiting` state와 구조화된 `input_required` attention을 consumer-only `Pi needs your input` 표시로 처리합니다. `occurrence: "new"`만 기존 attention gate를 따르고 retained replay는 status-only입니다. producer payload를 복사하거나 새 protocol, consumer activation behavior, producer lifecycle authority를 추가하지 않습니다.
- 실제 post-connect fingerprint가 미해결인 동안 request write 전의 unsolicited data/end/close/error를 hard reject하고 queue를 fail-close합니다. runtime 공유 fingerprint lease gate는 stale lease가 실제 settle할 때까지 session replacement를 포함한 모든 runtime transport의 새 fingerprint를 거부하며 late release를 fence하지만, transport는 항상 module-intrinsic `safeSocketFingerprint`를 직접 실행합니다. standalone transport도 자체 gate를 사용합니다. 연결 전 connect error/timeout과 두 fingerprint 완료 뒤의 일반 응답 timeout은 계속 다음 요청을 막지 않습니다. startup resolver도 늦은 epoch 결과를 재사용하지 않고 settle 전에는 새 검증을 시작하지 않습니다.
- 공식 cmux hook probe를 소켓 해석 전에 `PI_CMUX_PRESENCE_TIMEOUT_MS` 및 session epoch abort로 제한했습니다. timeout·abort·오류와 non-regular 또는 64 KiB 초과 hook source는 official-hook authority를 fail-close하며, 미해결 underlying probe는 하나만 유지하고 늦은 결과가 새 session의 native lifecycle/opt-in integration을 되살리지 못하게 fence합니다.

### 테스트

- 포화된 queue에서 primary 출력이 가장 최근 feed를 교체하고, 앞선 feed들이 FIFO로 dispatch되는 회귀를 검증합니다.
- shared V2 runtime의 strict DTO/receipt, fixed source strings, structured attention, terminal channel, withdrawal tombstone, exact status clear, progress/meta 재계산, `subagent` pending invalidation과 local fallback 복원을 검증합니다.
- `settled` config trim/case, policy matrix·kill switch, canonical local formatter의 static/no-payload byte bound, idle settlement의 exactly-once local notification과 final sidebar clear를 검증합니다.
- 실제 post-connect validation 중 unsolicited data/close의 hard gate, stale fingerprint lease의 late-release fence, runtime session churn/transport replacement의 공유 validation 상한, 연결 error/timeout·post-write timeout 뒤 queue 복구, 응답 없이 종료되는 소켓과 지연된 다수 status 정리 경로를 검증합니다.
- 검토한 exact child profile, local·`pi-subagent` cancellation의 무attention, active-parent 고정 window·10초 fence, official-hook marker/부재/override, non-regular·64 KiB 초과 source, timeout·반복 epoch·late-result fence, capability 독립성, privacy canary, replacement/shutdown fence 및 notification failure 격리를 fake Unix socket acceptance로 검증합니다.

### 문서

- transport-state 다이어그램에 포화 queue의 primary 우선 삽입, 최신 feed 교체와 남은 feed FIFO 경로를 반영했습니다.
- shared runtime dependency의 V2 fixed source strings, structured attention, live terminal channel, exact `consumer.activate` ready/replay order, withdrawal tombstone과 event-flow를 문서화합니다.
- settled policy matrix와 merged finalized-local 예외, precedence, focus polling 부재와 cmux의 focused-banner/notification retention 소유권, canonical local wording·privacy boundary를 문서화합니다.
- capability negotiation, 공식 hook 우선순위, usage delta 및 다이어그램·릴리스 이력을 문서화합니다.
- `PI_CMUX_PROFILE=subagent-child-v1`의 exact channel suppression, producer lifecycle 경계, 고정 450ms/100ms terminal window, 공식 hook probe의 64 KiB bounded read·fail-closed authority와 제한된 consumer-side static/fake-socket acceptance 범위를 문서화합니다.
- `interaction`의 strict structured-attention profile, 고정 private 문구, new-occurrence gate와 retained status-only replay, 모든 Pi input wait를 주장하지 않는 authority 경계를 문서화합니다.

## v0.1.0 — 2026-07-25

- 초기 릴리스.
