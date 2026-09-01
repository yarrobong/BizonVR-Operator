# Meta Spatial SDK Spike (historical)

Дата: 2026-05-26

> Current production Quest app is `quest-agent-spatial-spike` (`com.bizonvr.spatialspike`).
> The older `quest-agent` project is deprecated/non-production unless a task explicitly says otherwise.
>
> This is a historical toolchain record. Stage 6 re-verifies builds only; it
> does not claim physical Quest installation, launch, or end-to-end validation.

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

По текущему repository state production path остаётся
`quest-agent-spatial-spike`; старый `quest-agent` не является production
артефактом.

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

- [quest-agent-spatial-spike/settings.gradle.kts](../quest-agent-spatial-spike/settings.gradle.kts)
- [quest-agent-spatial-spike/build.gradle.kts](../quest-agent-spatial-spike/build.gradle.kts)
- [quest-agent-spatial-spike/gradle/libs.versions.toml](../quest-agent-spatial-spike/gradle/libs.versions.toml)
- [quest-agent-spatial-spike/app/build.gradle.kts](../quest-agent-spatial-spike/app/build.gradle.kts)
- [quest-agent-spatial-spike/app/src/main/AndroidManifest.xml](../quest-agent-spatial-spike/app/src/main/AndroidManifest.xml)
- [quest-agent-spatial-spike/app/src/main/java/com/bizonvr/spatialspike/SpatialSpikeActivity.kt](../quest-agent-spatial-spike/app/src/main/java/com/bizonvr/spatialspike/SpatialSpikeActivity.kt)

## Как собрать

### Deprecated quest-agent reference

The older `quest-agent` project is retained as a deprecated reference and is
not the Stage 6 production validation target.

### Spatial spike

Перед сборкой нужен Android SDK path. Файл `local.properties` в spike не коммитится.

Варианты:

1. Задать `ANDROID_HOME`
2. Или создать `quest-agent-spatial-spike/local.properties`:

```properties
sdk.dir=/path/to/Android/sdk
```

Сборка:

```bash
cd quest-agent-spatial-spike
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
adb -s <serial> install -r quest-agent-spatial-spike/app/build/outputs/apk/debug/app-debug.apk
```

Physical installation is a deferred manual step; use the stable ADB route
provided by the club environment when that validation is authorized.

## Как запустить Activity

Через launcher icon на Quest или через ADB:

```bash
adb -s <serial> shell am start -n com.bizonvr.spatialspike/.SpatialSpikeActivity
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

## Что проверяется автоматически в текущем Stage 6

- standalone `quest-agent-spatial-spike` проходит Gradle unit tests.
- `quest-agent-spatial-spike` собирается через `assembleDebug`.
- physical install/launch and headset UI behavior remain deferred.

Отдельные physical Quest screenshots и session-state checks в Stage 6 не
проводились.

## Что делать теперь

`quest-agent-spatial-spike` является текущим production path в этом
репозитории. Проект имеет историческое имя и сохраняется без переименования,
чтобы не создавать лишний Gradle/package churn. Старый `quest-agent` имеет
смысл оставлять только для:

- быстрых экспериментов с Meta Spatial SDK;
- проверки будущих обновлений toolchain;
- изолированных визуальных POC без риска для production APK.

## Следующий шаг

Только после этого spike имеет смысл переходить к следующему этапу:

1. использовать этот toolchain как reference implementation;
2. полировать spatial launcher уже внутри основного `quest-agent`;
3. развивать реальное меню игр, device status и operator flows без отдельной бизнес-логики в spike.
