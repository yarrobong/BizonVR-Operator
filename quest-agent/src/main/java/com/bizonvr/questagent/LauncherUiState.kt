package com.bizonvr.questagent

data class LauncherUiState(
    val pairingId: String,
    val launcherState: LauncherState = LauncherState.WAITING,
    val statusText: String = "Ожидание запуска",
    val descriptionText: String = "Оператор скоро начнёт игру",
    val timerText: String = "00:00",
    val timerTone: TimerTone = TimerTone.DEFAULT,
    val showBottomActions: Boolean = true,
    val inSession: Boolean = false,
    val sessionSeconds: Int = 0,
    val sessionDurationMinutes: Int = 30,
    val sessionPackage: String? = null,
    val sessionActivity: String? = null,
    val hubIp: String = "127.0.0.1",
    val hubPort: Int = 3001,
    val transientBanner: String? = null,
    val footerLine: String = "Quest 3 • Зона 2",
    val wifiStatus: String = "Wi-Fi OK",
    val agentStatus: String = "Agent online",
    val batteryStatus: String = "Battery 84%"
)
