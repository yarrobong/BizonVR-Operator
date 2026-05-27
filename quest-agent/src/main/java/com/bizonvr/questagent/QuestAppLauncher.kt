package com.bizonvr.questagent

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent

object QuestAppLauncher {
    fun launchGame(context: Context, packageName: String?, activityName: String?): Boolean {
        packageName ?: return false

        return runCatching {
            val launchIntent = activityName
                ?.takeIf { it.contains("/") }
                ?.let { Intent(Intent.ACTION_MAIN).apply {
                    component = ComponentName.unflattenFromString(it)
                    addCategory("com.oculus.intent.category.VR")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                } }
                ?: context.packageManager.getLaunchIntentForPackage(packageName)

            launchIntent?.let {
                context.startActivity(it)
                true
            } ?: false
        }.getOrDefault(false)
    }

    fun killBackgroundProcesses(context: Context, packageName: String?) {
        packageName ?: return
        runCatching {
            val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            activityManager.killBackgroundProcesses(packageName)
        }
    }

    fun bringToFront(context: Context, activityClass: Class<*>) {
        val intent = Intent(context, activityClass).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }
        context.startActivity(intent)
    }
}
