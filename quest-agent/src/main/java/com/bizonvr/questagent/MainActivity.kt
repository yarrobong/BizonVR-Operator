package com.bizonvr.questagent

import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.View
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.bizonvr.questagent.databinding.ActivityMainBinding
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity(), AgentSessionCallbacks {
    companion object {
        private const val TAG = "BizonVRQuestAgent"
    }

    private lateinit var binding: ActivityMainBinding
    private lateinit var sessionController: AgentSessionController

    private var isKioskMode: Boolean = false

    private fun enterFullscreen() {
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            enterFullscreen()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enterFullscreen()
        Log.i(TAG, "onCreate")

        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        sessionController = AgentSessionController(this, this)

        binding.callOperatorBtn.setOnClickListener {
            sessionController.callOperator()
        }
        binding.menuBtn.setOnClickListener {
            Toast.makeText(this, "Загрузка списка игр...", Toast.LENGTH_SHORT).show()
        }
        binding.kioskBtn.setOnClickListener {
            if (isKioskMode) {
                promptExitKiosk()
            }
        }

        observeLauncherState()
        sessionController.handleIntent(intent)
        sessionController.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Log.i(TAG, "onNewIntent")
        sessionController.handleIntent(intent)
    }

    override fun launchGame(packageName: String?, activityName: String?) {
        if (!QuestAppLauncher.launchGame(this, packageName, activityName)) {
            Toast.makeText(this, "Не удалось запустить игру", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onSessionFinished(packageName: String?) {
        QuestAppLauncher.killBackgroundProcesses(this, packageName)
    }

    override fun openLauncher() {
        QuestAppLauncher.bringToFront(this, MainActivity::class.java)
    }

    override fun onDestroy() {
        super.onDestroy()
        sessionController.stop()
    }

    private fun observeLauncherState() {
        lifecycleScope.launch {
            repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
                sessionController.uiState.collect { uiState ->
                    render(uiState)
                }
            }
        }
    }

    private fun render(uiState: LauncherUiState) {
        binding.pairingIdText.text = "ID: ${uiState.pairingId}"
        binding.mainStatusText.text = uiState.transientBanner ?: uiState.statusText
        binding.mainStatusText.setTextColor(
            when {
                uiState.transientBanner != null ->
                    ContextCompat.getColor(this, R.color.vr_danger)
                else ->
                    ContextCompat.getColor(this, R.color.vr_text_main)
            }
        )
        binding.mainDescText.text = uiState.descriptionText
        binding.timerText.text = uiState.timerText
        binding.timerText.setTextColor(
            ContextCompat.getColor(
                this,
                when (uiState.timerTone) {
                    TimerTone.DEFAULT -> R.color.vr_text_main
                    TimerTone.WARNING -> R.color.vr_warning
                    TimerTone.DANGER -> R.color.vr_danger
                }
            )
        )
        binding.bottomActions.visibility = if (uiState.showBottomActions) View.VISIBLE else View.GONE
        binding.wifiStatus.text = uiState.wifiStatus
        binding.agentStatus.text = uiState.agentStatus
        binding.batteryStatus.text = uiState.batteryStatus
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
                    runCatching {
                        stopLockTask()
                        isKioskMode = false
                        binding.kioskBtn.visibility = View.GONE
                    }
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }
}
