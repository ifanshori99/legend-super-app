package id.legend.edcbridge.link

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.Framing
import id.legend.edcbridge.protocol.LeaseGrant
import id.legend.edcbridge.protocol.Link
import id.legend.edcbridge.protocol.Op
import id.legend.edcbridge.protocol.RefusalReason
import id.legend.edcbridge.protocol.TransportErrorKind
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Service stop (P3 review B3): no TCP link to the EDC outlives the runner. */
class TerminalRunnerTest {
    private val grant = LeaseGrant(
        "3f0e2a4c-1b2d-4c3e-8f40-5a6b7c8d9e01",
        "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d",
        120_000,
        Link.Lan("192.168.1.50", 9000),
        Framing.STX_BCDLEN_ETX_LRC,
    )

    private fun command(n: Int) = Downlink.Command(
        "0b1c2d3e-4f50-4162-a374-%012d".format(n),
        grant.leaseId,
        grant.terminalId,
        Op.SALE,
        "000123",
        "AAAA",
        300_000,
    )

    @Test
    fun `shutdown closes the open EDC link, the run ends disconnected, nothing new connects`() {
        ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
            val accepted = AtomicInteger()
            val peerClosed = CountDownLatch(1)
            Thread {
                while (!server.isClosed) {
                    val peer = try {
                        server.accept()
                    } catch (e: Exception) {
                        break
                    }
                    accepted.incrementAndGet()
                    Thread {
                        peer.use { s ->
                            val input = s.getInputStream()
                            var b = input.read()
                            while (b >= 0) b = input.read() // drain until closed
                        }
                        peerClosed.countDown()
                    }.start()
                }
            }.apply { isDaemon = true }.start()
            // The leased address is private; tests reach the local server instead.
            val connector = TerminalConnector { SocketByteLink(Socket(InetAddress.getLoopbackAddress(), server.localPort)) }
            val runner = TerminalRunner(connector, Executors.newCachedThreadPool())
            val answer = AtomicReference<Answer>()
            runner.run(command(1), grant) { answer.set(it) }
            while (accepted.get() == 0) Thread.sleep(10)

            assertTrue(runner.shutdown(5_000))
            assertEquals(Answer.TransportError(TransportErrorKind.DISCONNECTED), answer.get())
            assertTrue(peerClosed.await(5, TimeUnit.SECONDS))

            val late = AtomicReference<Answer>()
            runner.run(command(2), grant) { late.set(it) }
            Thread.sleep(100)
            assertEquals(null, late.get())
            assertEquals(1, accepted.get())
        }
    }

    @Test
    fun `a link that cannot open is link_down`() {
        val runner = TerminalRunner({ throw java.io.IOException("no route") }, Executors.newSingleThreadExecutor())
        val answer = AtomicReference<Answer>()
        runner.run(command(1), grant) { answer.set(it) }
        assertTrue(runner.shutdown(5_000))
        assertEquals(Answer.Refused(RefusalReason.LINK_DOWN), answer.get())
    }
}
