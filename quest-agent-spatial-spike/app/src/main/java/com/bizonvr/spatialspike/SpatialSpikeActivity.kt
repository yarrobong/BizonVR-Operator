package com.bizonvr.spatialspike

import android.content.Intent
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.platform.ComposeView
import com.meta.spatial.compose.ComposeFeature
import com.meta.spatial.compose.ComposeViewPanelRegistration
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.Quaternion
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature

class SpatialSpikeActivity : AppSystemActivity() {
  private lateinit var sessionController: SpatialSessionController

  private fun persistHubConnectionFromLaunchIntent(sourceIntent: Intent?) {
    val nextHubIp = sourceIntent?.getStringExtra("HUB_IP")?.trim().orEmpty()
    if (nextHubIp.isBlank() || nextHubIp == "127.0.0.1" || nextHubIp == "localhost" || nextHubIp == "::1") {
      return
    }
    val nextHubPort = sourceIntent?.getIntExtra("HUB_PORT", 3001) ?: 3001
    getSharedPreferences("spatial_quest_agent", Context.MODE_PRIVATE)
      .edit()
      .putString("hub_ip", nextHubIp)
      .putInt("hub_port", nextHubPort)
      .apply()
  }

  private fun startHeartbeatServiceWithLaunchIntent(sourceIntent: Intent?) {
    persistHubConnectionFromLaunchIntent(sourceIntent)
    val serviceIntent = Intent(this, HeartbeatForegroundService::class.java).apply {
      sourceIntent?.extras?.let { putExtras(it) }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      startForegroundService(serviceIntent)
    } else {
      startService(serviceIntent)
    }
  }

  override fun registerFeatures(): List<SpatialFeature> {
    return listOf(
        VRFeature(this),
        ComposeFeature(),
    )
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    startHeartbeatServiceWithLaunchIntent(intent)
    sessionController = SpatialSessionController(this, object : SpatialSessionCallbacks {
      override fun launchGame(packageName: String?, activityName: String?) {
        QuestAppLauncher.launchGame(this@SpatialSpikeActivity, packageName, activityName)
      }

      override fun onSessionFinished(packageName: String?) {
        QuestAppLauncher.killBackgroundProcesses(this@SpatialSpikeActivity, packageName)
      }

      override fun openLauncher() {
        QuestAppLauncher.bringToFront(this@SpatialSpikeActivity, SpatialSpikeActivity::class.java)
      }
    })
    sessionController.handleIntent(intent)
    sessionController.start(heartbeatOwner = false)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    startHeartbeatServiceWithLaunchIntent(intent)
    sessionController.handleIntent(intent)
  }

  override fun onDestroy() {
    super.onDestroy()
    sessionController.stop()
  }

  override fun onSceneReady() {
    super.onSceneReady()

    scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
    scene.setLightingEnvironment(
        ambientColor = Vector3(0.01f, 0.02f, 0.03f),
        sunColor = Vector3(0.14f, 0.20f, 0.26f),
        sunDirection = -Vector3(0.2f, 1.0f, -0.1f),
        environmentIntensity = 0.05f,
    )
    scene.setViewOrigin(0.0f, 0.0f, 2.0f, 180.0f)

    Entity.createPanelEntity(
        R.id.spatial_spike_panel_entity,
        R.id.spatial_spike_panel,
        Transform(Pose(Vector3(0f, 1.45f, -1.9f), Quaternion(0f, 180f, 0f))),
    )
  }

  override fun registerPanels(): List<PanelRegistration> {
    return listOf(
        ComposeViewPanelRegistration(
            R.id.spatial_spike_panel,
            composeViewCreator = { _, context ->
              ComposeView(context).apply {
                setContent {
                  MaterialTheme {
                    val uiState by sessionController.uiState.collectAsState()
                    SpatialSpikePanel(
                        uiState = uiState,
                        onCallOperator = { sessionController.callOperator() },
                        onOpenMenu = { sessionController.openGameMenu() },
                        onCloseMenu = { sessionController.closeGameMenu() }
                    )
                  }
                }
              }
            },
            settingsCreator = {
              UIPanelSettings(
                  shape = QuadShapeOptions(width = 2.048f, height = 1.152f),
                  style = PanelStyleOptions(themeResourceId = R.style.PanelAppThemeTransparent),
                  display = DpPerMeterDisplayOptions(),
              )
            },
        )
    )
  }
}

