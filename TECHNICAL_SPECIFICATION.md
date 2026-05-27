# Техническое задание: BizonVR Club Control

## 1. Назначение

Система предназначена для централизованного управления Meta Quest-шлемами в VR-клубах: сессии, карта клуба, запуск приложений, установка APK, трансляция через scrcpy, мониторинг и подписка.

## 2. Платформы MVP

- Шлемы: Meta Quest 2, Quest 3, Quest 3S, Quest Pro.
- Local Hub: Windows 10/11.
- Cloud: Linux server.
- Panel: desktop web.
- Quest Agent/Launcher: Android/Kotlin, без Unity.

## 3. Компоненты

### 3.1 Backend

Рекомендуемый стек: Django + DRF + PostgreSQL + Redis + Celery/Dramatiq + WebSocket.

Основные зоны ответственности:

- auth;
- organizations/clubs/branches;
- users/roles;
- rooms/map;
- devices;
- local hubs;
- device commands;
- sessions;
- app library;
- install jobs;
- monitoring;
- subscriptions;
- audit log.

### 3.2 Web Panel

Рекомендуемый стек: React + TypeScript + Tailwind + TanStack Query + Zustand.

Основные экраны:

- Dashboard;
- Club Map;
- Devices;
- Sessions;
- Apps Library;
- Install Jobs;
- Monitoring;
- Subscription;
- Settings.

### 3.3 Local Hub

Рекомендуемый стек: TypeScript + Electron/Tauri + SQLite.

Функции:

- авторизация в Cloud;
- привязка к филиалу;
- ADB device discovery;
- ADB command runner;
- scrcpy process manager;
- APK cache;
- install/uninstall/launch/stop;
- локальная очередь команд;
- heartbeat в Cloud;
- offline fallback для активных сессий.

### 3.4 Quest Agent / Club Launcher

Рекомендуемый стек: Kotlin + Android SDK.

Функции:

- pairing id;
- heartbeat;
- экран ожидания;
- таймер сессии;
- сообщения игроку;
- кнопка вызова оператора;
- список разрешённых игр;
- soft launcher mode.

Unity использовать запрещено.

## 4. Архитектура команд

Cloud не выполняет shell-команды и не подключается к Quest напрямую.

Цепочка:

```text
Web Panel -> Cloud API -> DeviceCommand -> Local Hub -> ADB/scrcpy/Quest Agent -> Quest
```

Команды должны быть типизированными:

- `PING`
- `REFRESH_STATUS`
- `INSTALL_APP`
- `UNINSTALL_APP`
- `LAUNCH_APP`
- `STOP_APP`
- `REBOOT_DEVICE`
- `OPEN_SCRCPY`
- `CLOSE_SCRCPY`
- `SHOW_MESSAGE`
- `START_SESSION`
- `END_SESSION`
- `OPEN_LAUNCHER`
- `RUN_DIAGNOSTICS`

Статусы команд:

- `created`
- `sent_to_hub`
- `accepted_by_hub`
- `running`
- `succeeded`
- `failed`
- `timeout`
- `cancelled`

## 5. Модель данных

Минимальные таблицы MVP:

- `organizations`
- `clubs`
- `branches`
- `users`
- `roles`
- `memberships`
- `rooms`
- `room_map_objects`
- `local_hubs`
- `devices`
- `device_status_snapshots`
- `device_commands`
- `apps`
- `app_versions`
- `app_packages`
- `app_package_items`
- `install_jobs`
- `sessions`
- `session_devices`
- `session_events`
- `monitoring_alerts`
- `subscriptions`
- `feature_flags`
- `audit_logs`

## 6. Устройство

Карточка устройства должна содержать:

- serial number;
- display name;
- model;
- room;
- map position;
- online/offline;
- ADB status;
- Agent status;
- IP;
- battery;
- charging status;
- Wi‑Fi SSID;
- storage free/total;
- current package;
- firmware version, если доступно;
- Agent version;
- last heartbeat;
- maintenance status.

Статусы:

- `new`
- `pairing_required`
- `online`
- `offline`
- `busy`
- `in_session`
- `installing`
- `updating`
- `maintenance_required`
- `charging_required`
- `error`
- `disabled`

## 7. Onboarding Quest

Шаги:

1. оператор подключает Quest по USB;
2. включает Developer Mode;
3. подтверждает USB debugging;
4. Local Hub видит устройство через `adb devices`;
5. Local Hub устанавливает Quest Agent;
6. устройство привязывается к клубу;
7. оператор задаёт имя, комнату и позицию на карте;
8. система запускает health-check;
9. устройство готово.

Для wireless-режима Local Hub может включать ADB over TCP/IP, если устройство это позволяет и уже авторизовано.

## 8. Режим сессии

### 8.1 Создание

Оператор выбирает:

- комнату;
- шлемы;
- игру;
- длительность;
- необходимость трансляции;
- комментарий.

