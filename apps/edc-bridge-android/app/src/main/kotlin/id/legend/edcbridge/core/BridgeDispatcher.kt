package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeJson
import id.legend.edcbridge.protocol.ContractViolation
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.LeaseGrant

/** Runs an admitted command on the terminal and returns its answer. Called
 * off the socket thread; must return (timeout, link error) rather than throw. */
fun interface CommandRunner {
    fun run(command: Downlink.Command, grant: LeaseGrant, done: (Answer) -> Unit)
}

/** The socket side the dispatcher talks to. */
interface Uplink {
    /** False when the socket is gone; the result stays in the journal. */
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
}

/**
 * One WSS session's message handling, socket-library free: hello on open,
 * resend every unacked result after the first lease, commands through
 * [BridgeCore], acks and releases into the journal.
 */
class BridgeDispatcher(
    private val core: BridgeCore,
    private val runner: CommandRunner,
    private val onGoodbye: (String) -> Unit = {},
) {
    private var uplink: Uplink? = null
    private var resentThisSession = false

    @Synchronized
    fun onOpen(socket: Uplink) {
        uplink = socket
        resentThisSession = false
        socket.send(BridgeJson.encodeHello(core.hello()))
    }

    @Synchronized
    fun onClosed() {
        uplink = null
    }

    fun onMessage(text: String) {
        val message = try {
            BridgeJson.parseDownlink(text)
        } catch (e: ContractViolation) {
            synchronized(this) { uplink }?.close(1008, "contract")
            return
        }
        when (message) {
            is Downlink.Lease -> {
                core.onLease(message)
                resendOnce()
            }
            is Downlink.Command -> when (val admission = core.admit(message)) {
                is Admission.Reply -> send(BridgeJson.encodeResult(admission.result))
                is Admission.Run -> runner.run(admission.command, admission.grant) { answer ->
                    send(BridgeJson.encodeResult(core.complete(admission.command, answer)))
                }
            }
            is Downlink.Ack -> core.onAck(message)
            is Downlink.SaleRecordRelease -> core.onRelease(message)
            is Downlink.Goodbye -> onGoodbye(message.reason)
        }
    }

    private fun resendOnce() {
        val pending = synchronized(this) {
            if (resentThisSession) return
            resentThisSession = true
            core.pending()
        }
        for (result in pending) if (!send(BridgeJson.encodeResult(result))) return
    }

    private fun send(text: String): Boolean = synchronized(this) { uplink }?.send(text) ?: false
}
