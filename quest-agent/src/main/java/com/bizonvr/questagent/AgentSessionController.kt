package com.bizonvr.questagent

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.UUID

interface AgentSessionCallbacks {
    fun launchGame(packageName: String?, activityName: String?)
    fun onSessionFinished(packageName: String?)
    fun openLauncher()
}

class AgentSessionController(
    context: Context,
    private val callbacks: AgentSessionCallbacks,
    private val heartbeatClient: AgentHeartbeatClient = AgentHeartbeatClient()
) {
    private val appContext = context.applicationContext
    private val handler = Handler(Looper.getMainLooper())
    private val preferences = appContext.getSharedPreferences("quest_agent", Context.MODE_PRIVATE)

    private val _uiState = MutableStateFlow(
        LauncherUiState(pairingId = getOrCreatePairingId())
    )
    val uiState: StateFlow<LauncherUiState> = _uiState.asStateFlow()

    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            val snapshot = _uiState.value
            if (snapshot.inSession) {
                val nextSeconds = snapshot.sessionSeconds + HEARTBEAT_INTERVAL_SECONDS
                val totalSessionSeconds = snapshot.sessionDurationMinutes * 60
                val remainingSeconds = totalSessionSeconds - nextSeconds

                when {
                    remainingSeconds <= 0 -> {
                        endSessionAutomatically()
                    }
                    remainingSeconds <= FIVE_MINUTES_SECONDS &&
                        snapshot.launcherState != LauncherState.FIVE_MIN_WARN -> {
                        transitionTo(
                            launcherState = LauncherState.FIVE_MIN_WARN,
                            timerSeconds = nextSeconds
                        )
                    }
                    else -> {
                        updateTimer(nextSeconds)
                    }
                }
            }

            sendHeartbeat()
            handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
        }
    }

    fun start() {
        handler.removeCallbacks(heartbeatRunnable)
        handler.post(heartbeatRunnable)
    }

    fun stop() {
        handler.removeCallbacks(heartbeatRunnable)
        heartbeatClient.shutdown()
    }

    fun handleIntent(intent: Intent?) {
        intent ?: return
        updateHubConnectionFromIntent(intent)

        if (!intent.hasExtra(EXTRA_SESSION_ACTION)) {
            return
        }

        when (intent.getStringExtra(EXTRA_SESSION_ACTION)) {
            ACTION_START -> {
                transitionTo(
                    launcherState = LauncherState.STARTING,
                    inSession = true,
                    timerSeconds = 0,
                    sessionDurationMinutes = intent.getIntExtra(EXTRA_DURATION, 30),
                    sessionPackage = intent.getStringExtra(EXTRA_PACKAGE),
                    sessionActivity = intent.getStringExtra(EXTRA_ACTIVITY)
                )

                handler.postDelayed({
                    if (_uiState.value.inSession) {
                        transitionTo(launcherState = LauncherState.ACTIVE)
                        callbacks.launchGame(
                            _uiState.value.sessionPackage,
                            _uiState.value.sessionActivity
                        )
                    }
                }, START_DELAY_MS)
            }

            ACTION_STOP -> {
                transitionTo(
                    launcherState = LauncherState.FINISHED,
                    inSession = false,
                    timerSeconds = 0
                )
                callbacks.openLauncher()
                handler.postDelayed({
                    transitionTo(launcherState = LauncherState.WAITING)
                }, FINISHED_TO_WAITING_DELAY_MS)
            }
        }
    }

    fun callOperator() {
        val state = _uiState.value
        heartbeatClient.callOperator(state.pairingId, state.hubIp, state.hubPort)
        _uiState.value = state.copy(transientBanner = "ОПЕРАТОР ВЫЗВАН")
        handler.postDelayed({
            _uiState.value = _uiState.value.copy(transientBanner = null)
        }, OPERATOR_BANNER_DURATION_MS)
    }

    private fun updateHubConnectionFromIntent(intent: Intent) {
        _uiState.value = _uiState.value.copy(
            hubIp = intent.getStringExtra(EXTRA_HUB_IP) ?: _uiState.value.hubIp,
            hubPort = intent.getIntExtra(EXTRA_HUB_PORT, _uiState.value.hubPort)
        )
    }

    private fun endSessionAutomatically() {
        val state = _uiState.value
        transitionTo(
            launcherState = LauncherState.FINISHED,
            inSession = false,
            timerSeconds = 0
        )
        callbacks.onSessionFinished(state.sessionPackage)
        callbacks.openLauncher()
        handler.postDelayed({
            transitionTo(launcherState = LauncherState.WAITING)
        }, AUTO_FINISH_RESET_DELAY_MS)
    }

    private fun sendHeartbeat() {
        val state = _uiState.value
        heartbeatClient.sendHeartbeat(
            HeartbeatSnapshot(
                pairingId = state.pairingId,
                agentId = state.pairingId,
                androidId = currentAndroidId(),
                model = Build.MODEL ?: "Meta Quest",
                inSession = state.inSession,
                sessionSeconds = state.sessionSeconds,
                launcherState = state.launcherState,
                hubIp = state.hubIp,
                hubPort = state.hubPort
            )
        )
    }

    private fun updateTimer(nextSeconds: Int) {
        val state = _uiState.value
        val totalSeconds = state.sessionDurationMinutes * 60
        val remainingSeconds = maxOf(0, totalSeconds - nextSeconds)
        _uiState.value = state.copy(
            sessionSeconds = nextSeconds,
            timerText = formatTimer(remainingSeconds)
        )
    }

    private fun transitionTo(
        launcherState: LauncherState,
        inSession: Boolean = _uiState.value.inSession,
        timerSeconds: Int = _uiState.value.sessionSeconds,
        sessionDurationMinutes: Int = _uiState.value.sessionDurationMinutes,
        sessionPackage: String? = _uiState.value.sessionPackage,
        sessionActivity: String? = _uiState.value.sessionActivity
    ) {
        val totalSeconds = sessionDurationMinutes * 60
        val remainingSeconds = maxOf(0, totalSeconds - timerSeconds)

        val baseState = _uiState.value.copy(
            launcherState = launcherState,
            inSession = inSession,
            sessionSeconds = timerSeconds,
            sessionDurationMinutes = sessionDurationMinutes,
            sessionPackage = sessionPackage,
            sessionActivity = sessionActivity
        )

        _uiState.value = when (launcherState) {
            LauncherState.WAITING -> baseState.copy(
                statusText = "Ожидание запуска",
                descriptionText = "Оператор скоро начнёт игру",
                timerText = "00:00",
                timerTone = TimerTone.DEFAULT,
                showBottomActions = true
            )

            LauncherState.STARTING -> baseState.copy(
                statusText = "Подготовка игры",
                descriptionText = "Пожалуйста, наденьте шлем удобно. Игра скоро запустится.",
                timerText = "--:--",
                timerTone = TimerTone.DEFAULT,
                showBottomActions = false
            )

            LauncherState.ACTIVE -> baseState.copy(
                statusText = "Сессия активна",
                descriptionText = sessionPackage ?: "",
                timerText = formatTimer(remainingSeconds),
                timerTone = TimerTone.DEFAULT,
                showBottomActions = true
            )

            LauncherState.FIVE_MIN_WARN -> baseState.copy(
                statusText = "Осталось 5 минут",
                descriptionText = "Если хотите продлить время — позовите оператора",
                timerText = formatTimer(remainingSeconds),
                timerTone = TimerTone.WARNING,
                showBottomActions = true
            )

            LauncherState.FINISHED -> baseState.copy(
                statusText = "Сессия завершена",
                descriptionText = "Пожалуйста, снимите шлем и передайте его оператору",
                timerText = "00:00",
                timerTone = TimerTone.DANGER,
                showBottomActions = false
            )

            LauncherState.ERROR -> baseState.copy(
                statusText = "Нужна помощь оператора",
                descriptionText = "Шлем временно не готов к запуску",
                timerText = "ERR",
                timerTone = TimerTone.DANGER,
                showBottomActions = true
            )
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

    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 5000L
        private const val HEARTBEAT_INTERVAL_SECONDS = 5
        private const val FIVE_MINUTES_SECONDS = 300
        private const val START_DELAY_MS = 3000L
        private const val FINISHED_TO_WAITING_DELAY_MS = 10000L
        private const val AUTO_FINISH_RESET_DELAY_MS = 15000L
        private const val OPERATOR_BANNER_DURATION_MS = 5000L

        private const val KEY_PAIRING_ID = "pairing_id"

        private const val EXTRA_SESSION_ACTION = "SESSION_ACTION"
        private const val EXTRA_DURATION = "DURATION"
        private const val EXTRA_PACKAGE = "PACKAGE"
        private const val EXTRA_ACTIVITY = "ACTIVITY"
        private const val EXTRA_HUB_IP = "HUB_IP"
        private const val EXTRA_HUB_PORT = "HUB_PORT"

        private const val ACTION_START = "START"
        private const val ACTION_STOP = "STOP"
    }
}
