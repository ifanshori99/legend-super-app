package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.LeaseGrant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class BridgeDispatcherTest {
    private class FakeSocket : Uplink {
        val sent = mutableListOf<String>()
        var open = true
        var closedWith: Int? = null

        override fun send(text: String): Boolean {
            if (!open) return false
            sent += text
            return true
        }

        override fun close(code: Int, reason: String) {
            closedWith = code
            open = false
        }

        fun types() = sent.map { Json.parseToJsonElement(it).jsonObject["type"]!!.jsonPrimitive.content }

        fun resultIds() = sent.map { Json.parseToJsonElement(it).jsonObject }
            .filter { it["type"]!!.jsonPrimitive.content == "result" }
            .map { it["commandId"]!!.jsonPrimitive.content }
    }

    /** Holds runs until the test completes them. */
    private class HeldRunner : CommandRunner {
        val waiting = mutableListOf<Pair<Downlink.Command, (Answer) -> Unit>>()

        override fun run(command: Downlink.Command, grant: LeaseGrant, done: (Answer) -> Unit) {
            waiting += command to done
        }
    }

    private lateinit var store: InMemoryJournalStore
    private lateinit var runner: HeldRunner
    private lateinit var dispatcher: BridgeDispatcher
    private val goodbyes = mutableListOf<String>()

    private val leaseJson =
        """{"type":"lease","grants":[{"terminalId":"$T1","leaseId":"$L1","ttlMs":120000,""" +
            """"link":{"connection":"lan","host":"192.168.1.50","port":9000},"framing":"stx_bcdlen_etx_lrc"}],"refused":[]}"""

    private fun commandJson(n: Int, op: String = "sale") =
        """{"type":"command","commandId":"${cmdId(n)}","leaseId":"$L1","terminalId":"$T1","op":"$op",""" +
            """"trace":"000123","frame":"$FRAME_A","timeoutMs":60000}"""

    @Before
    fun setUp() {
        store = InMemoryJournalStore()
        runner = HeldRunner()
        dispatcher = BridgeDispatcher(BridgeCore(store, FakeClock(), "0.1.0") { emptyList() }, runner) { goodbyes += it }
    }

    @Test
    fun `hello first, results resent on every session until acked`() {
        val first = FakeSocket()
        dispatcher.onOpen(first)
        assertEquals(listOf("hello"), first.types())
        dispatcher.onMessage(leaseJson)
        dispatcher.onMessage(commandJson(1))
        runner.waiting.single().second(APPROVED)
        assertEquals(listOf(cmdId(1)), first.resultIds())

        // Socket drops before the ack: the result stays and goes again.
        first.open = false
        dispatcher.onClosed()
        val second = FakeSocket()
        dispatcher.onOpen(second)
        assertTrue(second.sent.single().contains("\"unackedResults\":1"))
        dispatcher.onMessage(leaseJson)
        assertEquals(listOf(cmdId(1)), second.resultIds())
        // A renewal in the same session does not resend.
        dispatcher.onMessage(leaseJson)
        assertEquals(listOf(cmdId(1)), second.resultIds())

        dispatcher.onMessage("""{"type":"ack","commandId":"${cmdId(1)}"}""")
        dispatcher.onClosed()
        val third = FakeSocket()
        dispatcher.onOpen(third)
        dispatcher.onMessage(leaseJson)
        assertEquals(emptyList<String>(), third.resultIds())
    }

    @Test
    fun `a result finished while offline is journaled and sent on the next session`() {
        val first = FakeSocket()
        dispatcher.onOpen(first)
        dispatcher.onMessage(leaseJson)
        dispatcher.onMessage(commandJson(1, "void"))
        first.open = false
        dispatcher.onClosed()
        runner.waiting.single().second(APPROVED)
        assertEquals(1, store.unackedCount())
        val second = FakeSocket()
        dispatcher.onOpen(second)
        dispatcher.onMessage(leaseJson)
        assertEquals(listOf(cmdId(1)), second.resultIds())
    }

    @Test
    fun `a message outside the contract closes the socket and changes nothing`() {
        val socket = FakeSocket()
        dispatcher.onOpen(socket)
        dispatcher.onMessage("""{"type":"ack","commandId":"${cmdId(1)}","extra":1}""")
        assertEquals(1008, socket.closedWith)
        assertEquals(0, store.unackedCount())
    }

    @Test
    fun `goodbye is passed on`() {
        dispatcher.onOpen(FakeSocket())
        dispatcher.onMessage("""{"type":"goodbye","reason":"token_revoked"}""")
        assertEquals(listOf("token_revoked"), goodbyes)
    }
}