### 8.2 Pre-flight check

Проверить:

- Local Hub online;
- device online;
- ADB available;
- Agent available;
- battery threshold;
- free storage threshold;
- app installed;
- app version;
- no active session conflict;
- scrcpy available, если выбрана трансляция.

### 8.3 Состояния сессии

- `draft`
- `preparing`
- `ready`
- `starting`
- `running`
- `paused`
- `extended`
- `finishing`
- `completed`
- `cancelled`
- `failed`

### 8.4 Во время сессии

Оператор может:

- продлить на 5/10/15/30 минут;
- открыть scrcpy;
- отправить сообщение;
- перезапустить игру;
- заменить шлем;
- завершить сессию;
- отметить проблему.

### 8.5 Завершение

При завершении:

1. остановить таймер;
2. закрыть игру;
3. открыть Club Launcher;
4. пометить устройства `available` или `maintenance_required`;
5. записать SessionEvent;
6. показать чеклист обслуживания.

## 9. Карта клуба

Карта должна поддерживать:

- комнаты;
- зоны;
- места шлемов;
- зону зарядки;
- склад;
- статус комнаты;
- live-таймер сессии;
- быстрые действия;
- редактор расположения.

Режимы:

- operator mode;
- edit mode;
- monitoring mode.

## 10. Мониторинг

Метрики:

- online/offline;
- battery;
- charging;
- storage;
- ADB;
- Agent;
- current app;
- app versions;
- scrcpy errors;
- install errors;
- Local Hub status.

Правила алертов:

- battery < 20% -> warning;
- battery < 10% -> critical;
- storage < 3 GB -> warning;
- storage < 1 GB -> critical;
- device offline during session -> critical;
- ADB unavailable -> warning;
- app missing before session -> blocker;
- Local Hub offline -> critical.

## 11. APK Library

### App

- name;
- package name;
- category;
- cover;
- description;
- compatibility.

### AppVersion

- version name;
- version code;
- APK file;
- size;
- checksum;
- changelog;
- status: draft/stable/deprecated.

### InstallJob

Статусы:

- `queued`
- `downloading`
- `installing`
- `verifying`
- `completed`
- `failed`
- `cancelled`

ADB-команды MVP:

- install: `adb install -r app.apk`
- uninstall: `adb uninstall package.name`
- launch: `adb shell monkey -p package.name 1` или `adb shell am start ...`
- stop: `adb shell am force-stop package.name`

Все команды выполнять через безопасный runner, без raw shell из UI.

## 12. scrcpy

MVP: Local Hub запускает scrcpy отдельным процессом.

Функции:

- open stream;
- close stream;
- track process;
- prevent duplicates;
- presets: low/standard/high;
- logs and error reporting.

Пример конфига:

```json
{
  "scrcpy": {
    "binaryPath": "scrcpy",
    "defaultPreset": "standard",
    "presets": {
      "low": ["--max-size", "1024", "--video-bit-rate", "4M"],
      "standard": ["--max-size", "1440", "--video-bit-rate", "8M"],
      "high": ["--max-size", "1920", "--video-bit-rate", "16M"]
    }
  }
}
```

Параметры нужно сверять с установленной версией scrcpy.

## 13. Подписка

Backend должен отдавать:

- active plan;
- device limit;
- branch limit;
- enabled features;
- trial status;
- grace period.

Фичи по тарифу:

- club map;
- bulk install;
- advanced monitoring;
- multi-branch;
- API;
- white-label launcher;
- auto updates;
- embedded streaming.

## 14. Безопасность

- JWT/session auth для панели.
- Отдельный токен для Local Hub.
- Pairing token для Quest Agent.
- RBAC по ролям.
- Проверка club/branch scope.
- Никаких произвольных shell-команд.
- Package name валидировать regexp.
- APK хранить с checksum.
- Audit log для критичных действий.
- Local Hub API только localhost или с авторизацией.

## 15. Acceptance Criteria MVP

### Devices

- Local Hub видит Quest через ADB.
- Устройство привязывается к клубу.
- Панель показывает устройство.
- Статус обновляется.
- Устройство можно назначить комнате.

### Sessions

- Можно создать сессию.
- Pre-flight check показывает ошибки.
- Игра запускается.
- Таймер работает.
- Сессию можно продлить и завершить.
- История сохраняется.

### scrcpy

- Трансляция открывается из панели.
- Local Hub запускает scrcpy.
- Ошибки видны оператору.

### APK

- APK загружается.
- Package/version извлекаются.
- InstallJob создаётся.
- Local Hub устанавливает APK.
- Статус установки виден.

### Map

- Можно создать комнату.
- Можно разместить шлем.
- Активная сессия видна на карте.
- Проблемы подсвечиваются.

### Subscription

- Есть тариф.
- Лимит устройств работает.
- Фичи блокируются по тарифу.
