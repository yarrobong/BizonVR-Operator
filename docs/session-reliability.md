# Session Engine reliability

## Фактическая схема

Операторский UI создаёт session в Cloud. Cloud в одной SQLite-транзакции
создаёт `sessions`, `session_devices` и отдельный `START_SESSION` command.
Local Hub получает command через durable claim/lease journal, проверяет identity
Quest, передаёт intent в `quest-agent-spatial-spike`, запускает игру через ADB и
проверяет foreground package. Результат возвращается в Cloud. Casting является
отдельным optional consumer и не меняет session lifecycle.

## State machine

Session statuses: `draft -> preparing -> starting -> running`, затем
`running <-> paused`, `running/paused -> extended`, и любое активное состояние
может перейти в `finishing`. Только подтверждённый cleanup переводит
`finishing -> completed`; failure cleanup переводит session в `failed`.
`completed`, `cancelled` и `failed` terminal и не могут быть resurrected обычным
heartbeat или command result.

`session_devices` хранит физический статус отдельно. Пока END_SESSION не
подтверждён, Quest остаётся занятым. Partial multi-device result не портит
соседние устройства: aggregate считается `running`, если хотя бы один player
работает, а device failure остаётся на его `session_devices`.

## Single active invariant

Migration `0006_session_reliability.sql` добавляет partial unique index
`uq_session_devices_one_active_per_device` для `preparing`, `ready`, `running` и
`paused`. `finishing` использует последний физический статус строки и поэтому
также удерживает Quest до cleanup. Preflight остаётся UX-проверкой, а index —
последним защитным уровнем от race.

## Timer model

Cloud — authoritative owner. Критическое время вычисляется из durable
`started_at`, `duration_minutes + extension_minutes`, `total_paused_seconds` и
`paused_remaining_seconds`; countdown не уменьшается несколькими серверами.
Quest Agent использует тот же timestamp model и сохраняет session id, revision,
start/pause timestamps в SharedPreferences. UI refresh только пересчитывает
представление. Auto-end принимает решение только Cloud scheduler; Agent может
локально остановить игру как fallback, но completion требует подтверждённого
END_SESSION/reconciliation.

## Commands and reconciliation

Каждая mutating action получает session/device revision и `operation_state`.
Start считается running только после Local Hub result или свежего heartbeat с
совпадающими `session_id`, revision и foreground package. Unknown result остаётся
unknown, а не превращается в false failure. Heartbeat со старым timestamp,
неверной session id, revision или app package игнорируется и не может вернуть
completed session в running.

Pause/resume сохраняют remaining snapshot; retry с тем же `Idempotency-Key`
возвращает существующий результат и не создаёт второй side effect. Extend
добавляет минуты один раз на ключ и отправляет `EXTEND_SESSION`, который только
синхронизирует Agent с новым durable state. Switch сначала помечает desired app
и требует успешной launch verification; при ошибке восстанавливается предыдущая
сессия. End переводит session в `finishing`, force-stops игру, запускает launcher
и только потом закрывает device/session.

## Restart/offline policy

- Cloud restart: file-backed SQLite сохраняет session, commands и revisions.
- Hub restart: command lease/journal восстанавливается; опасный side effect не
  replayed вслепую, сначала используется reconciliation.
- Short ADB/network outage: logical session и timer продолжаются; после return
  heartbeat/foreground приводят projection к reality.
- Quest reboot: session остаётся active/finishing в Cloud и получает
  `reconciliation_required`, если outcome неизвестен. После boot Agent heartbeat
  может reconcile matching session; при identity mismatch, отсутствующем app или
  сброшенном wireless debugging нужен оператор. Автовозобновление без matching
  session identity не выполняется.
- Expiry while offline: session остаётся `finishing` до физического cleanup;
  false `completed` не создаётся.
- Cast crash/viewer disconnect: session не меняется.

## Observability

Важные transition и recovery events пишутся в `session_events` и audit log.
Команда содержит correlation `session_id`, target identity, outcome state и
durable result. В UI состояния отображаются как Preparing, Starting, Running,
Paused, Reconnecting, Ending, Cleanup required и Result unknown/checking.

## Hardware validation

Code-level fault tests находятся в `tests/session-reliability.test.ts`.
Hardware orchestrator — `scripts/session-hardware-soak.js`; он намеренно
помечает результат `NOT RUN`, если не указаны реальные Cloud API, Local Hub и
Quest. Полный ручной сценарий с физическим Quest описан в
`docs/session-hardware-test-plan.md`. Production READY нельзя объявлять по
одному только fake-ADB прогону.
