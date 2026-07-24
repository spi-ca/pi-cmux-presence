# `pi-presence:update:v1` 이벤트 계약

이 채널은 같은 Pi 프로세스 event bus의 선택적 presence 입력입니다. durable transport나 cross-process API가 아니며 reload/세션 종료 후 생산자는 필요하면 현재 상태를 다시 발행해야 합니다.

![ready 광고부터 엄격한 update 검증, retained 상태 렌더링과 session teardown까지의 이벤트 흐름](diagram/event-flow.svg)

이 이미지는 흐름 개요이며, 아래의 세부 계약을 대체하지 않습니다. Mermaid 원본: [`diagram/event-flow.mmd`](diagram/event-flow.mmd)

## 엄격한 V1 객체

payload와 중첩 객체에는 다음 키 외의 키를 넣을 수 없습니다. 모든 문자열(`sessionId`, `source.id`, `source.label`, `source.kind`, 선택 `progress.label`)은 1–96 Unicode code points이고 C0/C1 control, bidi·방향성 제어 문자를 포함할 수 없습니다.

```ts
{
  version: 1,
  sessionId: string,
  generation: number,
  sequence: number,
  source: { id: string, label: string, kind: string },
  state: "idle" | "waiting" | "running" | "success" | "error" | "cancelled",
  counts: {
    active: number,
    completed: number,
    failed: number,
    queued?: number,
    cancelled?: number,
    total?: number,
  },
  progress?: { value: number, label?: string },
  usage?: { tokens?: number, cost?: number, contextPercent?: number },
  attention?: "none" | "info" | "success" | "error",
}
```

| 필드 | 조건 |
| --- | --- |
| `version` | 정확히 `1` |
| `generation` | 안전한 정수 0–`Number.MAX_SAFE_INTEGER` |
| `sequence` | 안전한 정수 1–`Number.MAX_SAFE_INTEGER` |
| `counts.active/completed/failed` | 필수, 각각 안전한 정수 0–1,000,000 |
| `counts.queued/cancelled/total` | 선택·가산 필드, 있으면 각각 안전한 정수 0–1,000,000 |
| `progress.value` | finite number 0–1 |
| `usage.tokens`, `usage.cost` | 각각 finite number 0–1e12 |
| `usage.contextPercent` | finite number 0–100 |
| `attention` | 생략하거나 `none`/`info`/`success`/`error` |

가산 count는 기존 필수 count의 의미를 바꾸지 않습니다. 예를 들어 `waiting`은 producer가 대기 중임을 표현할 수 있고, `queued`·`cancelled`·`total`은 상태 문자열·meta 집계에 선택적으로 반영됩니다. consumer는 이 수치들 사이의 산술 관계를 강제하지 않습니다.

## 순서, 예약 source, 신뢰 경계

consumer는 host가 제공한 session ID도 같은 1–96 Unicode code points safe text 규칙으로 먼저 검증합니다. 누락·조회 오류·범위 위반이면 lifecycle handler에서 예외를 전파하지 않고 해당 presence 세션을 fail-closed로 비활성화합니다. consumer는 현재 세션과 다른 `sessionId`를 무시합니다. source별 마지막 `(generation, sequence)`를 저장하며 낮은 generation 또는 같은 generation의 같거나 낮은 sequence를 거부합니다. 높은 generation은 그 source의 sequence fence만 다시 시작합니다. generation은 consumer가 아닌 producer가 소유합니다. 세션당 서로 다른 source는 최대 64개입니다.

`source.id: "pi"`는 내장 Pi lifecycle producer, `source.id: "pi-todo"`는 내장 todo adapter의 예약값입니다. 외부 event bus payload가 이 둘을 쓰면 무시됩니다. payload는 신뢰할 수 없는 구조화 입력으로 파싱·키·범위 검사를 통과해야 합니다. 생산자는 label, 수치와 attention에 비밀 또는 신뢰할 수 없는 원문을 넣지 않아야 합니다. consumer의 label 처리는 구조·control/bidi·길이 검증과 목적지별 축약이지 의미 기반 redaction이 아닙니다.

수락된 update는 해당 `source.id`의 retained 상태를 **대체**합니다. V1에는 외부 source를 명시적으로 삭제하는 이벤트가 없습니다. 따라서 외부 producer가 terminal update를 발행해도 그 source의 마지막 상태는 session teardown까지 retained될 수 있습니다. 새 세션 시작 또는 session shutdown의 teardown은 retained source의 소유 status를 정리합니다.

