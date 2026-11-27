package id.legend.edcbridge.service

import id.legend.edcbridge.core.BridgeDispatcher
import id.legend.edcbridge.core.Uplink
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.random.Random
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * The outbound WSS session to the API. The device token goes only in the
 * upgrade `Authorization` header. Reconnects with backoff until stopped; a
 * `goodbye` decides whether to keep trying.
 */
class WssConnection(
    private val client: OkHttpClient,
    private val url: String,
    private val token: () -> String?,
    private val scheduler: ScheduledExecutorService,
    private val onStatus: (Status) -> Unit,
) {
    enum class Status { CONNECTING, CONNECTED, WAITING, NOT_PAIRED, REVOKED, UPDATE_REQUIRED, STOPPED }

    lateinit var dispatcher: BridgeDispatcher

    private var socket: WebSocket? = null
    private var attempt = 0
    private var stopped = false
    private var nextDelayFloorMs = 0L

    @Synchronized
    fun connect() {
        if (stopped || socket != null) return
        val bearer = token() ?: return onStatus(Status.NOT_PAIRED)
        onStatus(Status.CONNECTING)
        val request = Request.Builder().url(url).header("Authorization", "Bearer $bearer").build()
        socket = client.newWebSocket(request, Listener())
    }

    @Synchronized
    fun stop() {
        stopped = true
        socket?.let {
            it.close(1000, "stopped")
            dispatcher.onClosed()
        }
        socket = null
        onStatus(Status.STOPPED)
    }

    /** `goodbye` from the cloud, just before it closes the socket. */
    @Synchronized
    fun onGoodbye(reason: String) {
        when (reason) {
            "token_revoked" -> {
                stopped = true
                onStatus(Status.REVOKED)
            }
            "protocol_unsupported" -> {
                stopped = true
                onStatus(Status.UPDATE_REQUIRED)
            }
            // Another session holds this token: do not fight over it.
            "replaced_by_newer_session" -> nextDelayFloorMs = 5 * 60_000L
            else -> Unit
        }
    }

    @Synchronized
    private fun dropped(ws: WebSocket) {
        if (socket !== ws) return
        socket = null
        dispatcher.onClosed()
        if (stopped) return
        onStatus(Status.WAITING)
        val backoff = minOf(60_000L, 1_000L shl minOf(attempt, 6))
        val delay = maxOf(nextDelayFloorMs, backoff + Random.nextLong(0, 1_000))
        nextDelayFloorMs = 0
        attempt++
        scheduler.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(this@WssConnection) { attempt = 0 }
            onStatus(Status.CONNECTED)
            dispatcher.onOpen(object : Uplink {
                override fun send(text: String): Boolean = webSocket.send(text)
                override fun close(code: Int, reason: String) {
                    webSocket.close(code, reason)
                }
            })
        }

        override fun onMessage(webSocket: WebSocket, text: String) = dispatcher.onMessage(text)

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            webSocket.close(1003, "text only")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped(webSocket)
    }
}
