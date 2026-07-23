package com.syncboard.android.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class WsClient(
    private val scope: CoroutineScope,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build(),
    private val json: kotlinx.serialization.json.Json,
    private val deviceNameProvider: suspend () -> String = { "Android" },
) {
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private val closed = AtomicBoolean(false)

    private val _messages = MutableSharedFlow<WsMessage>(extraBufferCapacity = 64)
    val messages: SharedFlow<WsMessage> = _messages

    private val _connected = MutableSharedFlow<Boolean>(replay = 1, extraBufferCapacity = 1)
    val connected: SharedFlow<Boolean> = _connected

    fun connect(serverUrl: String) {
        closed.set(false)
        reconnectJob?.cancel()
        socket?.close(1000, null)
        open(serverUrl)
    }

    fun disconnect() {
        closed.set(true)
        reconnectJob?.cancel()
        socket?.close(1000, null)
        socket = null
        _connected.tryEmit(false)
    }

    private fun open(serverUrl: String) {
        val wsUrl = serverUrl.trimEnd('/')
            .replace("https://", "wss://")
            .replace("http://", "ws://") + "/ws"
        val req = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                _connected.tryEmit(true)
                scope.launch {
                    val name = runCatching { deviceNameProvider() }.getOrDefault("Android")
                        .replace("\\", "\\\\")
                        .replace("\"", "\\\"")
                    webSocket.send("""{"type":"hello","deviceName":"$name"}""")
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val msg = json.decodeFromString(WsMessage.serializer(), text)
                    _messages.tryEmit(msg)
                } catch (_: Exception) {
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                _connected.tryEmit(false)
                scheduleReconnect(serverUrl)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _connected.tryEmit(false)
                scheduleReconnect(serverUrl)
            }
        })
    }

    private fun scheduleReconnect(serverUrl: String) {
        if (closed.get()) return
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(2500)
            if (isActive && !closed.get()) open(serverUrl)
        }
    }
}
