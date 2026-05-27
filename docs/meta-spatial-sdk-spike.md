# Meta Spatial SDK Spike

Дата: 2026-05-26

> Current production Quest app is `quest-agent-spatial-spike` (`com.bizonvr.spatialspike`).
> The older `quest-agent` project is deprecated/non-production unless a task explicitly says otherwise.

## Что это

`quest-agent-spatial-spike/` — production Android/Kotlin проект для Meta Quest. Старый `quest-agent` остаётся только как deprecated reference.

Spike специально:

- не трогает `MainActivity` основного агента;
- не использует XML launcher;
- не ломает основной `quest-agent`;
- использует свой standalone session/state/heartbeat слой внутри spike;
- поднимает рабочий immersive launcher shell с floating 16:9 panel;
- теперь является production path для `com.bizonvr.spatialspike`.

## Текущий итог spike

Spike выполнил свою задачу:

- подтвердил, что Meta Spatial SDK path на Kotlin/Android реально поднимается без Unity;
- позволил локализовать конфликт toolchain;
- дал рабочую основу для переноса в production APK.

По состоянию на сейчас immersive launcher уже живёт в основном `quest-agent` как `SpatialLauncherActivity`.

## Что было проверено

### Текущий рабочий `quest-agent`

- Gradle wrapper: `9.0.0`
- Android Gradle Plugin: `8.13.2`
- Kotlin plugin: `1.9.24`
- `compileSdk = 34`
- `minSdk = 29`
- `targetSdk = 32`
- Java target: `17`
- Kotlin JVM target: `17`

### Spatial SDK, который пробовался

- Meta Spatial SDK: `0.13.0`

Официальные ориентиры, которые были сверены:

- [Meta Spatial SDK Samples](https://github.com/meta-quest/Meta-Spatial-SDK-Samples)
- [StarterSample gradle wrapper](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/StarterSample/gradle/wrapper/gradle-wrapper.properties)
- [StarterSample app/build.gradle.kts](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/StarterSample/app/build.gradle.kts)
- [StarterSample AndroidManifest.xml](https://raw.githubusercontent.com/meta-quest/Meta-Spatial-SDK-Samples/main/StarterSample/app/src/main/AndroidManifest.xml)

## Диагностика несовместимости

### Что ломалось внутри основного `quest-agent`

Когда Spatial SDK добавлялся прямо в `quest-agent`, сборка падала на `:compileDebugKotlin` с ошибкой сериализации compiler work arguments.

Ключевой симптом:

```text
Execution failed for task ':compileDebugKotlin'.
Could not isolate value ... GradleKotlinCompilerWorkParameters
Could not serialize value of type GradleKotlinCompilerWorkArguments
```

### Что показал standalone spike

В отдельном проекте удалось сузить причину сильнее.

1. Official-style stack с:
   - Gradle `9.4.1`
   - AGP `8.5.0`
   - Kotlin plugin `2.1.0`
   - Compose plugin `2.1.0`
   - Spatial SDK `0.13.0`

   сначала падал на:

```text
'void org.jetbrains.kotlin.cli.common.arguments.CommonToolArguments.setExtraWarnings(boolean)'
```

2. `./gradlew buildEnvironment` показал ключевой конфликт:

- `com.meta.spatial:spatial-gradle-plugin-impl:0.13.0`
  тянет `org.jetbrains.kotlin:kotlin-compiler-embeddable:1.9.25`
- сами Spatial AAR при этом скомпилированы с Kotlin metadata `2.1.0`

3. Попытка опустить Kotlin plugin до `1.9.25` не подходит:
   spike падает на несовместимую Kotlin metadata `2.1.0` в Spatial AAR.

### Рабочий вывод

Для standalone spike пришлось принудительно выровнять Kotlin compiler artifacts в buildscript classpath на `2.1.0`, оставив:

- AGP `8.5.0`
- Kotlin `2.1.0`
- Meta Spatial SDK `0.13.0`
- Gradle `9.4.1`
- Java daemon `21`

Именно в таком виде standalone immersive build проходит.

## Структура spike

Проект:

- [quest-agent-spatial-spike/settings.gradle.kts](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/settings.gradle.kts)
- [quest-agent-spatial-spike/build.gradle.kts](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/build.gradle.kts)
- [quest-agent-spatial-spike/gradle/libs.versions.toml](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/gradle/libs.versions.toml)
- [quest-agent-spatial-spike/app/build.gradle.kts](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/app/build.gradle.kts)
- [quest-agent-spatial-spike/app/src/main/AndroidManifest.xml](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/app/src/main/AndroidManifest.xml)
- [quest-agent-spatial-spike/app/src/main/java/com/bizonvr/spatialspike/SpatialSpikeActivity.kt](/Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/app/src/main/java/com/bizonvr/spatialspike/SpatialSpikeActivity.kt)

## Как собрать

### Основной quest-agent

```bash
cd /Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent
./gradlew clean assembleDebug
```

### Spatial spike

Перед сборкой нужен Android SDK path. Файл `local.properties` в spike не коммитится.

Варианты:

1. Задать `ANDROID_HOME`
2. Или создать `quest-agent-spatial-spike/local.properties`:

```properties
sdk.dir=/Users/Yaroslav/Library/Android/sdk
```

Сборка:

```bash
cd /Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike
./gradlew clean assembleDebug
```

APK:

```text
quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk
```

## Как установить на Quest

Если устройство видно по ADB:

```bash
adb devices -l
adb -s <serial> install -r /Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk
```

Для Quest из текущего окружения serial был:

```text
192.168.0.3:5555
```

Пример:

```bash
adb -s 192.168.0.3:5555 install -r /Users/Yaroslav/Documents/dev/BizonVR-Operator/quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk
```

## Как запустить Activity

Через launcher icon на Quest или через ADB:

```bash
adb -s 192.168.0.3:5555 shell am start -n com.bizonvr.spatialspike/.SpatialSpikeActivity
```

## Что должно появиться в headset

Минимальная проверка:

1. Открывается immersive VR shell, а не обычная phone-style activity.
2. Перед пользователем появляется одна floating panel формата около `16:9`.
3. На panel виден launcher:
   - `BizonVR Club Mode`
   - pairing id
   - status
   - timer
   - `Вызвать оператора`
   - `Меню игр`
4. Фон сцены тёмный.
5. `SESSION_ACTION START/STOP` меняют состояние launcher.

## Что получилось проверить фактически

- `quest-agent` продолжает собираться отдельно.
- standalone `quest-agent-spatial-spike` собирается.
- APK сгенерирован.
- APK устанавливается на Quest.
- `SpatialSpikeActivity` запускается через `adb shell am start`.

Что не удалось подтвердить до конца в этом прогоне:

- я не снимал отдельный скриншот из headset и не фиксировал все session-state визуально по шагам.

## Что делать теперь

Для повседневной разработки launcher лучше использовать основной `quest-agent`, потому что именно он теперь содержит:

- `MainActivity` как 2D fallback;
- `SpatialLauncherActivity` как immersive launcher;
- общий `AgentSessionController`.

Spike имеет смысл оставлять для:

- быстрых экспериментов с Meta Spatial SDK;
- проверки будущих обновлений toolchain;
- изолированных визуальных POC без риска для production APK.

## Следующий шаг

Только после этого spike имеет смысл переходить к следующему этапу:

1. использовать этот toolchain как reference implementation;
2. полировать spatial launcher уже внутри основного `quest-agent`;
3. развивать реальное меню игр, device status и operator flows без отдельной бизнес-логики в spike.
