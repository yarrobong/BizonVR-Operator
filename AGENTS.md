# AGENTS.md

Инструкции для Codex/AI-агента, работающего над проектом **BizonVR Club Control**.

## 1. Контекст

Проект — подписочная система управления Meta Quest-шлемами для VR-клубов.

Обязательные решения:

- MVP только для Meta Quest.
- Трансляция через scrcpy.
- Управление через Local Hub + ADB.
- На шлем ставится Quest Agent APK.
- Club Launcher делается без Unity.
- Главный модуль — мощный режим сессий.
- Карта клуба обязательна.
- Мониторинг обязательный.
- Подписочная модель обязательна.

## 2. Главный принцип

Не делать абстрактную MDM-систему. Делать рабочий инструмент для оператора VR-клуба.

Любая функция должна отвечать на вопрос:

> Помогает ли это быстрее и надёжнее запустить/провести/завершить VR-сессию?

## 3. Архитектура

Правильная цепочка:

```text
Web Panel -> Cloud API -> DeviceCommand -> Local Hub -> ADB/scrcpy/Quest Agent -> Quest
```

Cloud не выполняет ADB/scrcpy и не подключается к Quest напрямую.

## 4. Запрещено

- Добавлять Unity в Quest Agent/Launcher.
- Делать прямое Cloud-to-Quest управление.
- Выполнять raw shell из UI.
- Делать endpoint `/run-shell`.
- Передавать произвольные команды из Cloud в Local Hub.
- Игнорировать подписочные лимиты.
- Хранить APK без checksum.
- Скрывать ошибки установки/scrcpy.
- Добавлять Pico в MVP без отдельной задачи.
- Обещать полный kiosk mode без проверки технических условий.

## 5. Backend правила

### Основные домены

- accounts;
- clubs;
- branches;
- rooms;
- devices;
- local_hubs;
- commands;
- sessions;
- apps_library;
- monitoring;
- subscriptions;
- audit.

### DeviceCommand

Команды должны быть отдельной сущностью.

Поля:

- id;
- club;
- branch;
- local_hub;
- device;
- type;
- payload;
- status;
- created_by;
- created_at;
- accepted_at;
- started_at;
- finished_at;
- error_code;
- error_message;
- retry_count.

Статусы:

- created;
- sent_to_hub;
- accepted_by_hub;
- running;
- succeeded;
- failed;
- timeout;
- cancelled.

### Permissions

Проверять:

- роль;
- club scope;
- branch scope;
- subscription features;
- device limit;
- право на APK upload;
- право на технические команды.

## 6. Frontend правила

Главный экран оператора — карта клуба.

На ней должны быть:

- комнаты;
- устройства;
- активные сессии;
- оставшееся время;
- заряд;
- проблемы;
- быстрые действия.

Для каждого экрана нужны состояния:

- loading;
- empty;
- error;
- permission denied;
- subscription blocked;
- partial offline.

Ошибки должны объяснять, что делать дальше.

## 7. Local Hub правила

Local Hub отвечает за:

- ADB discovery;
- ADB connect;
- APK install/uninstall;
- app launch/force-stop;
- scrcpy process management;
- local cache;
- command sync;
- status polling;
- offline fallback.

### Безопасный process runner

Плохо:

```ts
exec(`adb shell ${userInput}`)
```

Хорошо:

```ts
spawn(adbPath, ["-s", serial, "shell", "am", "force-stop", packageName])
```

`packageName` валидировать:

```text
^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$
```

## 8. Quest Agent правила

Quest Agent/Launcher:

- Kotlin/Java;
- Android SDK;
- без Unity;
- heartbeat;
- pairing id;
- экран ожидания;
- таймер сессии;
- сообщения игроку;
- кнопка вызова оператора;
- soft launcher mode.

Не писать “полная блокировка”, если kiosk/managed mode не активирован.

### Quest / ADB Stability Rules

- Production Quest app is `quest-agent-spatial-spike`.
- Heartbeat loop must have exactly one owner.
- `SpatialSpikeActivity` may persist config and start `HeartbeatForegroundService`, but must not create a second heartbeat loop when the service already owns heartbeat delivery.
- `HeartbeatForegroundService` is the single production heartbeat source and must guard against duplicate loop starts.
- `local_ip` in heartbeat must come from the active Wi-Fi network via Android networking APIs, not from the first non-loopback interface.
- If active Wi-Fi IPv4 cannot be resolved, send `null`/empty `local_ip` and log a warning instead of guessing from another interface.
- IP address is not device identity.
- Keep `stable_id`, `agent_id`, and `android_id` separate from USB/Wi-Fi routes.
- Route is not usable until `adb -s <route> get-state` returns `device`.
- Normal control should prefer verified Wi-Fi ADB after pairing; install/repair/first-pair should prefer verified USB.

## 9. Session mode правила

Сессия — главный домен.

Статусы:

- draft;
- preparing;
- ready;
- starting;
- running;
- paused;
- extended;
- finishing;
- completed;
- cancelled;
- failed.

Перед стартом проверять:

- Local Hub online;
- device online;
- ADB available;
- Agent available;
- battery;
- storage;
- app installed;
- app version;
- no active session conflict.

При завершении:

- остановить таймер;
- закрыть игру;
- открыть Club Launcher;
- создать SessionEvent;
- показать чеклист обслуживания.

## 10. Monitoring правила

Severity:

- info;
- warning;
- critical;
- blocker.

Алерты:

- battery low;
- storage low;
- device offline;
- ADB unavailable;
- Agent unavailable;
- scrcpy failed;
- install failed;
- app missing;
- Local Hub offline.

## 11. Testing

Покрыть тестами:

- permissions;
- command status transitions;
- session lifecycle;
- subscription limits;
- install job lifecycle;
- audit logging;
- packageName validation;
- Local Hub command handlers.

## 12. Definition of Done

Задача готова, если:

1. Код реализован.
2. Есть миграции, если менялась БД.
3. Есть тесты критичной логики.
4. Нет raw shell из UI.
5. Ошибки видны оператору.
6. Учтены роли и тарифы.
7. Есть audit log для важных действий.
8. Обновлена документация.
9. Проверен happy path.
10. Проверен failure path.

## 13. Quest / ADB Stability Rules

- Production Quest app is `quest-agent-spatial-spike`.
- Do not reintroduce `quest-agent` as the default production app unless explicitly requested.
- Do not use IP address as device identity.
- Keep `stable_id` / `agent_id` / `android_id` separate from routes.
- ADB is a recovery/debug/control transport, not the primary online signal.
- Quest Agent heartbeat is the primary online signal.
- Never mark the whole device offline only because `adb_status` is offline while `agent_status` is online.
- Never pass `127.0.0.1` as `HUB_IP` to Quest Agent for production Wi-Fi heartbeat.
- Always pass real LAN `HUB_HOST`/`HUB_PORT` to Quest Agent.
- Quest Agent must persist `HUB_IP`/`HUB_PORT` and reuse them after reboot.
- All ADB commands must use `adb -s <route>` when more than one device/route exists.
- Do not create duplicate devices when route changes from USB serial to `ip:5555`.
- Do not create duplicate devices when Quest IP changes.
- Do not rely on `adb reverse` for Wi-Fi heartbeat.
- Cloud API must not directly control Quest over ADB.
- Local Hub is the only component allowed to run ADB commands.
- Add tests when changing routing, heartbeat, identity, or reconnect logic.
