# AGENTS.md

Инструкции для AI-агента, работающего над проектом **BizonVR Club Control**.

## 1. Контекст
Проект — подписочная система управления Meta Quest-шлемами для VR-клубов.

## 2. Главный принцип
Не делать абстрактную MDM-систему. Делать рабочий инструмент для оператора VR-клуба.

## 3. Архитектура
Правильная цепочка:
\`\`\`text
Web Panel -> Cloud API -> DeviceCommand -> Local Hub -> ADB/scrcpy/Quest Agent -> Quest
\`\`\`
Cloud не выполняет ADB/scrcpy и не подключается к Quest напрямую.

## 4. Запрещено
- Добавлять Unity в Quest Agent/Launcher.
- Делать прямое Cloud-to-Quest управление.
- Выполнять raw shell из UI.
- Делать endpoint \`/run-shell\`.
- Передавать произвольные команды из Cloud в Local Hub.
