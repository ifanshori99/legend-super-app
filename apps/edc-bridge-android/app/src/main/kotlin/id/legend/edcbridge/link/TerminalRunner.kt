package id.legend.edcbridge.link

import id.legend.edcbridge.core.CommandRunner
import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeJson
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.LeaseGrant
import id.legend.edcbridge.protocol.Link
import id.legend.edcbridge.protocol.RefusalReason
import id.legend.edcbridge.protocol.TransportErrorKind
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit

/** Opens the byte pipe a lease points at. Throws [IOException] when it cannot. */
fun interface TerminalConnector {
    fun open(link: Link): ByteLink
}

/** LAN terminals: one TCP connection per command, private IPv4 only. */
class TcpConnector(private val connectTimeoutMs: Int = 3_000) : TerminalConnector {
    override fun open(link: Link): ByteLink {
        if (link !is Link.Lan) throw IOException("not a LAN link")
        // Checked again here: the tablet is never a TCP proxy to the internet.
        if (!BridgeJson.isPrivateIpv4(link.host)) throw IOException("not a private address")
        val socket = Socket()
        try {
            socket.tcpNoDelay = true
            socket.connect(InetSocketAddress(link.host, link.port), connectTimeoutMs)
        } catch (e: IOException) {
            socket.close()
            throw e
        }
        return SocketByteLink(socket)
    }
}

class SocketByteLink(private val socket: Socket) : ByteLink {
    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()

    override fun write(bytes: ByteArray) {
        output.write(bytes)
        output.flush()
    }

    override fun read(timeoutMs: Long): Int? {
        if (timeoutMs <= 0) return null
        socket.soTimeout = timeoutMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        return try {
            val b = input.read()
            if (b < 0) throw IOException("closed by terminal")
            b
        } catch (e: SocketTimeoutException) {
            null
        }
    }

    override fun close() = socket.close()
}

/** Chooses the connector per link kind. USB stays `link_down` until a serial
 * driver is wired in (see docs/design/edc-bridge-android.md). */
class LinkConnectors(
    private val lan: TerminalConnector = TcpConnector(),
    private val usb: TerminalConnector? = null,
) : TerminalConnector {
    override fun open(link: Link): ByteLink = when (link) {
        is Link.Lan -> lan.open(link)
        is Link.Usb -> (usb ?: throw IOException("USB serial not available")).open(link)
    }
}

/**
 * Runs admitted commands on [executor]. Could not open the link: nothing was
 * sent, `refused link_down`. Otherwise [FramedExchange] decides.
 * [shutdown] closes every open terminal link and waits for the runs to
 * finish (their results are journaled), so a later service instance never
 * holds a second connection to the same EDC.
 */
class TerminalRunner(
    private val connector: TerminalConnector,
    private val executor: ExecutorService,
) : CommandRunner {
    private val open: MutableSet<ByteLink> = ConcurrentHashMap.newKeySet()

    @Volatile
    private var stopped = false

    override fun run(command: Downlink.Command, grant: LeaseGrant, done: (Answer) -> Unit) {
        try {
            executor.execute {
                val answer = try {
                    runOnce(command, grant)
                } catch (e: RuntimeException) {
                    Answer.TransportError(TransportErrorKind.PROTOCOL)
                }
                done(answer)
            }
        } catch (e: RejectedExecutionException) {
            // Shutting down: the sale record stays in flight and BridgeCore.recover
            // reports it on the next start.
        }
    }

    /** Stops new runs, closes open links, waits up to [timeoutMs].
     * True when every run finished. */
    fun shutdown(timeoutMs: Long): Boolean {
        stopped = true
        executor.shutdown()
        for (link in open) closeQuietly(link)
        return executor.awaitTermination(timeoutMs, TimeUnit.MILLISECONDS)
    }

    private fun runOnce(command: Downlink.Command, grant: LeaseGrant): Answer {
        val body = Base64.getDecoder().decode(command.frame)
        if (stopped) return Answer.Refused(RefusalReason.LINK_DOWN)
        val link = try {
            connector.open(grant.link)
        } catch (e: IOException) {
            return Answer.Refused(RefusalReason.LINK_DOWN)
        }
        open.add(link)
        try {
            // shutdown() may have run between open() and add().
            if (stopped) return Answer.TransportError(TransportErrorKind.DISCONNECTED)
            return FramedExchange(link).exchange(body, command.timeoutMs)
        } finally {
            open.remove(link)
            closeQuietly(link)
        }
    }

    private fun closeQuietly(link: ByteLink) {
        try {
            link.close()
        } catch (e: IOException) {
            // already closed
        }
    }
}
