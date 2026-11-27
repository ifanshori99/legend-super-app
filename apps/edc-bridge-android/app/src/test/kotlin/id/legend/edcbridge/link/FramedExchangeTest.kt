package id.legend.edcbridge.link

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.TransportErrorKind
import java.io.IOException
import java.util.ArrayDeque
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FramedExchangeTest {
    /**
     * Scripted terminal: [onWrite] answers each write with bytes to queue.
     * Reads with nothing queued advance a fake clock by the timeout.
     */
    private class ScriptedLink(private val onWrite: (ByteArray) -> ByteArray) : ByteLink {
        val writes = mutableListOf<ByteArray>()
        val inbox = ArrayDeque<Int>()
        var now = 0L
        var failOnRead = false

        override fun write(bytes: ByteArray) {
            writes += bytes
            onWrite(bytes).forEach { inbox.add(it.toInt() and 0xff) }
        }

        override fun read(timeoutMs: Long): Int? {
            if (failOnRead) throw IOException("gone")
            if (inbox.isEmpty()) {
                now += timeoutMs.coerceAtLeast(1)
                return null
            }
            return inbox.poll()
        }

        override fun close() {}
    }

    private val body = "REQ".toByteArray()
    private val answer = "RESP-00".toByteArray()
    private val ack = byteArrayOf(EcrFraming.ACK.toByte())
    private val nak = byteArrayOf(EcrFraming.NAK.toByte())

    private fun exchange(link: ScriptedLink, timeoutMs: Long = 10_000) =
        FramedExchange(link, nowMs = { link.now }).exchange(body, timeoutMs)

    @Test
    fun `frame layout and LRC`() {
        val framed = EcrFraming.frame("Hello".toByteArray())
        assertEquals("02000548656c6c6f03", framed.copyOf(framed.size - 1).joinToString("") { "%02x".format(it) })
        assertEquals(0x00 xor 0x05 xor 0x48 xor 0x65 xor 0x6c xor 0x6c xor 0x6f xor 0x03, framed.last().toInt() and 0xff)
        assertEquals(1234, EcrFraming.lengthOf(0x12, 0x34))
        assertNull(EcrFraming.lengthOf(0x1a, 0x00))
    }

    @Test
    fun `ACK then response frame is answered with ACK and returned raw`() {
        val link = ScriptedLink { if (it.size > 1) ack + EcrFraming.frame(answer) else ByteArray(0) }
        assertEquals(Answer.Response(Base64.getEncoder().encodeToString(answer)), exchange(link))
        assertEquals(EcrFraming.frame(body).toList(), link.writes[0].toList())
        assertEquals(ack.toList(), link.writes[1].toList())
    }

    @Test
    fun `NAK resends the frame at most 3 times`() {
        var naks = 3
        val ok = ScriptedLink { if (it.size > 1) (if (naks-- > 0) nak else ack + EcrFraming.frame(answer)) else ByteArray(0) }
        assertEquals("response", (exchange(ok) as? Answer.Response)?.let { "response" })
        assertEquals(5, ok.writes.size) // 4 sends + final ACK

        val stubborn = ScriptedLink { if (it.size > 1) nak else ByteArray(0) }
        assertEquals(Answer.TransportError(TransportErrorKind.PROTOCOL), exchange(stubborn))
        assertEquals(4, stubborn.writes.size)
    }

    @Test
    fun `a bad LRC is NAKed and the resent frame accepted, at most 3 NAKs`() {
        val bad = EcrFraming.frame(answer).also { it[it.size - 1] = (it.last().toInt() xor 0xff).toByte() }
        var corrupt = 3
        val link = ScriptedLink { written ->
            when {
                written.size > 1 -> ack + bad
                written[0].toInt() == EcrFraming.NAK -> if (--corrupt > 0) bad else EcrFraming.frame(answer)
                else -> ByteArray(0)
            }
        }
        assertEquals(Answer.Response(Base64.getEncoder().encodeToString(answer)), exchange(link))

        val never = ScriptedLink { written -> if (written.size > 1) ack + bad else if (written[0].toInt() == EcrFraming.NAK) bad else ByteArray(0) }
        assertEquals(Answer.TransportError(TransportErrorKind.PROTOCOL), exchange(never))
        assertEquals(1 + 3, never.writes.size) // the frame + 3 NAKs, never an ACK
    }

    @Test
    fun `no ACK or no response is timeout, a dropped link is disconnected, garbage is protocol`() {
        assertEquals(Answer.TransportError(TransportErrorKind.TIMEOUT), exchange(ScriptedLink { ByteArray(0) }))
        assertEquals(
            Answer.TransportError(TransportErrorKind.TIMEOUT),
            exchange(ScriptedLink { if (it.size > 1) ack else ByteArray(0) }),
        )
        assertEquals(
            Answer.TransportError(TransportErrorKind.PROTOCOL),
            exchange(ScriptedLink { byteArrayOf(0x41) }),
        )
        val gone = ScriptedLink { ByteArray(0) }.apply { failOnRead = true }
        assertEquals(Answer.TransportError(TransportErrorKind.DISCONNECTED), exchange(gone))
    }

    @Test
    fun `noise before STX is skipped`() {
        val link = ScriptedLink { if (it.size > 1) ack + byteArrayOf(0x06, 0x00) + EcrFraming.frame(answer) else ByteArray(0) }
        assertEquals(Answer.Response(Base64.getEncoder().encodeToString(answer)), exchange(link))
    }
}
