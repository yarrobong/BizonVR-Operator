package com.bizonvr.spatialspike

enum class LauncherState {
    WAITING,
    STARTING,
    ACTIVE,
    PAUSED,
    FIVE_MIN_WARN,
    FINISHED,
    ERROR
}

enum class TimerTone {
    DEFAULT,
    WARNING,
    DANGER
}
