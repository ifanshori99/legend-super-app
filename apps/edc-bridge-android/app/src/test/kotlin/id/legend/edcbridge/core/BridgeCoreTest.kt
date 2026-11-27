package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeProtocol
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.Framing
import id.legend.edcbridge.protocol.LeaseGrant
import id.legend.edcbridge.protocol.Link
import id.legend.edcbridge.protocol.Op
import id.legend.edcbridge.protocol.RefusalReason
import id.legend.edcbridge.protocol.TransportErrorKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

const val T1 = "3f0e2a4c-1b2d-4c3e-8f40-5a6b7c8d9e01"
const val L1 = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
const val L2 = "7a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3e"
const val FRAME_A = "eyJvcCI6InNhbGUifQ=="
const val FRAME_B = "eyJvcCI6InZvaWQifQ=="
val APPROVED = Answer.Response("eyJyYyI6IjAwIn0=")

fun cmdId(n: Int) = "0b1c2d3e-4f50-4162-a374-%012d".format(n)

fun command(n: Int, op: Op = Op.SALE, trace: String = "000123", frame: String = FRAME_A, leaseId: String = L1) =
    Downlink.Command(cmdId(n), leaseId, T1, op, trace, frame, 60_000)

fun lease(leaseId: String = L1, ttlMs: Long = 120_000, host: String = "192.168.1.50") = Downlink.Lease(
    listOf(LeaseGrant(T1, leaseId, ttlMs, Link.Lan(host, 9000), Framing.STX_BCDLEN_ETX_LRC)),
    emptyList(),
)

class BridgeCoreTest {
    private lateinit var store: InMemoryJournalStore
    private lateinit var clock: FakeClock
    private var own = listOf<String>()
    private lateinit var core: BridgeCore

    @Before
    fun setUp() {
        store = InMemoryJournalStore()
        clock = FakeClock()
        core = BridgeCore(store, clock, "0.1.0") { own }
        core.onLease(lease())
    }

    private fun run(command: Downlink.Command, answer: Answer = APPROVED) {
        val admission = core.admit(command)
        assertTrue("expected Run, got $admission", admission is Admission.Run)
        core.complete(command, answer)
    }

    private fun reply(command: Downlink.Command) = (core.admit(command) as Admission.Reply).result

    @Test
    fun `a repeated sale replays the first answer and never reaches the terminal`() {
        run(command(1))
        val replay = reply(command(2))
        assertEquals(cmdId(1), replay.replayOf)
        assertEquals(cmdId(2), replay.commandId)
        assertEquals(APPROVED, replay.answer)
        // The replay is journaled too, until its ack.
        assertEquals(listOf(cmdId(1), cmdId(2)), store.unacked().map { it.commandId })
    }

    @Test
    fun `a failed first sale is replayed as is, never rerun`() {
        run(command(1), Answer.TransportError(TransportErrorKind.TIMEOUT))
        val replay = reply(command(2))
        assertEquals(Answer.TransportError(TransportErrorKind.TIMEOUT), replay.answer)
        assertEquals(cmdId(1), replay.replayOf)
    }

