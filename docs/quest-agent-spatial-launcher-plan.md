# Quest Agent Spatial Launcher Plan

> Historical document. Current production Quest app is `quest-agent-spatial-spike` (`com.bizonvr.spatialspike`).
> Do not use the older `quest-agent` or `.MainActivity` alias as the default production launch path unless explicitly requested.

## 1. Audit summary

Дата аудита: 2026-05-26

Исходный `quest-agent` до spatial migration:

- Gradle wrapper: `9.0.0` (`quest-agent/gradle/wrapper/gradle-wrapper.properties`)
- Android Gradle Plugin: `8.13.2` (`quest-agent/build.gradle`)
- Kotlin Android plugin: `1.9.24` (`quest-agent/build.gradle`)
- `compileSdk 34`
- `minSdk 29`
- `targetSdk 32`
- UI: обычная `AppCompatActivity` + XML (`src/main/res/layout/activity_main.xml`)
- Основная логика агента раньше была собрана в `src/main/java/com/bizonvr/questagent/MainActivity.kt`

Что было подготовлено в этом change set:

- логика heartbeat/session state вынесена из `MainActivity.kt` в общий слой;
- текущий 2D XML launcher сохранён как рабочий fallback;
- `START/STOP`, heartbeat, `launchGame()` и `call operator` теперь опираются на переиспользуемые классы, а не на прямой UI-код.
- после toolchain spike immersive launcher перенесён обратно в основной `quest-agent` как второй entrypoint.

Новые общие классы:

- `quest-agent/src/main/java/com/bizonvr/questagent/AgentSessionController.kt`
- `quest-agent/src/main/java/com/bizonvr/questagent/AgentHeartbeatClient.kt`
- `quest-agent/src/main/java/com/bizonvr/questagent/LauncherState.kt`
- `quest-agent/src/main/java/com/bizonvr/questagent/LauncherUiState.kt`
- `quest-agent/src/main/java/com/bizonvr/questagent/QuestAppLauncher.kt`

## 2. Official Meta path for Spatial / immersive apps

Официальный рекомендуемый путь для Kotlin/Android приложения под Meta Quest сейчас идёт через Meta Spatial SDK, а не через XML `Activity`.

Опорные официальные источники:

