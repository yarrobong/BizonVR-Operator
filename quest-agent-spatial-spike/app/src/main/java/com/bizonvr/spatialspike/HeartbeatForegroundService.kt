package com.bizonvr.spatialspike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

class HeartbeatForegroundService : Service() {
    private var controller: SpatialSessionController? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        Log.i(TAG, "Heartbeat foreground service started")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (controller == null) {
            controller = SpatialSessionController(this, object : SpatialSessionCallbacks {
                override fun launchGame(packageName: String?, activityName: String?) {}
                override fun onSessionFinished(packageName: String?) {}
                override fun openLauncher() {
                    val launcherIntent = Intent(this@HeartbeatForegroundService, SpatialSpikeActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(launcherIntent)
                }
                override fun openGameMenu() {}
            }).also { it.start(heartbeatOwner = true) }
        } else {
            Log.i(TAG, "Heartbeat foreground service already owns the heartbeat loop")
        }
        controller?.handleIntent(intent)
        return START_STICKY
    }

    override fun onDestroy() {
        controller?.stopHeartbeatLoop()
        controller = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "BizonVR Quest Agent",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("BizonVR Quest Agent")
            .setContentText("Sending headset heartbeat to Local Hub")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "BizonVRQuestAgent"
        private const val CHANNEL_ID = "bizonvr_quest_agent_heartbeat"
        private const val NOTIFICATION_ID = 1001
    }
}