@Composable
private fun SpatialSpikePanel(
    uiState: LauncherUiState,
    onCallOperator: () -> Unit,
    onOpenMenu: () -> Unit,
    onCloseMenu: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        shape = RoundedCornerShape(36.dp),
        color = Color(0xD90A111C),
    ) {
        BoxWithConstraints(
            modifier =
                Modifier.fillMaxSize()
                    .background(
                        brush =
                            Brush.radialGradient(
                                colors =
                                    listOf(
                                        Color(0x2200E5FF),
                                        Color(0x18070E1A),
                                        Color(0xFF03060B),
                                    )
                            )
                    )
                    .padding(horizontal = 44.dp, vertical = 34.dp)
        ) {
            val headlineSize = responsiveText(maxWidth, large = 138.sp, compact = 112.sp)
            val statusSize = responsiveText(maxWidth, large = 40.sp, compact = 34.sp)
            val bodySize = responsiveText(maxWidth, large = 24.sp, compact = 20.sp)
            val buttonSize = responsiveText(maxWidth, large = 20.sp, compact = 18.sp)
            val footerSize = responsiveText(maxWidth, large = 18.sp, compact = 15.sp)
            val timerColor =
                when (uiState.timerTone) {
                    TimerTone.DEFAULT -> Color(0xFFF8FAFC)
                    TimerTone.WARNING -> Color(0xFFFFB545)
                    TimerTone.DANGER -> Color(0xFFFF727E)
                }

            Box(modifier = Modifier.fillMaxSize()) {
                Column(modifier = Modifier.fillMaxSize()) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "BizonVR Club Mode",
                            color = Color(0xFF00E5FF),
                            fontSize = 27.sp,
                            fontWeight = FontWeight.Bold,
                            modifier = Modifier.weight(1f)
                        )

                        Text(
                            text = "ID: ${uiState.pairingId}",
                            color = Color(0xFF8BF6FF),
                            fontSize = 19.sp,
                            fontWeight = FontWeight.Bold,
                            modifier =
                                Modifier.border(
                                        width = 1.dp,
                                        color = Color(0x5500E5FF),
                                        shape = RoundedCornerShape(999.dp)
                                    )
                                    .padding(horizontal = 18.dp, vertical = 10.dp)
                        )
                    }

                    Spacer(modifier = Modifier.height(34.dp))

                    Column(
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Text(
                            text = uiState.transientBanner ?: uiState.statusText,
                            color = if (uiState.transientBanner != null) Color(0xFFFF727E) else Color(0xFFF8FAFC),
                            fontSize = statusSize,
                            fontWeight = FontWeight.Bold,
                            textAlign = TextAlign.Center
                        )

                        Spacer(modifier = Modifier.height(8.dp))

                        Text(
                            text = uiState.timerText,
                            color = timerColor,
                            fontSize = headlineSize,
                            fontWeight = FontWeight.ExtraBold,
                            textAlign = TextAlign.Center
                        )

                        Spacer(modifier = Modifier.height(12.dp))

                        Text(
                            text = uiState.descriptionText,
                            color = Color(0xFFB6C2CF),
                            fontSize = bodySize,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(0.78f)
                        )
                    }

                    if (uiState.showBottomActions) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.Center
                        ) {
                            Button(
                                onClick = onCallOperator,
                                colors =
                                    ButtonDefaults.buttonColors(
                                        containerColor = Color(0x20FF4D5E),
                                        contentColor = Color(0xFFFF727E)
                                    ),
                                modifier = Modifier.weight(1f).height(72.dp),
                                shape = RoundedCornerShape(20.dp)
                            ) {
                                Text(
                                    text = "Вызвать оператора",
                                    fontSize = buttonSize,
                                    fontWeight = FontWeight.Bold
                                )
                            }

                            Spacer(modifier = Modifier.width(20.dp))

                            Button(
                                onClick = onOpenMenu,
                                colors =
                                    ButtonDefaults.buttonColors(
                                        containerColor = Color(0x2200E5FF),
                                        contentColor = Color(0xFF8BF6FF)
                                    ),
                                modifier = Modifier.weight(1f).height(72.dp),
                                shape = RoundedCornerShape(20.dp)
                            ) {
                                Text(
                                    text = "Меню игр",
                                    fontSize = buttonSize,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    } else {
                        Spacer(modifier = Modifier.height(72.dp))
                    }

                    Spacer(modifier = Modifier.height(22.dp))

                    Text(
                        text = "${uiState.footerLine}, ${uiState.wifiStatus}, ${uiState.agentStatus}, ${uiState.batteryStatus}",
                        color = Color(0xFF94A3B8),
                        fontSize = footerSize,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }

                if (uiState.gameMenuVisible) {
                    GameMenuOverlay(
                        uiState = uiState,
                        onCloseMenu = onCloseMenu
                    )
                }
            }
        }
    }
}

