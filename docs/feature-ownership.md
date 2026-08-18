# 기능 경계와 `pi-cmux` 비교

`pi-cmux-presence`는 Unix socket으로 cmux에 local presence를 투영하는 observer입니다.
선택적으로 `pi-subagent`와 같은 producer가 같은 Pi runtime에서 shared presence를
발행할 수 있지만, 이 패키지는 그 producer를 import·실행·제어하지 않습니다.

공유 presence protocol과 lifecycle의 canonical 기준은 고정 tag의
[Protocol](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/protocol.md),
[Lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/lifecycle.md),
[Terminal batches](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/terminal-batch.md)입니다.

## 구현 범위

| 기능 | `pi-cmux-presence` 책임 | 경계 |
| --- | --- | --- |
| 부모 Pi 상태·usage | lifecycle/usage를 fixed local summary로 surface status에 표시 | assistant body, prompt, path, tool content는 전송하지 않음 |
| todo 진행률 | 검증한 todo 결과의 count와 progress를 표시 | task text를 전송하지 않음 |
| 선택 producer 표시 | shared presence를 fixed local vocabulary와 numeric summary로 투영 | producer package의 실행 dependency나 lifecycle authority 없음 |
| subagent completion | live completion을 cmux attention policy로 의미 있게 묶음 | cancellation은 quiet, producer result·cleanup은 producer 소유 |
| input-required 표시 | 고정 `Pi needs your input` presentation | 모든 Pi input wait를 추론하거나 제어하지 않음 |
| 알림·flash·log | official hook 우선 뒤 child-profile suppression, kill switch, policy, capability로 gate | cmux notification 보존과 focused-banner 표시는 cmux 소유 |
| Pi PID/lifecycle, feed, metadata, title, resume | 공식 hook 부재 시 문서화된 opt-in fallback 제공 | 직접 cmux mutation을 producer에 요구하지 않음 |

shared protocol의 validation, retention, delivery, replay, ordering과 source lifecycle은
`@pi/presence`의 책임입니다. 이 consumer는 유효한 input을 cmux UI로 렌더링할 뿐,
producer의 execution, cancellation, retry, scheduler, lease, reaper, result collection,
foreground/background handoff 또는 cleanup authority를 얻지 않습니다.

## `pi-cmux` 비교

| `pi-cmux` 기능군 | 이 저장소의 범위 | 비고 |
| --- | --- | --- |
| Pi status, token/cost, completion attention | 관련 관찰 출력 제공 | Unix socket 사용 |
| subagent 부모 집계 | completion을 consumer policy로 표시 | task/output text를 사용하지 않음 |
| heuristic turn/tool progress | 의도적으로 제외 | local todo와 shared numeric progress만 표시 |
| split/tab 생성, 임의 command 실행 | 미지원 | presence observer 범위 밖 |
| `/cmv`, `/cmh`, `/cmo`, `/cmt` | 미지원 | `pi-cmux`를 별도 유지할 때만 사용 |
| tool/file별 상세 sidebar log | 부분 지원 | attention log만 제공; raw 도구 인수·출력은 제외 |
| permission/input-needed 상태 | 제한된 input-required 표시 | 모든 Pi input wait를 추론하거나 제어하지 않음 |
| notification history 읽기·mark-read·jump | 미지원 | 생성만 담당; cmux notification center 소유 |
| focus 기반 attention suppress | 미지원 | 신뢰할 수 있는 read-only focus capability가 없음 |

`pi-cmux`의 command/workflow가 필요하면 해당 package를 선택적으로 함께 둘 수 있습니다.
status/sidebar/notification 기능은 한쪽만 활성화해 중복을 피합니다.
