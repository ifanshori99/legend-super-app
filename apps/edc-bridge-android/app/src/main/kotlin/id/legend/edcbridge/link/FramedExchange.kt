package id.legend.edcbridge.link

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.TransportErrorKind
import java.io.Closeable
import java.io.IOException
import java.util.Base64

/** A byte pipe to the terminal (TCP socket or USB-serial port). */
interface ByteLink : Closeable {
    fun write(bytes: ByteArray)

    /** The next byte (0..255), or null when nothing came within [timeoutMs].
     * Throws [IOException] when the link is gone. */
    fun read(timeoutMs: Long): Int?
}

/**
 * One command on the terminal: send the framed body (resend on NAK, at most
 * [EcrFraming.MAX_RESENDS] times), wait for the response frame, check BCD
 * length, ETX and LRC, ACK it (NAK a bad one, same limit). Anything but a
 * clean response frame is a transport error: the cloud records `unknown` and
 * inquires.
 */
class FramedExchange(
    private val link: ByteLink,
    private val ackTimeoutMs: Long = 2_000,
    private val byteTimeoutMs: Long = 1_000,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    fun exchange(body: ByteArray, timeoutMs: Long): Answer {
        if (body.size > EcrFraming.MAX_BODY) return Answer.TransportError(TransportErrorKind.PROTOCOL)
        val deadline = nowMs() + timeoutMs
        return try {
            send(EcrFraming.frame(body), deadline) ?: receive(deadline)
        } catch (e: IOException) {
            Answer.TransportError(TransportErrorKind.DISCONNECTED)
        }
    }

    /** null once the terminal ACKed the frame. */
    private fun send(frame: ByteArray, deadline: Long): Answer? {
        var sends = 0
        while (true) {
            link.write(frame)
            sends++
            when (link.read(minOf(ackTimeoutMs, remaining(deadline)))) {
                EcrFraming.ACK -> return null
                EcrFraming.NAK -> if (sends > EcrFraming.MAX_RESENDS) return protocolError()
                null -> return Answer.TransportError(TransportErrorKind.TIMEOUT)
                else -> return protocolError()
            }
        }
    }

    private fun receive(deadline: Long): Answer {
        var naks = 0
        while (true) {
            // Skip anything before STX (a repeated ACK, line noise).
            while (true) {
                val b = link.read(remaining(deadline)) ?: return timeout()
                if (b == EcrFraming.STX) break
            }
            val high = readByte(deadline) ?: return timeout()
            val low = readByte(deadline) ?: return timeout()
            val length = EcrFraming.lengthOf(high, low)
            var good = false
            var body = ByteArray(0)
            if (length != null) {
                body = ByteArray(length)
                for (i in 0 until length) body[i] = (readByte(deadline) ?: return timeout()).toByte()
                val etx = readByte(deadline) ?: return timeout()
                val lrc = readByte(deadline) ?: return timeout()
                val expected = high xor low xor EcrFraming.lrc(body) xor EcrFraming.ETX
                good = etx == EcrFraming.ETX && lrc == expected
            }
            if (good) {
                link.write(byteArrayOf(EcrFraming.ACK.toByte()))
                return Answer.Response(Base64.getEncoder().encodeToString(body))
            }
            naks++
            if (naks > EcrFraming.MAX_RESENDS) return protocolError()
            link.write(byteArrayOf(EcrFraming.NAK.toByte()))
        }
    }

    private fun readByte(deadline: Long): Int? = link.read(minOf(byteTimeoutMs, remaining(deadline)))

    private fun remaining(deadline: Long): Long = (deadline - nowMs()).coerceAtLeast(0)

    private fun timeout() = Answer.TransportError(TransportErrorKind.TIMEOUT)

    private fun protocolError() = Answer.TransportError(TransportErrorKind.PROTOCOL)
}
