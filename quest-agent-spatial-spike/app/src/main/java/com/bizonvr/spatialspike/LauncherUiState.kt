package com.bizonvr.spatialspike

data class LauncherGameEntry(
    val packageName: String,
    val displayName: String,
    val activityName: String? = null,
    val isCurrentSessionApp: Boolean = false
)

data class LauncherUiState(
    val pairingId: String,
    val launcherState: LauncherState = LauncherState.WAITING,
    val statusText: String = "Ожидание запуска",
    val descriptionText: String = "Оператор скоро начнет игру",
    val timerText: String = "00:00",
    val timerTone: TimerTone = TimerTone.DEFAULT,
    val showBottomActions: Boolean = true,
    val inSession: Boolean = false,
    val sessionPaused: Boolean = false,
    val sessionSeconds: Int = 0,
    val sessionRemainingSeconds: Int = 0,
    val sessionDurationMinutes: Int = 30,
    val sessionPackage: String? = null,
    val sessionAppName: String? = null,
    val sessionActivity: String? = null,
    val sessionId: Long? = null,
    val sessionRevision: Long = 0,
    val sessionStartedAtEpochMs: Long? = null,
    val sessionTotalPausedSeconds: Long = 0,
    val sessionPausedAtEpochMs: Long? = null,
    val pausedRemainingSeconds: Int? = null,
    val hubIp: String = "",
    val hubPort: Int = 3001,
    val transientBanner: String? = null,
    val footerLine: String = "Quest 3 • Zone 2",
    val wifiStatus: String = "Wi-Fi OK",
    val agentStatus: String = "Agent online",
    val batteryStatus: String = "Battery --%",
    val gameMenuVisible: Boolean = false,
    val availableGames: List<LauncherGameEntry> = emptyList(),
    val gameMenuStatusText: String = "Загрузка списка игр…"
)
