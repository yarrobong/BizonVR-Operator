plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
  id("com.meta.spatial.plugin")
}

android {
  namespace = "com.bizonvr.spatialspike"
  compileSdk = 34

  defaultConfig {
    applicationId = "com.bizonvr.spatialspike"
    minSdk = 34
    targetSdk = 34
    versionCode = 1
    versionName = "1.0"
    val heartbeatIntervalMs = (project.findProperty("bizonvrHeartbeatIntervalMs") as String?) ?: "5000"
    buildConfigField("long", "HEARTBEAT_INTERVAL_MS", "${heartbeatIntervalMs}L")
  }

  packaging { resources.excludes.add("META-INF/LICENSE") }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
  }

  buildFeatures {
    buildConfig = true
    compose = true
  }

  composeOptions {
    kotlinCompilerExtensionVersion = "1.5.15"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.ui)
  implementation(libs.androidx.ui.graphics)
  implementation(libs.androidx.ui.tooling.preview)
  implementation(libs.androidx.material3)
  implementation(libs.jetbrains.kotlinx.coroutines.android)
  debugImplementation(libs.androidx.ui.tooling)

  implementation(libs.meta.spatial.sdk.base)
  implementation(libs.meta.spatial.sdk.compose)
  implementation(libs.meta.spatial.sdk.toolkit)
  implementation(libs.meta.spatial.sdk.vr)
}

spatial {
  allowUsageDataCollection.set(true)
}
