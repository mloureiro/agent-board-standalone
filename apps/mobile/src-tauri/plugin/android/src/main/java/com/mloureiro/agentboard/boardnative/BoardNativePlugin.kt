package com.mloureiro.agentboard.boardnative

import android.app.Activity
import android.util.Base64
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

@TauriPlugin
class BoardNativePlugin(private val activity: Activity) : Plugin(activity) {
    private val keystore = Keystore(activity.applicationContext)

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
}
