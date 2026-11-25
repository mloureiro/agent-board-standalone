package com.mloureiro.agentboard.boardnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

object Notifier {
    const val EXTRA_TASK = "agentboard.task"
    const val WATCH_ID = 1
    private const val ATTENTION_CHANNEL = "attention"
    private const val WATCH_CHANNEL = "watch"

    @Volatile
    var inFront = false

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(ATTENTION_CHANNEL, "Tasks that need you", NotificationManager.IMPORTANCE_DEFAULT),
        )
        manager.createNotificationChannel(
            NotificationChannel(WATCH_CHANNEL, "Watching for tasks", NotificationManager.IMPORTANCE_MIN),
        )
    }

    fun raise(context: Context, serverId: String, taskId: String, text: String) {
        if (inFront) return
        ensureChannels(context)
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        launch.putExtra(EXTRA_TASK, taskId)
        val id = (serverId + taskId).hashCode()
        val tap = PendingIntent.getActivity(
            context,
            id,
            launch,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, ATTENTION_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                NotificationCompat.Builder(context, ATTENTION_CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("A task needs you")
                    .build(),
            )
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, notification)
    }

    fun watching(context: Context): Notification {
        ensureChannels(context)
        return NotificationCompat.Builder(context, WATCH_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Watching for tasks that need you")
            .setOngoing(true)
            .build()
    }
}