    @Test
    fun `same trace with another frame is trace_conflict, even after the first is done`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        assertEquals(Answer.Refused(RefusalReason.TRACE_CONFLICT), reply(command(2, frame = FRAME_B)).answer)
        core.complete(command(1), APPROVED)
        val conflict = reply(command(3, frame = FRAME_B))
        assertEquals(Answer.Refused(RefusalReason.TRACE_CONFLICT), conflict.answer)
        assertNull(conflict.replayOf)
    }

    @Test
    fun `same sale still in flight is duplicate_in_flight`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        assertEquals(Answer.Refused(RefusalReason.DUPLICATE_IN_FLIGHT), reply(command(2)).answer)
    }

    @Test
    fun `void, cancel and inquiry are never deduped`() {
        for ((n, op) in listOf(1 to Op.VOID, 2 to Op.VOID, 3 to Op.CANCEL, 4 to Op.CANCEL, 5 to Op.INQUIRY, 6 to Op.INQUIRY)) {
            run(command(n, op))
        }
        assertTrue(store.records.isEmpty())
    }

    @Test
    fun `another command on a busy terminal is terminal_busy`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        assertEquals(Answer.Refused(RefusalReason.TERMINAL_BUSY), reply(command(2, Op.INQUIRY)).answer)
        core.complete(command(1), APPROVED)
        run(command(3, Op.INQUIRY))
    }

    @Test
    fun `ttlMs counts from receipt on the monotonic clock, the wall clock does not matter`() {
        clock.mono += 119_999
        clock.wall -= 10L * 86_400_000 // wall clock moved back 10 days
        run(command(1, Op.INQUIRY))
        clock.mono += 1
        clock.wall += 365L * 86_400_000
        assertEquals(Answer.Refused(RefusalReason.LEASE_INVALID), reply(command(2, Op.INQUIRY)).answer)
        // A renewal starts the count again.
        core.onLease(lease())
        clock.mono += 119_999
        run(command(3, Op.INQUIRY))
    }

    @Test
    fun `wrong lease id, dropped terminal or own address is lease_invalid`() {
        assertEquals(Answer.Refused(RefusalReason.LEASE_INVALID), reply(command(1, leaseId = L2)).answer)
        core.onLease(Downlink.Lease(emptyList(), emptyList()))
        assertEquals(Answer.Refused(RefusalReason.LEASE_INVALID), reply(command(2)).answer)
        own = listOf("192.168.1.50")
        core.onLease(lease())
        assertEquals(Answer.Refused(RefusalReason.LEASE_INVALID), reply(command(3)).answer)
        // Nothing started, no sale record written.
        assertTrue(store.records.isEmpty())
    }

    @Test
    fun `a lease_invalid sale does not block the same sale later`() {
        core.onLease(Downlink.Lease(emptyList(), emptyList()))
        reply(command(1))
        core.onLease(lease())
        run(command(2))
    }

    @Test
    fun `a running command finishes and is journaled after its lease is gone`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        core.onLease(Downlink.Lease(emptyList(), emptyList()))
        val result = core.complete(command(1), APPROVED)
        assertEquals(listOf(result), store.unacked())
    }

    @Test
    fun `ack drops the queued result but keeps the sale record`() {
        run(command(1))
        core.onAck(Downlink.Ack(cmdId(1)))
        assertEquals(0, store.unackedCount())
        assertEquals(cmdId(1), reply(command(2)).replayOf)
    }

    @Test
    fun `the sale record is written in flight before the terminal is touched`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        val record = store.records.values.single()
        assertEquals(SaleState.IN_FLIGHT, record.state)
        assertNull(record.answer)
        assertEquals(SaleDedupe.frameSha256(FRAME_A), record.frameSha256)
        assertEquals(clock.wall, record.storedAtWallMs)
        assertEquals(clock.mono, record.storedAtMonoMs)
        assertEquals(1, clock.checkpoints)
        assertEquals(0, store.unackedCount())
    }

    @Test
    fun `after a restart an in-flight sale becomes transport_error disconnected and is replayed`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        val restarted = BridgeCore(store, clock, "0.1.0") { own }
        assertEquals(1, restarted.recover())
        val queued = store.unacked().single()
        assertEquals(cmdId(1), queued.commandId)
        assertEquals(Answer.TransportError(TransportErrorKind.DISCONNECTED), queued.answer)
        restarted.onLease(lease())
        val again = (restarted.admit(command(2)) as Admission.Reply).result
        assertEquals(cmdId(1), again.replayOf)
        assertEquals(Answer.TransportError(TransportErrorKind.DISCONNECTED), again.answer)
    }

    @Test
    fun `a late completion after a restart keeps the first answer`() {
        assertTrue(core.admit(command(1)) is Admission.Run)
        val restarted = BridgeCore(store, clock, "0.1.0") { own }
        restarted.recover()
        // The old instance's terminal call returns after the restart: dropped.
        assertNull(core.complete(command(1), APPROVED))
        val disconnected = Answer.TransportError(TransportErrorKind.DISCONNECTED)
        assertEquals(disconnected, store.records.values.single().answer)
        assertEquals(listOf(disconnected), store.unacked().map { it.answer })
    }

    @Test
    fun `a refusal does not replace the queued result of the same command id`() {
        run(command(1, Op.VOID))
        assertTrue(core.admit(command(2, Op.VOID)) is Admission.Run)
        // The cloud resends command 1 while the terminal is busy with 2.
        reply(command(1, Op.VOID))
        assertEquals(APPROVED, store.queue.getValue(cmdId(1)).answer)
    }

    @Test
    fun `release marks only known traces of that terminal`() {
        run(command(1, trace = "A1"))
        run(command(2, trace = "A2"))
        core.onRelease(Downlink.SaleRecordRelease(T1, listOf("A1", "UNKNOWN")))
        core.onRelease(Downlink.SaleRecordRelease("3f0e2a4c-1b2d-4c3e-8f40-000000000000", listOf("A2")))
        assertEquals(mapOf("A1" to true, "A2" to false), store.records.values.associate { it.trace to it.released })
    }

    @Test
    fun `purge keeps records until 48 h and release, or 30 days`() {
        run(command(1, trace = "A1"))
        run(command(2, trace = "A2"))
        core.onRelease(Downlink.SaleRecordRelease(T1, listOf("A1")))
        clock.advance(BridgeProtocol.SALE_RECORD_MIN_RETENTION_MS - 1)
        assertEquals(0, core.purge())
        assertEquals(0, core.hello().heldSaleRecords)
        clock.advance(1)
        assertEquals(1, core.hello().heldSaleRecords)
        assertEquals(1, core.purge())
        assertEquals(listOf("A2"), store.records.values.map { it.trace })
        clock.advance(BridgeProtocol.SALE_RECORD_MAX_RETENTION_MS - BridgeProtocol.SALE_RECORD_MIN_RETENTION_MS - 1)
        assertEquals(0, core.purge())
        clock.advance(1)
        assertEquals(1, core.purge())
        assertTrue(store.records.isEmpty())
    }

    @Test
    fun `moving the wall clock forward does not delete a record early`() {
        run(command(1))
        core.onRelease(Downlink.SaleRecordRelease(T1, listOf("000123")))
        clock.wall += 365L * 86_400_000
        clock.mono += 3_600_000
        assertEquals(0, core.purge())
        core.onLease(lease())
        assertEquals(cmdId(1), reply(command(2)).replayOf)
    }

    @Test
    fun `hello reports unacked results and held records`() {
        run(command(1))
        run(command(2, Op.VOID))
        val hello = core.hello()
        assertEquals(BridgeProtocol.VERSION, hello.protocolVersion)
        assertEquals("0.1.0", hello.appVersion)
        assertEquals(2, hello.unackedResults)
        assertEquals(0, hello.heldSaleRecords)
    }
}
