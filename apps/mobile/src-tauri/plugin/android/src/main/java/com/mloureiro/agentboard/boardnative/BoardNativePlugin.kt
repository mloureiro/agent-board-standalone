package com.mloureiro.agentboard.boardnative

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ServerArgs {
    lateinit var serverId: String
}

@InvokeArg
class TokenArgs {
    lateinit var serverId: String
    lateinit var token: String
}

@InvokeArg
class SignArgs {
    lateinit var serverId: String
    lateinit var message: String
}

@InvokeArg
class NotifyArgs {
    lateinit var serverId: String
    lateinit var taskId: String
    lateinit var text: String
}

@TauriPlugin
class BoardNativePlugin(private val activity: Activity) : Plugin(activity) {
    private val keystore = Keystore(activity.applicationContext)
    private var webView: WebView? = null

    @Volatile
    private var pendingTask: String? = null

    inner class LaunchTarget {
        @JavascriptInterface
        fun takeTask(): String {
            val task = pendingTask ?: ""
            pendingTask = null
            return task
        }
    }

    override fun load(webView: WebView) {
        this.webView = webView
        webView.addJavascriptInterface(LaunchTarget(), "AgentBoardLaunch")
        remember(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        remember(intent)
        webView?.post {
            webView?.evaluateJavascript(OPEN_PENDING, null)
        }
    }

    override fun onResume() {
        Notifier.inFront = true
    }

    override fun onPause() {
        Notifier.inFront = false
    }

    private fun remember(intent: Intent?) {
        val task = intent?.getStringExtra(Notifier.EXTRA_TASK) ?: return
        if (TASK_ID.matches(task)) pendingTask = task
        intent.removeExtra(Notifier.EXTRA_TASK)
    }

    @Command
    fun serviceStart(invoke: Invoke) = answer(invoke) {
        askForNotificationPermission()
        ContextCompat.startForegroundService(
            activity,
            Intent(activity, AttentionService::class.java),
        )
        JSObject()
    }

    @Command
    fun serviceStop(invoke: Invoke) = answer(invoke) {
        activity.stopService(Intent(activity, AttentionService::class.java))
        JSObject()
    }

    @Command
    fun notify(invoke: Invoke) = answer(invoke) {
        val args = invoke.parseArgs(NotifyArgs::class.java)
        Notifier.raise(activity.applicationContext, args.serverId, args.taskId, args.text)
        JSObject()
    }

    private fun askForNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    @Command
    fun tokenGet(invoke: Invoke) = answer(invoke) {
        val args = invoke.parseArgs(ServerArgs::class.java)
        JSObject().put("value", keystore.tokenGet(args.serverId))
    }

    @Command
    fun tokenSet(invoke: Invoke) = answer(invoke) {
        val args = invoke.parseArgs(TokenArgs::class.java)
        keystore.tokenSet(args.serverId, args.token)
        JSObject()
    }

    @Command
    fun tokenDelete(invoke: Invoke) = answer(invoke) {
        keystore.tokenDelete(invoke.parseArgs(ServerArgs::class.java).serverId)
        JSObject()
    }

    @Command
    fun publicKey(invoke: Invoke) = answer(invoke) {
        JSObject().put("value", keystore.publicKey(invoke.parseArgs(ServerArgs::class.java).serverId))
    }

    @Command
    fun sign(invoke: Invoke) = answer(invoke) {
        val args = invoke.parseArgs(SignArgs::class.java)
        val message = Base64.decode(args.message, Base64.DEFAULT)
        JSObject().put("value", keystore.sign(args.serverId, message))
    }

    @Command
    fun deleteKey(invoke: Invoke) = answer(invoke) {
        keystore.deleteKey(invoke.parseArgs(ServerArgs::class.java).serverId)
        JSObject()
    }

    private fun answer(invoke: Invoke, block: () -> JSObject) {
        try {
            invoke.resolve(block())
        } catch (error: Exception) {
            invoke.reject(error.message ?: error.javaClass.simpleName)
        }
    }

    private companion object {
        val TASK_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        const val OPEN_PENDING =
            "(function(){var t=window.AgentBoardLaunch&&AgentBoardLaunch.takeTask();" +
                "if(t){history.pushState(null,'','/tasks/'+t);" +
                "window.dispatchEvent(new PopStateEvent('popstate'));}})()"
    }
}
