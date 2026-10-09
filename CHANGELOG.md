# 변경 이력

## v20261009-1

- Shared `@pi/presence`를 immutable `v2-20261009-1`로 동기화했습니다. peeled commit·V2 protocol·ABI는 기존 `v2-20261004-1`과 같습니다.
- Pi 개발 의존성·lockfile·현재 CI graph를 exact `1.1.0`으로 갱신했습니다.
- `agent_settled.aborted`를 기존 취소 outcome에 반영해 마지막 assistant가 완료됐더라도 취소를 성공·attention으로 승격하지 않습니다. OSC 7501은 Pi 자체 기능으로 유지합니다.

## v20261004-1

- Shared `@pi/presence`를 immutable `v2-20261004-1`로 동기화했습니다. 기존 release와 peeled commit·V2 protocol·ABI는 같습니다.

- 개발 의존성·lockfile·current CI graph를 exact Pi `1.0.2`로 동기화했습니다. socket-only presence와 최종 settlement 계약은 유지합니다.

## v20261001-1

### Pi 0.99.2 호환성

- installed Pi host와 개발 의존성·lockfile·current CI graph를 exact `0.99.2`로 정렬했습니다. 현재 runtime의 `chord`, `pi-codemode`, `pi-mcp`를 포함하고 더 이상 runtime dependency가 아닌 `pi-client`/`pi-protocol`은 current graph에서 제외합니다. `0.85.1`은 별도 legacy CI lane으로 유지하며 runtime shim을 추가하지 않습니다.
- `agent_end` fallback을 제거해 retry·compaction·queued work·`agent_before_settle` continuation 동안 완료를 잘못 발행하지 않습니다. 최종 terminal·attention·feed `Stop`·sidebar clear는 `agent_settled`에서만 처리합니다.
- `parentToolCallId`가 있는 nested tool error는 부모 실패로 누적하지 않습니다. top-level 실패는 최신 low-level run의 tool-only ending에서 유지하고, 이후 완료 assistant 응답과 continuation은 이전 error flag에서 recovery할 수 있습니다.
- idle low-level ending, continuation의 exactly-once terminal/notification/feed와 usage 누적, multi-depth nested 실패를 처리한 성공 부모 및 실패 부모의 회귀를 추가했습니다. socket-only, fixed/private presentation과 producer authority 경계를 유지하며 Herdr 기능은 추가하지 않습니다.

## v20260907-3 — 2026-09-07

### 신뢰성

- assistant tool error 뒤의 더 늦은 완료 응답을 terminal `completed`로 판정해, 복구된 turn이 `error`로 남지 않게 했습니다.
- `BoundedSocketQueue`는 포화 시 primary 출력을 대기 feed보다 앞에 넣고 가장 최근의 displaceable feed만 교체하며, 남은 feed의 FIFO 순서를 유지합니다.
- consumer-side `pi-presence:withdraw:v2`을 추가해 수락된 외부 source의 retained status를 철회하고, 공유 generation/sequence tombstone fence를 유지한 채 progress와 opt-in meta block을 다시 계산합니다. exact `subagent` remove는 pending terminal 집계를 무효화하고 보류된 local parent attention을 고정 fallback으로 복원합니다.
- `settled` notification policy를 추가했습니다. 기본값은 계속 `background`이며, settled는 local success/error와 external error를 허용하고 generic external info/success는 억제합니다. 성공 부모 settlement와 exact `subagent` 성공 집계의 병합은 finalized local completion으로 허용합니다.
- local Pi sidebar/notification을 canonical fixed wording으로 통일하고, terminal sidebar clear와 cmux notification retention의 소유권을 분리했습니다.
- 고정 `interaction` source의 strict V2 `waiting` state와 구조화된 `input_required` attention을 consumer-only `Pi needs your input` 표시로 처리합니다. `occurrence: "new"`만 기존 attention gate를 따르고 retained replay는 status-only입니다. producer payload를 복사하거나 새 protocol, consumer activation behavior, producer lifecycle authority를 추가하지 않습니다.
- 실제 post-connect fingerprint가 미해결인 동안 request write 전의 unsolicited data/end/close/error를 hard reject하고 queue를 fail-close합니다. runtime 공유 fingerprint lease gate는 stale lease가 실제 settle할 때까지 session replacement를 포함한 모든 runtime transport의 새 fingerprint를 거부하며 late release를 fence하지만, transport는 항상 module-intrinsic `safeSocketFingerprint`를 직접 실행합니다. standalone transport도 자체 gate를 사용합니다. 연결 전 connect error/timeout과 두 fingerprint 완료 뒤의 일반 응답 timeout은 계속 다음 요청을 막지 않습니다. startup resolver도 늦은 epoch 결과를 재사용하지 않고 settle 전에는 새 검증을 시작하지 않습니다.
- 공식 cmux hook probe를 소켓 해석 전에 `PI_CMUX_PRESENCE_TIMEOUT_MS` 및 session epoch abort로 제한했습니다. timeout·abort·오류와 non-regular 또는 64 KiB 초과 hook source는 official-hook authority를 fail-close하며, 미해결 underlying probe는 하나만 유지하고 늦은 결과가 새 session의 native lifecycle/opt-in integration을 되살리지 못하게 fence합니다.
- 정상 `session_shutdown`이 기존의 bounded runtime cleanup을 반환·await하도록 변경해 process 종료 전에 owned status clear를 시도합니다. observer 오류는 계속 Pi 작업에 전파하지 않으며 session start는 detached로 유지합니다. crash·`SIGKILL`은 보호하지 않고 persisted cross-process stale-status reconciliation도 아직 구현하지 않았습니다.
- todo의 untrusted `params`·`error`는 합산 1,024 visited values, object/array identity 추적으로 검증해 cycle·반복 alias를 fail-closed로 거부합니다. 성공한 non-todo tool result는 local ordinal·todo provenance 조회를 생략하되 failed-tool 상태 처리는 유지합니다.
- client별 status·progress·meta lane은 동일한 encoded V1 write와 성공한 clear acknowledgement를 공유합니다. 실패한 write는 재시도 가능하고 stale failure는 뒤의 lane 값을 지우지 않으므로 정상 teardown이 확인된 clear I/O를 중복하지 않습니다.