- Meta Spatial SDK Samples repository:
  [Meta-Spatial-SDK-Samples](https://github.com/meta-quest/Meta-Spatial-SDK-Samples)
- Пример `HybridSample`:
  [HybridSampleActivity.kt](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/HybridSample/app/src/main/java/com/meta/spatial/samples/hybridsample/HybridSampleActivity.kt)
- Пример manifest для immersive + panel:
  [HybridSample AndroidManifest.xml](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/HybridSample/app/src/main/AndroidManifest.xml)
- Версии из официального sample:
  [libs.versions.toml](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/HybridSample/gradle/libs.versions.toml)

Из этих источников видно, что Meta рекомендует:

- `com.meta.spatial.plugin`
- `AppSystemActivity`
- `VRFeature(this)`
- `ComposeFeature()`
- `registerPanels() + composePanel { }`
- manifest c `horizonos:uses-horizonos-sdk`
- Horizon OS / Quest-specific manifest features and native library declarations
- Compose-панель как floating surface внутри immersive/VR shell

То есть правильная форма POC для Variant 2:

- immersive activity на базе `AppSystemActivity`;
- отдельная floating 16:9 panel;
- UI панели лучше строить через Compose;
- текущий XML launcher должен остаться отдельным fallback.

## 3. Current status after toolchain spike

Короткий ответ для исходного состояния был: не в старом toolchain без отдельного migration spike.

После отдельного spike это ограничение снято. Spatial SDK уже подключён в основной `quest-agent`, но через выровненный toolchain, близкий к рабочему standalone sample.

Текущее состояние:

- один APK `quest-agent`;
- `MainActivity` оставлен как 2D fallback;
- `SpatialLauncherActivity` добавлен как immersive entrypoint;
- по умолчанию launcher intent теперь ведёт в `SpatialLauncherActivity`;
- shared business logic используется и 2D, и spatial UI.

Обновлённый рабочий stack в `quest-agent`:

- Gradle wrapper: `9.4.1`
- Android Gradle Plugin: `8.5.0`
- Kotlin plugin: `2.1.0`
- Compose compiler plugin: `2.1.0`
- Meta Spatial SDK: `0.13.0`
- `compileSdk = 34`
- `minSdk = 34`
- `targetSdk = 34`
- Java/Kotlin target: `17`

Что было проверено в migration path:

1. Исходная сборка старого `quest-agent` проходила, но direct Spatial integration падала на `:compileDebugKotlin`.
2. Отдельный standalone spike позволил сузить конфликт toolchain.
3. После выравнивания Kotlin compiler artifacts и переноса stack в основной `quest-agent` сборка начала проходить.
4. `SpatialLauncherActivity` собирается, ставится на Quest и запускается как immersive shell.

Исторический blocker был такой:

```text
Execution failed for task ':compileDebugKotlin'.
Could not isolate value ... GradleKotlinCompilerWorkParameters
Could not serialize value of type GradleKotlinCompilerWorkArguments
```

Практический вывод из spike:

- исходный стек `Gradle 9.0.0 + AGP 8.13.2 + Kotlin 1.9.24` не дал безопасно подключить Meta Spatial SDK;
- controlled spike был обязателен;
- после spike Spatial SDK уже подключён в основном APK, а проект остаётся собираемым.

## 4. Minimal safe migration plan

Этот раздел сохраняется как история того, как migration делался поэтапно. По состоянию на сейчас шаги 1-6 уже выполнены.

Рекомендованный порядок миграции:

1. Создать отдельную spike-ветку для Spatial integration.
2. Выравнять build toolchain под supported/sample-like стек Meta Spatial SDK.
3. Только после успешной пустой immersive activity переносить launcher UI.

Минимальный безопасный план миграции:

1. Проверить совместимую матрицу версий на spike-ветке.
   Кандидат A: оставить AGP свежим, но опустить Gradle wrapper до ветки `8.x`, если Meta plugin реально конфликтует с `Gradle 9`.
   Кандидат B: выровнять стек ближе к official sample:
   - AGP `8.5.0`
   - Kotlin `2.1.0`
   - Compose plugin `2.1.0`
   - Meta Spatial SDK `0.13.0`
2. Поднять `minSdk`/`targetSdk` до Quest/Horizon-совместимого уровня, который ожидает Spatial SDK sample.
3. Добавить в manifest:
   - `xmlns:horizonos`
   - `horizonos:uses-horizonos-sdk`
   - `uses-native-library libossdk.oculus.so`
   - Quest/Horizon OS feature flags
4. Добавить пустую `SpatialLauncherActivity : AppSystemActivity`.
5. Добиться сборки и запуска с одним пустым floating panel.
6. Только затем подключать launcher UI и общий `AgentSessionController`.

Файлы, которые нужно будет обновить в spike:

- `quest-agent/build.gradle`
- `quest-agent/settings.gradle`
- `quest-agent/gradle/wrapper/gradle-wrapper.properties`
- `quest-agent/src/main/AndroidManifest.xml`
- `quest-agent/src/main/java/com/bizonvr/questagent/SpatialLauncherActivity.kt`
- при необходимости новые Compose/spatial UI файлы

## 5. Historical deployment model

Этот раздел описывает устаревший `quest-agent` path до выбора production-приложения.

Исторически в проекте был один APK `quest-agent` с двумя entrypoint:

- legacy 2D fallback activity
  2D fallback launcher на XML
- legacy spatial launcher activity
  immersive VR/spatial launcher на Meta Spatial SDK

Intent model:

- default launcher intent открывает `SpatialLauncherActivity`;
- fallback можно было открыть явно через legacy action;
- spatial entrypoint можно было открыть явно через legacy action.

Production path now is `com.bizonvr.spatialspike/.SpatialSpikeActivity` from `quest-agent-spatial-spike`.

## 6. Target architecture

Нужно разделить текущий `MainActivity.kt` на следующие части:

### `AgentSessionController`

Отвечает за:

- приём `SESSION_ACTION START/STOP`;
- переходы `WAITING -> STARTING -> ACTIVE -> FIVE_MIN_WARN -> FINISHED/ERROR`;
- heartbeat tick;
- таймер сессии;
- авто-завершение;
- вызов callback на `launchGame()` и `openLauncher()`.

### `AgentHeartbeatClient`

Отвечает только за сеть:

- `POST /api/agent/heartbeat`
- `POST /api/agent/call_operator`

UI не должен напрямую собирать HTTP-запросы.

### `LauncherState`

Остаётся единственным enum для launcher-состояния:

- `WAITING`
- `STARTING`
- `ACTIVE`
- `FIVE_MIN_WARN`
- `FINISHED`
- `ERROR`

### `LauncherViewModel` или аналог

В текущем change set роль аналога ViewModel выполняет `LauncherUiState` + `StateFlow` из `AgentSessionController`.

Если позже понадобится полноценный Android `ViewModel`, он должен:

- подписываться на `AgentSessionController`;
- пробрасывать `uiState` для Compose/XML;
- не содержать сетевую и ADB/game-launch логику.

### `Android2DFallbackActivity`

Практически это текущий `MainActivity`.

Его задача:

- отображать XML fallback UI;
- подписываться на общий `LauncherUiState`;
- вызывать `sessionController.callOperator()`;
- использовать общий `QuestAppLauncher`.

### `SpatialLauncherActivity / SpatialScene`

Будущая immersive activity:

- наследуется от `AppSystemActivity`;
- регистрирует `VRFeature` и `ComposeFeature`;
- создаёт floating 16:9 panel;
- читает тот же `LauncherUiState`;
- не дублирует session logic.

## 7. What stays unchanged

Без изменений или почти без изменений должны остаться:

- heartbeat endpoints Local Hub;
- payload heartbeat;
- `SESSION_ACTION` intent contract;
- `launchGame()` semantics;
- Local Hub integration;
- существующий XML layout как fallback;
- backend/local-hub protocol.

## 8. What must move out of MainActivity

Из `MainActivity` нужно и уже частично вынесено:

- session timer loop;
- state machine;
- START/STOP intent handling;
- heartbeat HTTP client;
- call operator HTTP client;
- game launch helper.

В `MainActivity` должны остаться только:

- fullscreen/window behaviour;
- XML view binding;
- render `LauncherUiState`;
- fallback-specific UI interactions.

## 9. Command handling model

### `START`

- принять intent;
- сохранить `package/activity/duration`;
- перевести launcher в `STARTING`;
- через короткую задержку перейти в `ACTIVE`;
- запустить игру через общий launcher helper.

### `STOP`

- остановить session timer;
- перевести launcher в `FINISHED`;
- вернуть launcher на передний план;
- через задержку вернуть `WAITING`.

### `SHOW_MESSAGE`

Нужно добавить как отдельный action во втором этапе spike.

Поведение:

- кратковременный overlay/banner на panel;
- отдельное поле в `LauncherUiState`, не смешивать с `START/STOP`.

### `CALL_OPERATOR`

Кнопка UI вызывает:

- `AgentHeartbeatClient.callOperator(...)`
- временный visual confirmation banner

### `OPEN_LAUNCHER`

- spatial path:
  `QuestAppLauncher.bringToFront(..., SpatialLauncherActivity::class.java)`
- fallback path:
  `QuestAppLauncher.bringToFront(..., MainActivity::class.java)`

## 10. Minimal immersive POC that now exists

В текущем `quest-agent` уже есть первый рабочий immersive POC:

- тёмное VR-окружение;
- одна floating panel формата около `16:9`;
- заголовок `BizonVR Club Mode`;
- pairing id;
- статус;
- большой таймер;
- описание состояния;
- кнопки `Вызвать оператора` и `Меню игр`;
- нижняя статусная строка.

POC намеренно ещё не является финальной club scene. Он нужен как безопасная рабочая база для дальнейшей полировки Variant 2.

## 11. Next step

Следующий этап после этой migration:

1. решить, должен ли `SpatialLauncherActivity` всегда быть дефолтным launcher entrypoint на production Quest;
2. подключить реальный экран/панель списка игр для `Меню игр`;
3. довести нижнюю статусную строку до реальных device/network данных;
4. при необходимости оставить `quest-agent-spatial-spike/` как reference sandbox и не использовать его как production artifact.

Отдельная команда нужна для возврата игрока из VR-игры в launcher shell.

Для POC можно реализовать как:

- bring-to-front launcher activity

Позже можно расширить явным resume/panel-focus flow.

## 9. Minimal POC definition for Variant 2

Минимальный рабочий Spatial POC должен выглядеть так:

- тёмный спокойный VR hub / void-room;
- перед игроком одна крупная floating panel в формате `16:9`;
- заголовок `BizonVR Club Mode`;
- pairing id;
- статус;
- крупный таймер;
- описание состояния;
- две интерактивные кнопки:
  - `Вызвать оператора`
  - `Меню игр`
- нижняя status line:
  - `Quest 3 • Зона 2, Wi-Fi OK, Agent online, Battery 84%`

Визуальный характер:

- не “кибер-арена”;
- не телефонная activity в воздухе;
- тёмная премиальная среда;
- мягкие cyan/red accents;
- чистая читаемая композиция;
- минимум визуального шума.

## 10. Recommended next steps

1. Создать отдельный spike на Spatial SDK toolchain alignment.
2. Добиться сборки пустой `AppSystemActivity` без бизнес-логики.
3. Поднять `minSdk/targetSdk` только после проверки Quest fleet / Horizon OS baseline клуба.
4. После успешного hello-world Spatial activity вернуть:
   - floating panel
   - `LauncherUiState`
   - `callOperator`
   - timer binding
5. Только затем добавлять hand/controller polish и game menu panel.
