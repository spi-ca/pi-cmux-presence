# `pi-subagent` generic producer 계약·예시

## 범위

이 문서는 `pi-cmux-presence`가 소비하는 **generic producer 계약**과 `pi-subagent`에 적용할 수 있는 예시를 설명합니다. 이 저장소는 `pi-subagent`를 import하거나 dependency로 선언하지 않으며, 외부 패키지의 현재 구현·production entrypoint·동작 parity를 검증하거나 단정하지 않습니다. 두 패키지를 함께 쓸 때의 기대 계약은 [이벤트 계약](event-contract.md)뿐입니다.

이 계약을 채택하는 producer는 Pi의 같은 프로세스 event bus에서 현재 `sessionId`, 자신이 소유한 `generation`·단조 증가 `sequence`, 비예약 `source.id`, state/count를 넣어 발행합니다. 선택 `progress`, `usage`, `attention`은 실제로 제공할 수 있는 경우에만 포함합니다. consumer는 source별 fence와 [이벤트 계약](event-contract.md)에 정의된 source 상한을 적용하며 `pi`·`pi-todo` 예약 source는 외부 입력으로 수락하지 않습니다.

```ts
pi.events.emit("pi-presence:update:v1", {
  version: 1,
  sessionId,
  generation,
  sequence: ++sequence,
  source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
  state: "running",
  counts: { active, completed, failed, queued, cancelled, total },
  // 실제 producer progress가 있을 때만 포함
  progress: { value: completed / total },
});
```

`waiting`과 가산 `queued`/`cancelled`/`total`은 scheduler 집계를 표현할 수 있습니다. count는 각각 0–1,000,000이어야 하며 consumer가 상관관계나 progress를 추정하지 않습니다. `total`이 0인 경우 producer는 progress를 생략해야 합니다. 예시의 `source.id: "pi-subagent"`는 선택일 뿐, consumer가 특정 외부 package를 특별 취급하지는 않습니다.

## ready와 재발행

presence consumer는 session start 뒤 `pi-presence:ready:v1`으로 `cmux-status`, `cmux-progress`, `cmux-attention` capability를 광고합니다. ready는 consumer UI capability와 replay 요청일 뿐 producer의 실행 권한을 바꾸지 않습니다.

이 계약을 구현하는 producer는 matching `sessionId`의 ready를 받으면 현재 보유 summary를 새 sequence로 다시 발행할 수 있습니다. 재발행은 `attention: "none"`으로 하여 이전 완료 알림을 되풀이하지 않는 것이 권장됩니다. event는 durable하지 않으므로 reload, consumer 재시작, session 경계에서 producer가 상태 표시 연속성을 원하면 이 재발행 경로가 필요합니다.

## lifecycle authority 경계

이 연동은 observer 데이터 흐름입니다. `pi-cmux-presence`는 다음을 하지 않으며 generic producer가 이를 요청해서도 안 됩니다.

- subagent 실행·취소·retry·scheduler/queue·lease·reaper·cleanup 결정
- foreground/background 또는 detached target의 소유·전환
- invocation 결과 반환, Pi interactive lifecycle 변경, resume 정책 결정
- producer state를 보고 terminal action을 실행하거나 state를 교정

그 authority는 producer를 소유한 외부 패키지에 남습니다. presence consumer는 수락된 payload를 축약 status/progress/attention으로 best-effort 렌더링할 뿐입니다. socket 실패, validation 거부, capability 부재는 producer lifecycle을 실패시키지 않아야 합니다.

## `pi-cmux`와의 기대 계약·비목표

`pi-subagent`가 이 계약을 채택한다면 기대되는 범위는 `pi-cmux-presence`가 소비하는 V1 summary의 state, 필수/가산 counts, 실제 progress, attention, ready replay입니다. wire schema는 usage도 허용하지만, 어떤 외부 producer가 이를 발행하는지는 이 저장소에서 검증하지 않습니다. 같은 summary를 생산한다고 해서 별도 `pi-cmux` UX, native cmux CLI dashboard 또는 그 고유 event contract와 동작·표시·설정이 같다는 뜻은 아닙니다.

특히 이 연동의 비목표는 다음과 같습니다.

- `pi-cmux` 패키지를 설치·로드·설정하거나 그 API를 호출하는 것
- native dashboard event를 이름만 바꾸어 무검증으로 전달하는 것
- task/prompt/raw output/cwd/credential/private target ID를 presence event로 복사하는 것
- public summary에 없는 progress·token·cost·context를 합성하는 것
- presence observer에 lifecycle authority를 이전하거나 자동 action을 부여하는 것

이 계약은 외부 producer가 cmux CLI나 presence socket을 직접 호출하지 않을 것을 요구하지도, 반대로 호출한다고 가정하지도 않습니다. 같은 process에서 별도 consumer나 `pi-cmux`를 함께 설치할 때의 중복 출력 방지는 운영자가 각 consumer의 설정으로 관리해야 합니다. 이 문서는 외부 구현과의 live parity를 주장하지 않습니다.

## 개인정보와 출력

producer public payload에는 짧은 source label/state/count와 선택 수치만 넣어야 합니다. 문자열은 1–96 Unicode code points의 safe text여야 하며 task 제목·설명, prompt, output, 경로, credential, private target ID를 넣어서는 안 됩니다. consumer는 `source.label`과 `progress.label`을 형식 검증하고 목적지 한도로 축약하지만 의미 기반 redaction은 하지 않으므로, 계약을 지키지 않은 외부 label은 cmux에 표시될 수 있습니다.

cmux output은 설정과 capability를 다시 통과합니다. `PI_CMUX_PRESENCE_PROGRESS`가 꺼져 있으면 초기·종료 clear를 포함해 workspace progress를 전혀 변경하지 않고, attention은 log/notification/flash flag 및 V2 capability에 따라 다르게 생략될 수 있습니다. todo source가 progress를 제공하면 deterministic todo-first 규칙 때문에 일반 subagent progress보다 우선합니다.

## 확인 범위

이 저장소에서는 다음만 검증합니다.

```bash
bun run ci
```

이는 contract parser, fence, ready replay, rendering과 fake socket 경로의 자동 검증입니다. 실행 중인 `pi-subagent`, `pi-cmux`, cmux 서버를 함께 연결한 live 동작, 외부 producer의 현재 구현, 또는 패키지 간 end-to-end parity는 이 저장소에서 검증하거나 주장하지 않습니다.
