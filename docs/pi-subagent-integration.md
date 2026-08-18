# `pi-subagent` presence projection

`pi-cmux-presence`는 `pi-subagent`를 import하거나 제어하지 않습니다. 두 package가 같은
Pi runtime에서 활성화되어 shared presence를 전달할 때만 이 optional consumer가
subagent 상태와 completion을 cmux에 투영합니다.

shared protocol, activation lifecycle, live terminal batching의 immutable 기준은 각각
[Protocol](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/protocol.md),
[Lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/lifecycle.md),
[Terminal batches](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/terminal-batch.md)입니다.

## cmux behavior

- Subagents 상태와 숫자 집계는 고정 local presentation으로만 표시합니다. task text,
  output, error, path, prompt, invocation ID와 session ID는 cmux로 보내지 않습니다.
- live completion은 기존 cmux notification/flash policy에 따라 한 번의 의미 있는
  attention으로 묶을 수 있습니다. cancellation과 retained replay는 status-only입니다.
  새 structured `failure` state와 같은 source/generation의 failed terminal이 짧은
  window 안에 함께 오면 한 alert로 합치며, terminal만 completion count를 정합니다.
  terminal 없는 failure와 `blocked` state는 각각 generic alert 하나를 유지합니다.
- retained projection이 철회되면 status를 clear하고 보류된 subagent aggregate를
  무효화합니다. 새 generic alert, feed 또는 producer 제어는 만들지 않습니다.
- 공식 cmux hook이 우선하면 buffered successful completion의 native
  notification/flash는 억제합니다. policy와 capability가 허용한 error projection은
  계속 한 번 보낼 수 있습니다.

## authority와 실패 격리

이 연동은 observer-only입니다. `pi-cmux-presence`는 subagent 실행·취소·retry,
scheduler/queue, lease, reaper, cleanup, 결과 반환, foreground/background handoff,
focus 추적 또는 Pi interactive lifecycle을 결정하지 않습니다. 그러한 authority는
`pi-subagent`에 남습니다.

공유 input 수락 거부, listener 오류, cmux capability 부재, socket 오류·시간 초과·큐
포화는 observer 출력만 유실시킬 수 있고 producer lifecycle에 전파되지 않습니다.
정확한 cmux policy와 channel gate는 [configuration](configuration.md)을 참고하세요.

이 저장소는 `bun run ci`로 consumer projection과 fake Unix socket 경로를 검증합니다.
실행 중인 `pi-subagent`의 load order, root aggregate/child `inherit` 공존, cmux 서버와의
live 동작 및 package 간 end-to-end parity는 검증하거나 주장하지 않습니다.
