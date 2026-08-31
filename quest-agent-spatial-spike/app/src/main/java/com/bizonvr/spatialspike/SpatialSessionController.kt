package com.bizonvr.spatialspike

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID

interface SpatialSessionCallbacks {
    fun launchGame(packageName: String?, activityName: String?)
    fun onSessionFinished(packageName: String?)
    fun openLauncher()
}

class SpatialSessionController(
    context: Context,
    private val callbacks: SpatialSessionCallbacks,
    private val heartbeatClient: AgentHeartbeatClient = AgentHeartbeatClient()
) {
    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private val preferences = appContext.getSharedPreferences("spatial_quest_agent", Context.MODE_PRIVATE)
    private val persistedHubIp = preferences.getString(KEY_HUB_IP, "") ?: ""
    private val persistedHubPort = preferences.getInt(KEY_HUB_PORT, DEFAULT_HUB_PORT)
    private val agentId = getOrCreateAgentId()
    private var agentToken = preferences.getString(KEY_AGENT_TOKEN, "") ?: ""
    private var lastHeartbeatSentAt = 0L
    private var lastResolvedLocalIp: String? = preferences.getString(KEY_LAST_KNOWN_LOCAL_IP, null)?.takeIf { it.isNotBlank() }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            updateLocalIpAndHeartbeat()
        }

        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            updateLocalIpAndHeartbeat()
        }

        override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
            updateLocalIpAndHeartbeat()
        }
    }

    private val _uiState = MutableStateFlow(
        LauncherUiState(
            pairingId = getOrCreatePairingId(),
            hubIp = persistedHubIp,
            hubPort = persistedHubPort,
            footerLine = Build.MODEL ?: "Meta Quest",
            batteryStatus = currentBatteryStatus(),
            inSession = preferences.getBoolean(KEY_SESSION_IN_SESSION, false),
            sessionPaused = preferences.getBoolean(KEY_SESSION_PAUSED, false),
            launcherState = when {
                !preferences.getBoolean(KEY_SESSION_IN_SESSION, false) -> LauncherState.WAITING
                preferences.getBoolean(KEY_SESSION_PAUSED, false) -> LauncherState.PAUSED
                else -> LauncherState.ACTIVE
            },
            sessionId = preferences.getLong(KEY_SESSION_ID, -1L).takeIf { it > 0 },
            sessionRevision = preferences.getLong(KEY_SESSION_REVISION, 0L),
            sessionStartedAtEpochMs = preferences.getLong(KEY_SESSION_STARTED_AT, -1L).takeIf { it > 0 },
            sessionTotalPausedSeconds = preferences.getLong(KEY_SESSION_TOTAL_PAUSED, 0L),
            sessionPausedAtEpochMs = preferences.getLong(KEY_SESSION_PAUSED_AT, -1L).takeIf { it > 0 },
            pausedRemainingSeconds = preferences.getInt(KEY_SESSION_PAUSED_REMAINING, -1).takeIf { it >= 0 },
            sessionRemainingSeconds = preferences.getInt(KEY_SESSION_REMAINING, 0),
            sessionDurationMinutes = preferences.getInt(KEY_SESSION_DURATION, 30)
        )
    )
    val uiState: StateFlow<LauncherUiState> = _uiState.asStateFlow()

    private val networkHeartbeatRunnable =
        Runnable {
            if (!heartbeatLoopRunning.get()) {
                return@Runnable
            }

            val now = System.currentTimeMillis()
            if (now - lastHeartbeatSentAt < NETWORK_HEARTBEAT_DEBOUNCE_MS) {
                Log.i(TAG, "Skipping duplicate network-triggered heartbeat")
                return@Runnable
            }

            Log.i(TAG, "Sending debounced network-triggered heartbeat")
            sendHeartbeat()
        }

    private val heartbeatRunnable =
        object : Runnable {
            override fun run() {
                val snapshot = _uiState.value
                _uiState.value = snapshot.copy(batteryStatus = currentBatteryStatus())

                refreshTimerFromClock(autoFinish = true)

                sendHeartbeat()
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }

    private val uiRefreshRunnable =
        object : Runnable {
            override fun run() {
                val snapshot = _uiState.value
                _uiState.value = snapshot.copy(batteryStatus = currentBatteryStatus())

                refreshTimerFromClock(autoFinish = false)

                handler.postDelayed(this, UI_REFRESH_INTERVAL_MS)
            }
        }

    fun start(heartbeatOwner: Boolean) {
        stop()
        if (heartbeatOwner) {
            registerNetworkCallback()
            if (heartbeatLoopRunning.compareAndSet(false, true)) {
                Log.i(TAG, "Heartbeat loop started once")
                handler.post(heartbeatRunnable)
            } else {
                Log.i(TAG, "Heartbeat loop already running; skipping duplicate start")
            }
            return
        }

        handler.post(uiRefreshRunnable)
    }

    fun stop() {
        unregisterNetworkCallback()
        handler.removeCallbacks(heartbeatRunnable)
        handler.removeCallbacks(uiRefreshRunnable)
        handler.removeCallbacks(networkHeartbeatRunnable)
    }

    fun stopHeartbeatLoop() {
        handler.removeCallbacks(networkHeartbeatRunnable)
        handler.removeCallbacks(heartbeatRunnable)
        heartbeatLoopRunning.set(false)
        heartbeatClient.shutdown()
    }

    fun handleIntent(intent: Intent?) {
        intent ?: return
        updateHubConnectionFromIntent(intent)

        val incomingSessionId = intent.getLongExtra(EXTRA_SESSION_ID, -1L).takeIf { it > 0 }
        val incomingRevision = intent.getLongExtra(EXTRA_SESSION_REVISION, 0L)

        when (intent.getStringExtra(EXTRA_SESSION_ACTION)) {
            ACTION_START -> {
                if (_uiState.value.inSession && incomingSessionId != null && _uiState.value.sessionId == incomingSessionId) {
                    Log.i(TAG, "Duplicate START ignored for session=$incomingSessionId")
                    return
                }
                val durationSeconds = resolveDurationSeconds(intent)
                val remainingSeconds = resolveRemainingSeconds(intent, durationSeconds)
                transitionTo(
                    launcherState = LauncherState.STARTING,
                    inSession = true,
                    sessionPaused = false,
                    remainingSeconds = remainingSeconds,
                    sessionDurationMinutes = maxOf(1, durationSeconds / 60),
                    sessionPackage = intent.getStringExtra(EXTRA_CURRENT_APP_PACKAGE) ?: intent.getStringExtra(EXTRA_PACKAGE),
                    sessionAppName = intent.getStringExtra(EXTRA_CURRENT_APP_NAME) ?: intent.getStringExtra(EXTRA_APP_NAME),
                    sessionActivity = intent.getStringExtra(EXTRA_ACTIVITY),
                    sessionId = incomingSessionId,
                    sessionRevision = incomingRevision,
                    sessionStartedAtEpochMs = System.currentTimeMillis()
                )

                handler.postDelayed({
                    if (_uiState.value.inSession) {
                        transitionTo(launcherState = LauncherState.ACTIVE)
                        callbacks.launchGame(_uiState.value.sessionPackage, _uiState.value.sessionActivity)
                    }
                }, START_DELAY_MS)
            }

            ACTION_RESUME -> {
                val durationSeconds = resolveDurationSeconds(intent)
                val remainingSeconds = resolveRemainingSeconds(intent, durationSeconds)
                transitionTo(
                    launcherState = if (remainingSeconds <= FIVE_MINUTES_SECONDS) LauncherState.FIVE_MIN_WARN else LauncherState.ACTIVE,
                    inSession = true,
                    sessionPaused = false,
                    remainingSeconds = remainingSeconds,
                    sessionDurationMinutes = maxOf(1, durationSeconds / 60),
                    sessionPackage = intent.getStringExtra(EXTRA_CURRENT_APP_PACKAGE) ?: intent.getStringExtra(EXTRA_PACKAGE),
                    sessionAppName = intent.getStringExtra(EXTRA_CURRENT_APP_NAME) ?: intent.getStringExtra(EXTRA_APP_NAME),
                    sessionActivity = intent.getStringExtra(EXTRA_ACTIVITY),
                    sessionId = incomingSessionId ?: _uiState.value.sessionId,
                    sessionRevision = incomingRevision,
                    sessionStartedAtEpochMs = _uiState.value.sessionStartedAtEpochMs ?: System.currentTimeMillis(),
                    sessionTotalPausedSeconds = _uiState.value.sessionTotalPausedSeconds +
                        maxOf(0L, ((System.currentTimeMillis() - (_uiState.value.sessionPausedAtEpochMs ?: System.currentTimeMillis())) / 1000L)),
                )
            }

            ACTION_PAUSE -> {
                val durationSeconds = resolveDurationSeconds(intent)
                val remainingSeconds = resolveRemainingSeconds(intent, durationSeconds)
                transitionTo(
                    launcherState = LauncherState.PAUSED,
                    inSession = true,
                    sessionPaused = true,
                    remainingSeconds = remainingSeconds,
                    sessionDurationMinutes = maxOf(1, durationSeconds / 60),
                    sessionPackage = intent.getStringExtra(EXTRA_CURRENT_APP_PACKAGE) ?: intent.getStringExtra(EXTRA_PACKAGE),
                    sessionAppName = intent.getStringExtra(EXTRA_CURRENT_APP_NAME) ?: intent.getStringExtra(EXTRA_APP_NAME),
                    sessionActivity = intent.getStringExtra(EXTRA_ACTIVITY),
                    sessionId = incomingSessionId ?: _uiState.value.sessionId,
                    sessionRevision = incomingRevision,
                    sessionPausedAtEpochMs = System.currentTimeMillis(),
                    pausedRemainingSeconds = remainingSeconds
                )
                callbacks.openLauncher()
            }

            ACTION_SWITCH, ACTION_SYNC -> {
                val durationSeconds = resolveDurationSeconds(intent)
                val remainingSeconds = resolveRemainingSeconds(intent, durationSeconds)
                val paused = intent.getBooleanExtra(EXTRA_PAUSED, false) ||
                    intent.getStringExtra(EXTRA_SESSION_STATUS) == "paused"
                transitionTo(
                    launcherState = when {
                        paused -> LauncherState.PAUSED
                        remainingSeconds <= FIVE_MINUTES_SECONDS -> LauncherState.FIVE_MIN_WARN
                        else -> LauncherState.ACTIVE
                    },
                    inSession = true,
                    sessionPaused = paused,
                    remainingSeconds = remainingSeconds,
                    sessionDurationMinutes = maxOf(1, durationSeconds / 60),
                    sessionPackage = intent.getStringExtra(EXTRA_CURRENT_APP_PACKAGE) ?: intent.getStringExtra(EXTRA_PACKAGE),
                    sessionAppName = intent.getStringExtra(EXTRA_CURRENT_APP_NAME) ?: intent.getStringExtra(EXTRA_APP_NAME),
                    sessionActivity = intent.getStringExtra(EXTRA_ACTIVITY),
                    sessionId = incomingSessionId ?: _uiState.value.sessionId,
                    sessionRevision = incomingRevision,
                    sessionStartedAtEpochMs = _uiState.value.sessionStartedAtEpochMs ?: System.currentTimeMillis(),
                    sessionPausedAtEpochMs = null,
                    pausedRemainingSeconds = null
                )
                if (paused) {
                    callbacks.openLauncher()
                }
            }

            ACTION_STOP -> {
                transitionTo(
                    launcherState = LauncherState.FINISHED,
                    inSession = false,
                    sessionPaused = false,
                    remainingSeconds = 0,
                    sessionId = null,
                    sessionRevision = incomingRevision,
                    sessionStartedAtEpochMs = null,
                    sessionPausedAtEpochMs = null,
                    pausedRemainingSeconds = null
                )
                callbacks.openLauncher()
                handler.postDelayed(
                    { transitionTo(launcherState = LauncherState.WAITING) },
                    FINISHED_TO_WAITING_DELAY_MS
                )
            }

            ACTION_SHOW_MESSAGE -> {
                val message = intent.getStringExtra(EXTRA_MESSAGE)?.takeIf { it.isNotBlank() } ?: return
                showTransientBanner(message)
            }

            ACTION_OPEN_LAUNCHER -> callbacks.openLauncher()
        }
    }

    fun callOperator() {
        val state = _uiState.value
        heartbeatClient.callOperator(state.pairingId, agentToken, state.hubIp, state.hubPort)
        showTransientBanner("ОПЕРАТОР ВЫЗВАН")
    }

    fun openGameMenu() {
        val currentState = _uiState.value
        val nextVisible = !currentState.gameMenuVisible
        val nextGames = if (nextVisible) resolveAvailableGames() else currentState.availableGames
        _uiState.value =
            currentState.copy(
                gameMenuVisible = nextVisible,
                availableGames = nextGames,
                gameMenuStatusText = buildGameMenuStatusText(
                    menuVisible = nextVisible,
                    gameCount = nextGames.size,
                    inSession = currentState.inSession
                )
            )
    }

    fun closeGameMenu() {
        _uiState.value = _uiState.value.copy(gameMenuVisible = false)
    }

    private fun updateHubConnectionFromIntent(intent: Intent) {
        val nextHubIp = intent.getStringExtra(EXTRA_HUB_IP)
            ?.takeIf { isValidProductionHubIp(it) }
            ?: _uiState.value.hubIp
        val nextHubPort = intent.getIntExtra(EXTRA_HUB_PORT, _uiState.value.hubPort)
        if (nextHubIp.isBlank()) {
            Log.e(TAG, "HUB_IP is not configured. Waiting for Local Hub launch intent with real LAN HUB_IP/HUB_PORT.")
        }
        preferences.edit()
            .putString(KEY_HUB_IP, nextHubIp)
            .putInt(KEY_HUB_PORT, nextHubPort)
            .apply()
        intent.getStringExtra(EXTRA_AGENT_TOKEN)?.takeIf { it.isNotBlank() }?.let {
            agentToken = it
            preferences.edit().putString(KEY_AGENT_TOKEN, it).apply()
        }
        _uiState.value =
            _uiState.value.copy(
                hubIp = nextHubIp,
                hubPort = nextHubPort
            )
    }

    private fun showTransientBanner(message: String) {
        _uiState.value = _uiState.value.copy(transientBanner = message)
        handler.postDelayed(
            { _uiState.value = _uiState.value.copy(transientBanner = null) },
            TRANSIENT_BANNER_DURATION_MS
        )
    }

    private fun endSessionAutomatically() {
        val state = _uiState.value
        transitionTo(
            launcherState = LauncherState.FINISHED,
            inSession = false,
            sessionPaused = false,
            remainingSeconds = 0
        )
        callbacks.onSessionFinished(state.sessionPackage)
        callbacks.openLauncher()
        handler.postDelayed(
            { transitionTo(launcherState = LauncherState.WAITING) },
            AUTO_FINISH_RESET_DELAY_MS
        )
    }

    private fun resolveDurationSeconds(intent: Intent): Int {
        val explicitDurationSeconds = intent.getIntExtra(EXTRA_DURATION_SECONDS, 0)
        if (explicitDurationSeconds > 0) {
            return explicitDurationSeconds
        }
        return maxOf(60, intent.getIntExtra(EXTRA_DURATION, 30) * 60)
    }

    private fun resolveRemainingSeconds(intent: Intent, durationSeconds: Int): Int {
        val explicitRemainingSeconds = intent.getIntExtra(EXTRA_REMAINING_SECONDS, -1)
        return if (explicitRemainingSeconds >= 0) explicitRemainingSeconds else durationSeconds
    }

    private fun sendHeartbeat() {
        val now = System.currentTimeMillis()
        val previousGlobalHeartbeatAt = lastGlobalHeartbeatSentAt.get()
        if ((now - previousGlobalHeartbeatAt) < GLOBAL_HEARTBEAT_GUARD_MS) {
            Log.i(TAG, "Skipping duplicate process-wide heartbeat send")
            return
        }
        lastGlobalHeartbeatSentAt.set(now)
        lastHeartbeatSentAt = now
        val state = _uiState.value
        heartbeatClient.sendHeartbeat(
            HeartbeatSnapshot(
                agentToken = agentToken,
                pairingId = state.pairingId,
                agentId = agentId,
                androidId = currentAndroidId(),
                model = Build.MODEL ?: "Meta Quest",
                inSession = state.inSession,
                sessionSeconds = state.sessionSeconds,
                remainingSeconds = state.sessionRemainingSeconds,
                sessionStatus = when {
                    !state.inSession -> "ended"
                    state.sessionPaused -> "paused"
                    else -> "running"
                },
                paused = state.sessionPaused,
                currentAppPackage = state.sessionPackage,
                currentAppName = state.sessionAppName,
                sessionId = state.sessionId,
                sessionRevision = state.sessionRevision,
                launcherState = state.launcherState,
                hubIp = state.hubIp,
                hubPort = state.hubPort,
                stableId = currentStableId(),
                localIp = currentLocalIp(),
                appVersion = currentAppVersion(),
                timestamp = System.currentTimeMillis(),
                batteryLevel = currentBatteryLevel(),
                chargingState = currentChargingState(),
                foregroundState = "foreground"
            )
        ) { success ->
            if (success) {
                preferences.edit()
                    .putLong(KEY_LAST_SUCCESSFUL_HEARTBEAT_AT, System.currentTimeMillis())
                    .putString(KEY_APP_VERSION, currentAppVersion())
                    .putString(KEY_LAST_KNOWN_LOCAL_IP, currentLocalIp() ?: "")
                    .apply()
            } else {
                Log.e(TAG, "Heartbeat failed; will retry on next interval with persisted HUB config.")
            }
        }
    }

    private fun updateTimer(nextRemainingSeconds: Int) {
        val state = _uiState.value
        _uiState.value =
            state.copy(
                sessionRemainingSeconds = nextRemainingSeconds,
                sessionSeconds = maxOf(0, (state.sessionDurationMinutes * 60) - nextRemainingSeconds),
                timerText = formatTimer(nextRemainingSeconds)
            )
    }

    private fun persistSessionState(state: LauncherUiState) {
        preferences.edit()
            .putBoolean(KEY_SESSION_IN_SESSION, state.inSession)
            .putBoolean(KEY_SESSION_PAUSED, state.sessionPaused)
            .putLong(KEY_SESSION_ID, state.sessionId ?: -1L)
            .putLong(KEY_SESSION_REVISION, state.sessionRevision)
            .putLong(KEY_SESSION_STARTED_AT, state.sessionStartedAtEpochMs ?: -1L)
            .putLong(KEY_SESSION_TOTAL_PAUSED, state.sessionTotalPausedSeconds)
            .putLong(KEY_SESSION_PAUSED_AT, state.sessionPausedAtEpochMs ?: -1L)
            .putInt(KEY_SESSION_PAUSED_REMAINING, state.pausedRemainingSeconds ?: -1)
            .putInt(KEY_SESSION_REMAINING, state.sessionRemainingSeconds)
            .putInt(KEY_SESSION_DURATION, state.sessionDurationMinutes)
            .apply()
    }

    private fun refreshTimerFromClock(autoFinish: Boolean) {
        val state = _uiState.value
        if (!state.inSession || state.sessionPaused) return
        val startedAt = state.sessionStartedAtEpochMs ?: return
        val elapsed = maxOf(0L, (System.currentTimeMillis() - startedAt) / 1000L)
        val remaining = maxOf(0, state.sessionDurationMinutes * 60 - elapsed.toInt() + state.sessionTotalPausedSeconds.toInt())
        if (remaining <= 0 && autoFinish) {
            endSessionAutomatically()
            return
        }
        updateTimer(remaining)
    }

    private fun transitionTo(
        launcherState: LauncherState,
        inSession: Boolean = _uiState.value.inSession,
        sessionPaused: Boolean = _uiState.value.sessionPaused,
        remainingSeconds: Int = _uiState.value.sessionRemainingSeconds,
        sessionDurationMinutes: Int = _uiState.value.sessionDurationMinutes,
        sessionPackage: String? = _uiState.value.sessionPackage,
        sessionAppName: String? = _uiState.value.sessionAppName,
        sessionActivity: String? = _uiState.value.sessionActivity,
        sessionId: Long? = _uiState.value.sessionId,
        sessionRevision: Long = _uiState.value.sessionRevision,
        sessionStartedAtEpochMs: Long? = _uiState.value.sessionStartedAtEpochMs,
        sessionTotalPausedSeconds: Long = _uiState.value.sessionTotalPausedSeconds,
        sessionPausedAtEpochMs: Long? = _uiState.value.sessionPausedAtEpochMs,
        pausedRemainingSeconds: Int? = _uiState.value.pausedRemainingSeconds
    ) {
        val clampedRemainingSeconds = maxOf(0, remainingSeconds)
        val totalSeconds = maxOf(sessionDurationMinutes * 60, clampedRemainingSeconds)
        val baseState =
            _uiState.value.copy(
                launcherState = launcherState,
                inSession = inSession,
                sessionPaused = sessionPaused,
                sessionSeconds = maxOf(0, totalSeconds - clampedRemainingSeconds),
                sessionRemainingSeconds = clampedRemainingSeconds,
                sessionDurationMinutes = sessionDurationMinutes,
                sessionPackage = sessionPackage,
                sessionAppName = sessionAppName,
                sessionActivity = sessionActivity,
                batteryStatus = currentBatteryStatus(),
                availableGames = markCurrentSessionGame(_uiState.value.availableGames, if (inSession) sessionPackage else null),
                gameMenuStatusText = buildGameMenuStatusText(
                    menuVisible = _uiState.value.gameMenuVisible,
                    gameCount = _uiState.value.availableGames.size,
                    inSession = inSession
                )
            )

        _uiState.value =
            when (launcherState) {
                LauncherState.WAITING ->
                    baseState.copy(
                        statusText = "Ожидание запуска",
                        descriptionText = "Оператор скоро начнет игру",
                        timerText = "00:00",
                        timerTone = TimerTone.DEFAULT,
                        showBottomActions = true
                    )

                LauncherState.STARTING ->
                    baseState.copy(
                        statusText = "Подготовка игры",
                        descriptionText = "Пожалуйста, наденьте шлем удобно. Игра скоро запустится.",
                        timerText = "--:--",
                        timerTone = TimerTone.DEFAULT,
                        showBottomActions = false
                    )

                LauncherState.ACTIVE ->
                    baseState.copy(
                        statusText = "Сессия активна",
                        descriptionText = sessionAppName ?: sessionPackage ?: "Игра запущена",
                        timerText = formatTimer(clampedRemainingSeconds),
                        timerTone = TimerTone.DEFAULT,
                        showBottomActions = true
                    )

                LauncherState.PAUSED ->
                    baseState.copy(
                        statusText = "Сессия на паузе",
                        descriptionText = sessionAppName ?: sessionPackage ?: "Игра будет продолжена оператором",
                        timerText = formatTimer(clampedRemainingSeconds),
                        timerTone = TimerTone.WARNING,
                        showBottomActions = true
                    )

                LauncherState.FIVE_MIN_WARN ->
                    baseState.copy(
                        statusText = "Осталось 5 минут",
                        descriptionText = "Если хотите продлить время — позовите оператора",
                        timerText = formatTimer(clampedRemainingSeconds),
                        timerTone = TimerTone.WARNING,
                        showBottomActions = true
                    )

                LauncherState.FINISHED ->
                    baseState.copy(
                        statusText = "Сессия завершена",
                        descriptionText = "Пожалуйста, снимите шлем и передайте его оператору",
                        timerText = "00:00",
                        timerTone = TimerTone.DANGER,
                        showBottomActions = false
                    )

                LauncherState.ERROR ->
                    baseState.copy(
                        statusText = "Нужна помощь оператора",
                        descriptionText = "Шлем временно не готов к запуску",
                        timerText = "ERR",
                        timerTone = TimerTone.DANGER,
                        showBottomActions = true
                    )
            }
        persistSessionState(_uiState.value.copy(
            sessionId = sessionId,
            sessionRevision = sessionRevision,
            sessionStartedAtEpochMs = sessionStartedAtEpochMs,
            sessionTotalPausedSeconds = sessionTotalPausedSeconds,
            sessionPausedAtEpochMs = sessionPausedAtEpochMs,
            pausedRemainingSeconds = pausedRemainingSeconds,
        ))
    }

    private fun resolveAvailableGames(): List<LauncherGameEntry> {
        val packageManager = appContext.packageManager
        val launchIntents = listOf(
            Intent(Intent.ACTION_MAIN).addCategory("com.oculus.intent.category.VR"),
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        )
        val entries = linkedMapOf<String, LauncherGameEntry>()

        for (launchIntent in launchIntents) {
            val resolvedActivities =
                try {
                    packageManager.queryIntentActivities(
                        launchIntent,
                        PackageManager.ResolveInfoFlags.of(0)
                    )
                } catch (_: Throwable) {
                    @Suppress("DEPRECATION")
                    packageManager.queryIntentActivities(launchIntent, 0)
                }

            for (resolved in resolvedActivities) {
                val packageName = resolved.activityInfo?.packageName ?: continue
                val activityName = resolved.activityInfo?.name
                if (!isAllowedLauncherPackage(packageName, activityName)) {
                    continue
                }
                val displayName = resolved.loadLabel(packageManager)?.toString()?.trim().orEmpty()
                entries.putIfAbsent(
                    packageName,
                    LauncherGameEntry(
                        packageName = packageName,
                        displayName = displayName.ifBlank { prettifyPackageName(packageName) },
                        activityName = activityName,
                        isCurrentSessionApp = packageName == _uiState.value.sessionPackage
                    )
                )
            }
        }

        return entries.values.sortedBy { it.displayName.lowercase() }
    }

    private fun isAllowedLauncherPackage(packageName: String, activityName: String?): Boolean {
        if (packageName == appContext.packageName) {
            return false
        }
        if (packageName.startsWith("com.oculus.") ||
            packageName.startsWith("com.meta.") ||
            packageName.startsWith("com.android.") ||
            packageName.startsWith("android.") ||
            packageName.startsWith("su.happ.")
        ) {
            return false
        }
        if (activityName?.contains("Settings", ignoreCase = true) == true) {
            return false
        }
        return true
    }

    private fun prettifyPackageName(packageName: String): String {
        val tail = packageName.substringAfterLast('.')
        return tail
            .replace('_', ' ')
            .replace('-', ' ')
            .replace(Regex("([a-z])([A-Z])"), "$1 $2")
            .replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    }

    private fun markCurrentSessionGame(
        games: List<LauncherGameEntry>,
        sessionPackage: String?
    ): List<LauncherGameEntry> {
        return games.map { game ->
            game.copy(isCurrentSessionApp = sessionPackage != null && game.packageName == sessionPackage)
        }
    }

    private fun buildGameMenuStatusText(
        menuVisible: Boolean,
        gameCount: Int,
        inSession: Boolean
    ): String {
        if (!menuVisible) {
            return "Откройте меню, чтобы посмотреть доступные игры"
        }
        return when {
            gameCount == 0 -> "Подходящие VR-игры не найдены"
            inSession -> "Текущую игру запускает оператор из панели"
            else -> "Список игр для этой станции"
        }
    }

    private fun currentBatteryStatus(): String {
        val batteryManager = appContext.getSystemService(BatteryManager::class.java) ?: return "Battery --%"
        val level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) "Battery $level%" else "Battery --%"
    }

    private fun currentBatteryLevel(): Int? {
        val batteryManager = appContext.getSystemService(BatteryManager::class.java) ?: return null
        val level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (level in 0..100) level else null
    }

    private fun currentChargingState(): String {
        val batteryIntent = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        return when (batteryIntent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)) {
            BatteryManager.BATTERY_STATUS_CHARGING,
            BatteryManager.BATTERY_STATUS_FULL -> "charging"
            else -> "discharging"
        }
    }

    private fun getOrCreatePairingId(): String {
        val existingId = preferences.getString(KEY_PAIRING_ID, null)
        if (!existingId.isNullOrBlank()) {
            return existingId
        }

        val newId = UUID.randomUUID().toString().substring(0, 6).uppercase()
        preferences.edit().putString(KEY_PAIRING_ID, newId).apply()
        return newId
    }

    private fun formatTimer(remainingSeconds: Int): String {
        val minutes = remainingSeconds / 60
        val seconds = remainingSeconds % 60
        return String.format("%02d:%02d", minutes, seconds)
    }

    private fun currentAndroidId(): String {
        return Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID) ?: ""
    }

    private fun currentStableId(): String? {
        return Build.SERIAL.takeIf { it.isNotBlank() && it != Build.UNKNOWN }
    }

    private fun currentAppVersion(): String {
        return try {
            val info = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            info.versionName ?: "unknown"
        } catch (_: PackageManager.NameNotFoundException) {
            "unknown"
        }
    }

    private fun currentLocalIp(): String? {
        val connectivityManager = appContext.getSystemService(ConnectivityManager::class.java) ?: return null
        val activeNetwork = connectivityManager.activeNetwork
        if (activeNetwork == null) return null
        val caps = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return null
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return null
        val linkProperties = connectivityManager.getLinkProperties(activeNetwork) ?: return null
        return selectActiveWifiIpv4(linkProperties.linkAddresses.mapNotNull { it.address.hostAddress })
    }

    private fun updateLocalIpAndHeartbeat() {
        val localIp = currentLocalIp()
        if (localIp != null && localIp != lastResolvedLocalIp) {
            Log.i(TAG, "Resolved active Wi-Fi local_ip=$localIp")
        }
        lastResolvedLocalIp = localIp ?: lastResolvedLocalIp
        preferences.edit().putString(KEY_LAST_KNOWN_LOCAL_IP, localIp ?: "").apply()
        if (heartbeatLoopRunning.get()) {
            handler.removeCallbacks(networkHeartbeatRunnable)
            handler.postDelayed(networkHeartbeatRunnable, NETWORK_HEARTBEAT_DEBOUNCE_MS)
        }
    }

    private fun registerNetworkCallback() {
        runCatching {
            appContext.getSystemService(ConnectivityManager::class.java)
                ?.registerDefaultNetworkCallback(networkCallback)
        }.onFailure { Log.e(TAG, "Network callback registration failed: ${it.message}", it) }
    }

    private fun unregisterNetworkCallback() {
        runCatching {
            appContext.getSystemService(ConnectivityManager::class.java)
                ?.unregisterNetworkCallback(networkCallback)
        }
    }

    private fun isValidProductionHubIp(value: String): Boolean {
        val host = value.trim()
        return host.isNotBlank() && host != "127.0.0.1" && host != "localhost" && host != "::1"
    }

    private fun getOrCreateAgentId(): String {
        val existingId = preferences.getString(KEY_AGENT_ID, null)
        if (!existingId.isNullOrBlank()) {
            return existingId
        }

        val newId = UUID.randomUUID().toString()
        preferences.edit().putString(KEY_AGENT_ID, newId).apply()
        return newId
    }

    companion object {
        private const val TAG = "BizonVRQuestAgent"
        private const val HEARTBEAT_INTERVAL_MS = BuildConfig.HEARTBEAT_INTERVAL_MS
        private const val HEARTBEAT_INTERVAL_SECONDS = 5
        private const val UI_REFRESH_INTERVAL_MS = 1000L
        private const val UI_REFRESH_INTERVAL_SECONDS = 1
        private const val FIVE_MINUTES_SECONDS = 300
        private const val START_DELAY_MS = 3000L
        private const val FINISHED_TO_WAITING_DELAY_MS = 10000L
        private const val AUTO_FINISH_RESET_DELAY_MS = 15000L
        private const val TRANSIENT_BANNER_DURATION_MS = 5000L
        private const val NETWORK_HEARTBEAT_DEBOUNCE_MS = 1000L
        private const val GLOBAL_HEARTBEAT_GUARD_MS = 1000L

        private const val KEY_PAIRING_ID = "pairing_id"
        private const val KEY_AGENT_ID = "agent_id"
        private const val KEY_AGENT_TOKEN = "agent_token"
        private const val KEY_HUB_IP = "hub_ip"
        private const val KEY_HUB_PORT = "hub_port"
        private const val KEY_LAST_SUCCESSFUL_HEARTBEAT_AT = "last_successful_heartbeat_at"
        private const val KEY_APP_VERSION = "app_version"
        private const val KEY_LAST_KNOWN_LOCAL_IP = "last_known_local_ip"
        private const val KEY_SESSION_IN_SESSION = "session_in_session"
        private const val KEY_SESSION_PAUSED = "session_paused"
        private const val KEY_SESSION_ID = "session_id"
        private const val KEY_SESSION_REVISION = "session_revision"
        private const val KEY_SESSION_STARTED_AT = "session_started_at"
        private const val KEY_SESSION_TOTAL_PAUSED = "session_total_paused"
        private const val KEY_SESSION_PAUSED_AT = "session_paused_at"
        private const val KEY_SESSION_PAUSED_REMAINING = "session_paused_remaining"
        private const val KEY_SESSION_REMAINING = "session_remaining"
        private const val KEY_SESSION_DURATION = "session_duration"
        private const val DEFAULT_HUB_PORT = 3001

        private const val EXTRA_SESSION_ACTION = "SESSION_ACTION"
        private const val EXTRA_DURATION = "DURATION"
        private const val EXTRA_DURATION_SECONDS = "DURATION_SECONDS"
        private const val EXTRA_PACKAGE = "PACKAGE"
        private const val EXTRA_APP_NAME = "APP_NAME"
        private const val EXTRA_ACTIVITY = "ACTIVITY"
        private const val EXTRA_CURRENT_APP_PACKAGE = "CURRENT_APP_PACKAGE"
        private const val EXTRA_CURRENT_APP_NAME = "CURRENT_APP_NAME"
        private const val EXTRA_REMAINING_SECONDS = "REMAINING_SECONDS"
        private const val EXTRA_SESSION_STATUS = "SESSION_STATUS"
        private const val EXTRA_PAUSED = "PAUSED"
        private const val EXTRA_HUB_IP = "HUB_IP"
        private const val EXTRA_HUB_PORT = "HUB_PORT"
        private const val EXTRA_MESSAGE = "MESSAGE"
        private const val EXTRA_SESSION_ID = "SESSION_ID"
        private const val EXTRA_SESSION_REVISION = "SESSION_REVISION"
        private const val EXTRA_AGENT_TOKEN = "AGENT_TOKEN"

        private const val ACTION_START = "START"
        private const val ACTION_RESUME = "RESUME"
        private const val ACTION_PAUSE = "PAUSE"
        private const val ACTION_SWITCH = "SWITCH"
        private const val ACTION_SYNC = "SYNC"
        private const val ACTION_STOP = "STOP"
        private const val ACTION_SHOW_MESSAGE = "SHOW_MESSAGE"
        private const val ACTION_OPEN_LAUNCHER = "OPEN_LAUNCHER"
        private val heartbeatLoopRunning = AtomicBoolean(false)
        private val lastGlobalHeartbeatSentAt = AtomicLong(0L)
    }
}
