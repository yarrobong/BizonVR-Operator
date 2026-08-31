package com.bizonvr.spatialspike

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

data class HeartbeatSnapshot(
    val agentToken: String,
    val pairingId: String,
    val agentId: String,
    val androidId: String,
    val model: String,
    val inSession: Boolean,
    val sessionSeconds: Int,
    val remainingSeconds: Int,
    val sessionStatus: String,
    val paused: Boolean,
    val currentAppPackage: String?,
    val currentAppName: String?,
    val sessionId: Long?,
    val sessionRevision: Long,
    val launcherState: LauncherState,
    val hubIp: String,
    val hubPort: Int,
    val stableId: String?,
    val localIp: String?,
    val appVersion: String,
    val timestamp: Long,
    val batteryLevel: Int?,
    val chargingState: String,
    val foregroundState: String
)

class AgentHeartbeatClient {
    companion object {
        private const val TAG = "BizonVRQuestAgent"
        private const val DUPLICATE_HEARTBEAT_WINDOW_MS = 1000L
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val lastHeartbeatAttemptAt = AtomicLong(0L)

    fun sendHeartbeat(snapshot: HeartbeatSnapshot, onResult: (Boolean) -> Unit = {}) {
        if (snapshot.hubIp.isBlank() || snapshot.hubIp == "127.0.0.1" || snapshot.hubIp == "localhost") {
            Log.e(TAG, "Heartbeat skipped: HUB_IP is missing or loopback. Launch agent from Local Hub with real LAN HUB_IP/HUB_PORT.")
            onResult(false)
            return
        }

        val now = System.currentTimeMillis()
        val previousAttemptAt = lastHeartbeatAttemptAt.get()
        if ((now - previousAttemptAt) < DUPLICATE_HEARTBEAT_WINDOW_MS && !lastHeartbeatAttemptAt.compareAndSet(previousAttemptAt, now)) {
            Log.i(TAG, "Heartbeat send deduplicated by client guard")
            onResult(true)
            return
        }
        if ((now - previousAttemptAt) < DUPLICATE_HEARTBEAT_WINDOW_MS) {
            Log.i(TAG, "Heartbeat send deduplicated by client guard")
            onResult(true)
            return
        }
        lastHeartbeatAttemptAt.set(now)

        val body = JSONObject()
            .put("pairing_id", snapshot.pairingId)
            .put("agent_id", snapshot.agentId)
            .put("stable_id", snapshot.stableId)
            .put("android_id", snapshot.androidId)
            .put("local_ip", snapshot.localIp)
            .put("app_version", snapshot.appVersion)
            .put("timestamp", snapshot.timestamp)
            .put("battery_level", snapshot.batteryLevel)
            .put("charging_state", snapshot.chargingState)
            .put("foreground_state", snapshot.foregroundState)
            .put("model", snapshot.model)
            .put("in_session", snapshot.inSession)
            .put("session_seconds", snapshot.sessionSeconds)
            .put("remaining_seconds", snapshot.remainingSeconds)
            .put("session_status", snapshot.sessionStatus)
            .put("paused", snapshot.paused)
            .put("current_app_package", snapshot.currentAppPackage)
            .put("current_app_name", snapshot.currentAppName)
            .put("session_id", snapshot.sessionId)
            .put("session_revision", snapshot.sessionRevision)
            .put("state", snapshot.launcherState.name)
            .toString()
        postJson(
            url = "http://${snapshot.hubIp}:${snapshot.hubPort}/api/agent/heartbeat",
            body = body,
            onResult = onResult,
            authorizationToken = snapshot.agentToken
        )
    }

    fun callOperator(pairingId: String, agentToken: String, hubIp: String, hubPort: Int) {
        postJson(
            url = "http://$hubIp:$hubPort/api/agent/call_operator",
            body = """{"pairing_id":"$pairingId","timestamp":${System.currentTimeMillis()}}""",
            authorizationToken = agentToken
        )
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun postJson(url: String, body: String, onResult: (Boolean) -> Unit = {}, authorizationToken: String? = null) {
        executor.execute {
            runCatching {
                Log.i(TAG, "POST $url")
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                authorizationToken?.takeIf { it.isNotBlank() }?.let {
                    connection.setRequestProperty("Authorization", "Bearer $it")
                }
                connection.connectTimeout = 3000
                connection.readTimeout = 3000
                connection.doOutput = true
                connection.outputStream.use { output ->
                    output.write(body.toByteArray())
                }
                val responseCode = connection.responseCode
                Log.i(TAG, "POST $url -> $responseCode")
                connection.disconnect()
                onResult(responseCode in 200..299)
            }.onFailure { error ->
                Log.e(TAG, "POST $url failed: ${error.message}", error)
                onResult(false)
            }
        }
    }
}
