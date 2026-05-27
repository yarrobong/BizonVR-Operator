buildscript {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }

  configurations.classpath {
    resolutionStrategy.force(
        "org.jetbrains.kotlin:kotlin-compiler-embeddable:2.1.0",
        "org.jetbrains.kotlin:kotlin-daemon-client:2.1.0",
        "org.jetbrains.kotlin:kotlin-reflect:2.1.0",
        "org.jetbrains.kotlin:kotlin-stdlib:2.1.0",
        "org.jetbrains.kotlin:kotlin-stdlib-jdk7:2.1.0",
        "org.jetbrains.kotlin:kotlin-stdlib-jdk8:2.1.0",
    )
  }

  dependencies {
    classpath("com.android.tools.build:gradle:8.5.0")
    classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.0")
    classpath("org.jetbrains.kotlin:compose-compiler-gradle-plugin:2.1.0")
    classpath("com.meta.spatial:spatial-gradle-plugin-impl:0.13.0")
  }
}
