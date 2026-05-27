package com.bizonvr.questagent

import android.os.Build
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

data class HeartbeatSnapshot(
    val pairingId: String,
    val agentId: String,
    val androidId: String,
    val model: String,
    val inSession: Boolean,
    val sessionSeconds: Int,
    val launcherState: LauncherState,
    val hubIp: String,
    val hubPort: Int
)

class AgentHeartbeatClient {
    companion object {
        private const val TAG = "BizonVRQuestAgent"
    }

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    fun sendHeartbeat(snapshot: HeartbeatSnapshot) {
        postJson(
            url = "http://${snapshot.hubIp}:${snapshot.hubPort}/api/agent/heartbeat",
            body = """
                {"pairing_id":"${snapshot.pairingId}","agent_id":"${snapshot.agentId}","android_id":"${snapshot.androidId}","model":"${snapshot.model}","in_session":${snapshot.inSession},"session_seconds":${snapshot.sessionSeconds},"state":"${snapshot.launcherState}"}
            """.trimIndent()
        )
    }

    fun callOperator(pairingId: String, hubIp: String, hubPort: Int) {
        postJson(
            url = "http://$hubIp:$hubPort/api/agent/call_operator",
            body = """{"pairing_id":"$pairingId","agent_id":"$pairingId","model":"${Build.MODEL}"}"""
        )
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    private fun postJson(url: String, body: String) {
        executor.execute {
            runCatching {
                Log.i(TAG, "POST $url body=$body")
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.setRequestProperty("Content-Type", "application/json")
                connection.connectTimeout = 3000
                connection.readTimeout = 3000
                connection.doOutput = true
                connection.outputStream.use { output ->
                    output.write(body.toByteArray())
                }
                val responseCode = connection.responseCode
                Log.i(TAG, "POST $url -> $responseCode")
                connection.disconnect()
            }.onFailure { error ->
                Log.e(TAG, "POST $url failed: ${error.message}", error)
            }
        }
    }
}
