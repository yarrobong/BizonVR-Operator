package com.bizonvr.questagent

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import android.app.AlertDialog
import android.text.InputType
import android.widget.EditText
import android.app.ActivityManager
import androidx.appcompat.app.AppCompatActivity
import java.util.UUID

class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView
    private lateinit var pairingIdText: TextView
    private lateinit var timerText: TextView
    private lateinit var callOperatorBtn: Button
    private lateinit var kioskBtn: Button

    private var pairingId: String = ""
    private var inSession: Boolean = false
    private var sessionSeconds: Int = 0
    private var sessionDurationMinutes: Int = 30
    private var sessionPackage: String? = null
    private var fiveMinsWarned: Boolean = false
    private var isKioskMode: Boolean = false

    private val handler = Handler(Looper.getMainLooper())
    private val heartbeatRunnable = object : Runnable {
        override fun run() {
            if (inSession) {
                sessionSeconds += 5
                
                val remainingSeconds = (sessionDurationMinutes * 60) - sessionSeconds
                if (remainingSeconds <= 300 && remainingSeconds > 0 && !fiveMinsWarned) {
                    fiveMinsWarned = true
                    showFiveMinuteWarning()
                } else if (remainingSeconds <= 0) {
                    endSessionAutomatically()
                }
                
                updateTimerDisplay()
            }
            sendHeartbeat()
            handler.postDelayed(this, 5000) // 5 second heartbeat
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        pairingId = generatePairingId()

        val rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F1115"))
            setPadding(32, 32, 32, 32)
        }

        val titleText = TextView(this).apply {
            text = "BizonVR Club Launcher"
            textSize = 32f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 32)
        }

        pairingIdText = TextView(this).apply {
            text = "Pairing ID: $pairingId"
            textSize = 24f
            setTextColor(Color.parseColor("#3B82F6"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
        }

        statusText = TextView(this).apply {
            text = "Status: WAITING FOR SESSION"
            textSize = 28f
            setTextColor(Color.parseColor("#10B981"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 24)
        }

        timerText = TextView(this).apply {
            text = "00:00"
            textSize = 48f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 48)
        }

        callOperatorBtn = Button(this).apply {
            text = "CALL OPERATOR"
            textSize = 24f
            setBackgroundColor(Color.parseColor("#EF4444"))
            setTextColor(Color.WHITE)
            setPadding(32, 16, 32, 16)
            setOnClickListener {
                callOperator()
            }
        }

        kioskBtn = Button(this).apply {
            text = "ENTER KIOSK MODE"
            textSize = 18f
            setBackgroundColor(Color.parseColor("#374151"))
            setTextColor(Color.WHITE)
            setPadding(32, 16, 32, 16)
            setOnClickListener {
                if (isKioskMode) {
                    promptExitKiosk()
                } else {
                    try {
                        startLockTask()
                        isKioskMode = true
                        text = "EXIT KIOSK MODE"
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                }
            }
        }

        rootLayout.addView(titleText)
        rootLayout.addView(pairingIdText)
        rootLayout.addView(statusText)
        rootLayout.addView(timerText)
        rootLayout.addView(callOperatorBtn)
        
        val spacer = android.view.View(this).apply {
            layoutParams = LinearLayout.LayoutParams(1, 48)
        }
        rootLayout.addView(spacer)
        rootLayout.addView(kioskBtn)

        setContentView(rootLayout)
        
        handleIntent(intent)
        startHeartbeat()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent?.let {
            if (it.hasExtra("SESSION_ACTION")) {
                val action = it.getStringExtra("SESSION_ACTION")
                if (action == "START") {
                    inSession = true
                    sessionSeconds = 0
                    sessionDurationMinutes = it.getIntExtra("DURATION", 30)
                    sessionPackage = it.getStringExtra("PACKAGE")
                    fiveMinsWarned = false
                    
                    statusText.text = "STATUS: IN SESSION"
                    statusText.setTextColor(Color.parseColor("#3B82F6"))
                    
                    // Launch the game if package is provided
                    sessionPackage?.let { pkg ->
                        try {
                            val launchIntent = packageManager.getLaunchIntentForPackage(pkg)
                            if (launchIntent != null) {
                                startActivity(launchIntent)
                            } else {
                                Toast.makeText(this, "App not found: $pkg", Toast.LENGTH_SHORT).show()
                            }
                        } catch (e: Exception) {
                            e.printStackTrace()
                        }
                    }
                } else if (action == "STOP") {
                    inSession = false
                    sessionSeconds = 0
                    fiveMinsWarned = false
                    statusText.text = "STATUS: WAITING FOR SESSION"
                    statusText.setTextColor(Color.parseColor("#10B981"))
                    timerText.text = "00:00"
                }
            }
        }
    }
    
    private fun promptExitKiosk() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
        AlertDialog.Builder(this)
            .setTitle("Enter PIN to Exit")
            .setView(input)
            .setPositiveButton("OK") { _, _ ->
                if (input.text.toString() == "1234") {
                    try {
                        stopLockTask()
                        isKioskMode = false
                        kioskBtn.text = "ENTER KIOSK MODE"
                    } catch (e: Exception) {
                        e.printStackTrace()
                    }
                } else {
                    Toast.makeText(this, "Incorrect PIN", Toast.LENGTH_SHORT).show()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showFiveMinuteWarning() {
        handler.post {
            Toast.makeText(this, "SESSION ENDS IN 5 MINUTES!", Toast.LENGTH_LONG).show()
        }
    }

    private fun endSessionAutomatically() {
        inSession = false
        sessionSeconds = 0
        fiveMinsWarned = false
        
        statusText.text = "STATUS: WAITING FOR SESSION"
        statusText.setTextColor(Color.parseColor("#10B981"))
        timerText.text = "00:00"
        
        // Attempt to kill background process
        sessionPackage?.let { pkg ->
            try {
                val am = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
                am.killBackgroundProcesses(pkg)
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
        
        // Bring launcher to front
        val bringToFrontIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        startActivity(bringToFrontIntent)
    }

    private fun generatePairingId(): String {
        return UUID.randomUUID().toString().substring(0, 6).uppercase()
    }

    private fun updateTimerDisplay() {
        if (!inSession) return
        val remaining = maxOf(0, (sessionDurationMinutes * 60) - sessionSeconds)
        val minutes = remaining / 60
        val seconds = remaining % 60
        timerText.text = String.format("%02d:%02d", minutes, seconds)
    }

    private fun startHeartbeat() {
        handler.post(heartbeatRunnable)
    }

    private fun sendHeartbeat() {
        Thread {
            try {
                val hubIp = intent?.getStringExtra("HUB_IP") ?: "192.168.1.100"
                val url = java.net.URL("http://$hubIp:3000/api/agent/heartbeat")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                val json = "{\"pairing_id\":\"$pairingId\",\"in_session\":$inSession,\"session_seconds\":$sessionSeconds}"
                conn.outputStream.write(json.toByteArray())
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                // Ignore network errors in MVP
            }
        }.start()
    }

    private fun callOperator() {
        statusText.text = "OPERATOR NOTIFIED"
        statusText.setTextColor(Color.parseColor("#F59E0B"))
        
        Thread {
            try {
                val hubIp = intent?.getStringExtra("HUB_IP") ?: "192.168.1.100"
                val url = java.net.URL("http://$hubIp:3000/api/agent/call_operator")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                val json = "{\"pairing_id\":\"$pairingId\"}"
                conn.outputStream.write(json.toByteArray())
                conn.responseCode
                conn.disconnect()
            } catch (e: Exception) {
                // Ignore network errors in MVP
            }
        }.start()

        // Reset message after 5 seconds
        handler.postDelayed({
            if (inSession) {
                statusText.text = "STATUS: IN SESSION"
                statusText.setTextColor(Color.parseColor("#3B82F6"))
            } else {
                statusText.text = "STATUS: WAITING FOR SESSION"
                statusText.setTextColor(Color.parseColor("#10B981"))
            }
        }, 5000)
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(heartbeatRunnable)
    }
}
