package com.bizonvr.spatialspike

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.UUID

interface SpatialSessionCallbacks {
    fun launchGame(packageName: String?, activityName: String?)
    fun onSessionFinished(packageName: String?)
    fun openLauncher()
    fun openGameMenu()
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
            batteryStatus = currentBatteryStatus()
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

                if (snapshot.inSession) {
                    val nextSeconds = snapshot.sessionSeconds + HEARTBEAT_INTERVAL_SECONDS
                    val totalSessionSeconds = snapshot.sessionDurationMinutes * 60
                    val remainingSeconds = totalSessionSeconds - nextSeconds

                    when {
                        remainingSeconds <= 0 -> endSessionAutomatically()
                        remainingSeconds <= FIVE_MINUTES_SECONDS &&
                            snapshot.launcherState != LauncherState.FIVE_MIN_WARN ->
                            transitionTo(
                                launcherState = LauncherState.FIVE_MIN_WARN,
                                timerSeconds = nextSeconds
                            )
                        else -> updateTimer(nextSeconds)
                    }
                }

                sendHeartbeat()
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }

    private val uiRefreshRunnable =
        object : Runnable {
            override fun run() {
                val snapshot = _uiState.value
                _uiState.value = snapshot.copy(batteryStatus = currentBatteryStatus())

                if (snapshot.inSession) {
                    val nextSeconds = snapshot.sessionSeconds + UI_REFRESH_INTERVAL_SECONDS
                    val totalSessionSeconds = snapshot.sessionDurationMinutes * 60
                    val remainingSeconds = totalSessionSeconds - nextSeconds

                    when {
                        remainingSeconds <= 0 -> endSessionAutomatically()
                        remainingSeconds <= FIVE_MINUTES_SECONDS &&
                            snapshot.launcherState != LauncherState.FIVE_MIN_WARN ->
                            transitionTo(
                                launcherState = LauncherState.FIVE_MIN_WARN,
                                timerSeconds = nextSeconds
                            )
                        else -> updateTimer(nextSeconds)
                    }
                }

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
                        callbacks.launchGame(_uiState.value.sessionPackage, _uiState.value.sessionActivity)
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
        heartbeatClient.callOperator(state.pairingId, state.hubIp, state.hubPort)
        showTransientBanner("ОПЕРАТОР ВЫЗВАН")
    }

    fun openGameMenu() {
        showTransientBanner("МЕНЮ ИГР СКОРО ПОЯВИТСЯ")
        callbacks.openGameMenu()
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
            timerSeconds = 0
        )
        callbacks.onSessionFinished(state.sessionPackage)
        callbacks.openLauncher()
        handler.postDelayed(
            { transitionTo(launcherState = LauncherState.WAITING) },
            AUTO_FINISH_RESET_DELAY_MS
        )
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
                pairingId = state.pairingId,
                agentId = agentId,
                androidId = currentAndroidId(),
                model = Build.MODEL ?: "Meta Quest",
                inSession = state.inSession,
                sessionSeconds = state.sessionSeconds,
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

    private fun updateTimer(nextSeconds: Int) {
        val state = _uiState.value
        val totalSeconds = state.sessionDurationMinutes * 60
        val remainingSeconds = maxOf(0, totalSeconds - nextSeconds)
        _uiState.value =
            state.copy(
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
        val baseState =
            _uiState.value.copy(
                launcherState = launcherState,
                inSession = inSession,
                sessionSeconds = timerSeconds,
                sessionDurationMinutes = sessionDurationMinutes,
                sessionPackage = sessionPackage,
                sessionActivity = sessionActivity,
                batteryStatus = currentBatteryStatus()
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
                        descriptionText = sessionPackage ?: "Игра запущена",
                        timerText = formatTimer(remainingSeconds),
                        timerTone = TimerTone.DEFAULT,
                        showBottomActions = true
                    )

                LauncherState.FIVE_MIN_WARN ->
                    baseState.copy(
                        statusText = "Осталось 5 минут",
                        descriptionText = "Если хотите продлить время — позовите оператора",
                        timerText = formatTimer(remainingSeconds),
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
        runCatching {
            val wifiManager = appContext.getSystemService(WifiManager::class.java)
            val wifiIp = wifiManager?.connectionInfo?.ipAddress ?: 0
            if (wifiIp != 0) {
                val resolvedWifiIp = formatIpv4FromInt(wifiIp)
                if (resolvedWifiIp.isNotBlank() && resolvedWifiIp != "0.0.0.0") {
                    return resolvedWifiIp
                }
            }
        }.onFailure { error ->
            Log.w(TAG, "WifiManager local_ip lookup failed: ${error.message}")
        }

        val connectivityManager = appContext.getSystemService(ConnectivityManager::class.java) ?: return null
        val activeNetwork = connectivityManager.activeNetwork
        val allNetworks = connectivityManager.allNetworks.toList()
        val wifiNetworks = allNetworks.filter { network ->
            val caps = connectivityManager.getNetworkCapabilities(network) ?: return@filter false
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        }

        val candidateNetworks = buildList {
            if (activeNetwork != null) {
                add(activeNetwork)
            }
            addAll(wifiNetworks.filter { it != activeNetwork })
            addAll(allNetworks.filter { it != activeNetwork && !wifiNetworks.contains(it) })
        }

        for (network in candidateNetworks) {
            val linkProperties = connectivityManager.getLinkProperties(network) ?: continue
            val networkCapabilities = connectivityManager.getNetworkCapabilities(network)
            val interfaceName = linkProperties.interfaceName.orEmpty()
            val ipv4 = linkProperties.linkAddresses
                .mapNotNull { it.address }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { address ->
                    !address.isLoopbackAddress &&
                        !address.isLinkLocalAddress &&
                        !address.hostAddress.orEmpty().startsWith("127.")
                }

            val isWifiCandidate = networkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            val isVpnTransport = networkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            if (ipv4 != null && !isVpnTransport && (isWifiCandidate || interfaceName.startsWith("wlan"))) {
                return ipv4.hostAddress
            }
        }

        val wlanFallback = Collections.list(NetworkInterface.getNetworkInterfaces())
            .firstOrNull { networkInterface ->
                networkInterface.isUp && !networkInterface.isLoopback && networkInterface.name.startsWith("wlan")
            }
            ?.inetAddresses
            ?.toList()
            ?.filterIsInstance<Inet4Address>()
            ?.firstOrNull { address ->
                !address.isLoopbackAddress &&
                    !address.isLinkLocalAddress &&
                    !address.hostAddress.orEmpty().startsWith("127.")
            }
            ?.hostAddress

        if (!wlanFallback.isNullOrBlank()) {
            Log.i(TAG, "Resolved active Wi-Fi local_ip from wlan fallback=$wlanFallback")
            return wlanFallback
        }

        Log.w(TAG, "Could not resolve IPv4 local_ip from active Wi-Fi network")
        return null
    }

    private fun formatIpv4FromInt(ip: Int): String {
        return listOf(
            ip and 0xff,
            ip shr 8 and 0xff,
            ip shr 16 and 0xff,
            ip shr 24 and 0xff
        ).joinToString(".")
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
        private const val KEY_HUB_IP = "hub_ip"
        private const val KEY_HUB_PORT = "hub_port"
        private const val KEY_LAST_SUCCESSFUL_HEARTBEAT_AT = "last_successful_heartbeat_at"
        private const val KEY_APP_VERSION = "app_version"
        private const val KEY_LAST_KNOWN_LOCAL_IP = "last_known_local_ip"
        private const val DEFAULT_HUB_PORT = 3001

        private const val EXTRA_SESSION_ACTION = "SESSION_ACTION"
        private const val EXTRA_DURATION = "DURATION"
        private const val EXTRA_PACKAGE = "PACKAGE"
        private const val EXTRA_ACTIVITY = "ACTIVITY"
        private const val EXTRA_HUB_IP = "HUB_IP"
        private const val EXTRA_HUB_PORT = "HUB_PORT"
        private const val EXTRA_MESSAGE = "MESSAGE"

        private const val ACTION_START = "START"
        private const val ACTION_STOP = "STOP"
        private const val ACTION_SHOW_MESSAGE = "SHOW_MESSAGE"
        private const val ACTION_OPEN_LAUNCHER = "OPEN_LAUNCHER"
        private val heartbeatLoopRunning = AtomicBoolean(false)
        private val lastGlobalHeartbeatSentAt = AtomicLong(0L)
    }
}