## progress 선택과 상태 표시

cmux에는 전역 progress 슬롯 하나만 있습니다. `pi-todo`가 progress를 제공하면 state가 terminal이거나 value가 `1`이어도 그 todo가 최우선이며, 다음 todo update 또는 todo가 사라질 때까지 표시합니다. 그 외에는 `running` 또는 `waiting`이고 progress를 제공한 source 중 `source.id` 사전순 첫 항목을 선택합니다. 따라서 결과는 결정적이지만, source별 독립 progress bar는 없습니다.

각 source status는 SHA-256 기반 키로 기록됩니다. `set_status`는 workspace `--tab`과 surface `--panel`을 지정하며, 스타일은 `idle` gray/circle/priority 10, `waiting` amber/clock/20, `running` blue/play/30, `success` green/check/20, `error` red/x/40, `cancelled` gray/minus/20입니다.

`attention: "info" | "success" | "error"`는 log/notification/flash 요청입니다. 각각 `PI_CMUX_PRESENCE_LOG`, `PI_CMUX_PRESENCE_NOTIFICATIONS`, `PI_CMUX_PRESENCE_FLASH`와 필요한 V2 capability가 함께 충족될 때만 전송됩니다. `none` 또는 생략은 요청하지 않습니다.

`PI_CMUX_PRESENCE_FINAL_CLEAR_MS`는 내장 `pi` source의 `agent_settled` 뒤 최종 status를 지우기까지의 대기 시간만 제어합니다. 이 타이머는 외부 source의 retained 상태를 지우지 않으며, 외부 상태는 위의 session teardown까지 남을 수 있습니다.

## ready 광고와 재발행

consumer는 session 시작 뒤 `pi-presence:ready:v1`을 발행합니다.

```ts
{
  version: 1,
  sessionId: string,
  consumer?: {
    id: string,             // 1–96 Unicode code points safe text
    capabilities: string[], // 각 safe text, 최대 16개
  },
}
```

현재 consumer advertisement는 `id: "pi-cmux-presence"`, capabilities `cmux-status`, `cmux-progress`, `cmux-attention`입니다. ready는 capability 힌트와 재발행 요청일 뿐 authority를 위임하지 않습니다. 내장 `pi`와 `pi-todo`는 matching session ready를 받으면 retained state를 새 sequence 및 `attention: "none"`으로 replay합니다. 일반 producer도 필요하면 자신의 상태를 새 sequence로 재발행할 수 있습니다.

## RPIV todo 진행률

내장 `pi-todo` adapter는 성공한 `todo` tool result의 RPIV `TaskDetails` envelope만 다룹니다. `pi.getAllTools()`에서 정확히 하나인 `todo`의 `sourceInfo.path/source/scope/origin` 조합을 provenance로 고정하고, 이후 동일 provenance가 아니면 거부합니다. task는 최대 256개이며 `pending`, `in_progress`, `completed`, `deleted` 상태와 고유 양의 ID만 받아들입니다. ID 고유성은 visibility와 무관하게 deleted task를 포함한 전체 배열에서 검사합니다.

`deleted` task는 ID 검증 뒤 visible total과 모든 count에서 제외됩니다. `in_progress`는 `active`, `completed`는 `completed`, 나머지 visible pending은 `queued`가 됩니다. visible task가 없으면 `idle`, active가 있으면 `running`, 모두 completed면 `success`, 그 외에는 `waiting`입니다. visible task가 있을 때만 `completed / visible` progress를 만듭니다.

adapter는 task `content`, `subject`, `title`, `description`, `activeForm`, metadata와 tool result text를 읽거나 보관하거나 event payload에 복사하지 않습니다. 따라서 todo progress는 count와 비텍스트 state만 보이며 task 내용은 cmux로 전송되지 않습니다.

## 일반 생산자 예시

```ts
pi.events.emit("pi-presence:update:v1", {
  version: 1,
  sessionId: ctx.sessionManager.getSessionId(),
  generation: 1,
  sequence: 3,
  source: { id: "indexer", label: "Indexer", kind: "background" },
  state: "waiting",
  counts: { active: 0, completed: 12, failed: 0, queued: 2, total: 14 },
  attention: "info",
});
```

`progress`·`usage`는 producer가 실제로 제공할 때만 넣습니다. consumer는 이를 추정하거나 특정 외부 producer를 특별 취급하지 않습니다.