@Composable
private fun GameMenuOverlay(
    uiState: LauncherUiState,
    onCloseMenu: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color(0xEE04070D),
        shape = RoundedCornerShape(28.dp)
    ) {
        Column(
            modifier = Modifier.fillMaxSize().padding(28.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Меню игр",
                        color = Color(0xFFF8FAFC),
                        fontSize = 34.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = uiState.gameMenuStatusText,
                        color = Color(0xFF8CA3B8),
                        fontSize = 18.sp
                    )
                }

                Button(
                    onClick = onCloseMenu,
                    colors =
                        ButtonDefaults.buttonColors(
                            containerColor = Color(0x22FFFFFF),
                            contentColor = Color(0xFFF8FAFC)
                        ),
                    shape = RoundedCornerShape(18.dp)
                ) {
                    Text(text = "Закрыть", fontWeight = FontWeight.Bold)
                }
            }

            Spacer(modifier = Modifier.height(20.dp))

            if (uiState.availableGames.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxWidth().weight(1f),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "На шлеме пока нет доступных игр для клубного меню.",
                        color = Color(0xFFB6C2CF),
                        fontSize = 22.sp,
                        textAlign = TextAlign.Center
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().fillMaxHeight(),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(uiState.availableGames) { game ->
                        Surface(
                            shape = RoundedCornerShape(20.dp),
                            color = if (game.isCurrentSessionApp) Color(0x2200E5FF) else Color(0x120F172A),
                            modifier =
                                Modifier.fillMaxWidth()
                                    .border(
                                        width = 1.dp,
                                        color = if (game.isCurrentSessionApp) Color(0x5500E5FF) else Color(0x22364759),
                                        shape = RoundedCornerShape(20.dp)
                                    )
                        ) {
                            Column(
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)
                            ) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Text(
                                        text = game.displayName,
                                        color = Color(0xFFF8FAFC),
                                        fontSize = 23.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.weight(1f)
                                    )
                                    if (game.isCurrentSessionApp) {
                                        Text(
                                            text = "Сейчас в сессии",
                                            color = Color(0xFF8BF6FF),
                                            fontSize = 15.sp,
                                            fontWeight = FontWeight.Bold,
                                            modifier =
                                                Modifier.border(
                                                        width = 1.dp,
                                                        color = Color(0x4400E5FF),
                                                        shape = RoundedCornerShape(999.dp)
                                                    )
                                                    .padding(horizontal = 12.dp, vertical = 6.dp)
                                        )
                                    }
                                }
                                Spacer(modifier = Modifier.height(6.dp))
                                Text(
                                    text = game.packageName,
                                    color = Color(0xFF8CA3B8),
                                    fontSize = 16.sp
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun responsiveText(
    width: Dp,
    large: androidx.compose.ui.unit.TextUnit,
    compact: androidx.compose.ui.unit.TextUnit
) = if (width >= 900.dp) large else compact