### 테스트

- locked baseline과 current Pi compatibility matrix, package tarball registration smoke를 GitHub Actions CI에 추가했습니다.
- 포화된 queue에서 primary 출력이 가장 최근 feed를 교체하고, 앞선 feed들이 FIFO로 dispatch되는 회귀를 검증합니다.
- shared V2 runtime의 strict DTO/receipt, fixed source strings, structured attention, terminal channel, withdrawal tombstone, exact status clear, progress/meta 재계산, `subagent` pending invalidation과 local fallback 복원을 검증합니다.
- `settled` config trim/case, policy matrix·kill switch, canonical local formatter의 static/no-payload byte bound, idle settlement의 exactly-once local notification과 final sidebar clear를 검증합니다.
- 실제 post-connect validation 중 unsolicited data/close의 hard gate, stale fingerprint lease의 late-release fence, runtime session churn/transport replacement의 공유 validation 상한, 연결 error/timeout·post-write timeout 뒤 queue 복구, 응답 없이 종료되는 소켓과 지연된 다수 status 정리 경로를 검증합니다.
- 검토한 exact child profile, local·`pi-subagent` cancellation의 무attention, active-parent 고정 window·10초 fence, official-hook marker/부재/override, non-regular·64 KiB 초과 source, timeout·반복 epoch·late-result fence, capability 독립성, privacy canary, replacement/shutdown fence 및 notification failure 격리를 fake Unix socket acceptance로 검증합니다.
- 실제 단기 Bun child process가 fake Unix socket에서 shutdown `clear_status`를 받은 뒤에만 정상 종료하는 통합 회귀를 추가했습니다.

### 문서

- transport-state 다이어그램에 포화 queue의 primary 우선 삽입, 최신 feed 교체와 남은 feed FIFO 경로를 반영했습니다.
- shared runtime dependency의 V2 fixed source strings, structured attention, live terminal channel, exact `consumer.activate` ready/replay order, withdrawal tombstone과 event-flow를 문서화합니다.
- settled policy matrix와 merged finalized-local 예외, precedence, focus polling 부재와 cmux의 focused-banner/notification retention 소유권, canonical local wording·privacy boundary를 문서화합니다.
- capability negotiation, 공식 hook 우선순위, usage delta 및 다이어그램·릴리스 이력을 문서화합니다.
- `PI_CMUX_PROFILE=subagent-child-v1`의 exact channel suppression, producer lifecycle 경계, 고정 450ms/100ms terminal window, 공식 hook probe의 64 KiB bounded read·fail-closed authority와 제한된 consumer-side static/fake-socket acceptance 범위를 문서화합니다.
- `interaction`의 strict structured-attention profile, 고정 private 문구, new-occurrence gate와 retained status-only replay, 모든 Pi input wait를 주장하지 않는 authority 경계를 문서화합니다.
- 정상 shutdown의 awaited bounded cleanup, crash/`SIGKILL` 잔여 한계, persisted cross-process reconciliation 부재와 구현되지 않은 lease/TTL·owner recovery 설계 선택지를 문서화합니다.

## v0.1.0 — 2026-07-25

- 초기 릴리스.
