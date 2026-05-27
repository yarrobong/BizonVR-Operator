package com.bizonvr.questagent

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.TextUnit
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

class SpatialLauncherActivity : AppSystemActivity(), AgentSessionCallbacks {
    private lateinit var sessionController: AgentSessionController

    override fun registerFeatures(): List<SpatialFeature> {
        return listOf(
            VRFeature(this),
            ComposeFeature(),
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionController = AgentSessionController(this, this)
        sessionController.handleIntent(intent)
        sessionController.start()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
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
            R.id.spatial_launcher_panel_entity,
            R.id.spatial_launcher_panel,
            Transform(Pose(Vector3(0f, 1.45f, -1.9f), Quaternion(0f, 180f, 0f))),
        )
    }

    override fun registerPanels(): List<PanelRegistration> {
        return listOf(
            ComposeViewPanelRegistration(
                R.id.spatial_launcher_panel,
                composeViewCreator = { _, context ->
                    ComposeView(context).apply {
                        setContent {
                            val uiState by sessionController.uiState.collectAsState()
                            MaterialTheme {
                                SpatialLauncherPanel(
                                    uiState = uiState,
                                    onCallOperator = { sessionController.callOperator() },
                                    onOpenMenu = {
                                        QuestAppLauncher.bringToFront(
                                            this@SpatialLauncherActivity,
                                            MainActivity::class.java
                                        )
                                    }
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

    override fun launchGame(packageName: String?, activityName: String?) {
        if (!QuestAppLauncher.launchGame(this, packageName, activityName)) {
            Toast.makeText(this, "Не удалось запустить игру", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onSessionFinished(packageName: String?) {
        QuestAppLauncher.killBackgroundProcesses(this, packageName)
    }

    override fun openLauncher() {
        QuestAppLauncher.bringToFront(this, SpatialLauncherActivity::class.java)
    }
}

@Composable
private fun SpatialLauncherPanel(
    uiState: LauncherUiState,
    onCallOperator: () -> Unit,
    onOpenMenu: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        shape = RoundedCornerShape(36.dp),
        color = Color(0xD90A111C),
    ) {
        BoxWithConstraints(
            modifier = Modifier.fillMaxSize()
                .background(
                    brush = Brush.radialGradient(
                        colors = listOf(
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
            val timerColor = when (uiState.timerTone) {
                TimerTone.DEFAULT -> Color(0xFFF8FAFC)
                TimerTone.WARNING -> Color(0xFFFFB545)
                TimerTone.DANGER -> Color(0xFFFF727E)
            }

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
                        modifier = Modifier
                            .border(
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
                            colors = ButtonDefaults.buttonColors(
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
                            colors = ButtonDefaults.buttonColors(
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
        }
    }
}

private fun responsiveText(width: Dp, large: TextUnit, compact: TextUnit) =
    if (width >= 900.dp) large else compact
