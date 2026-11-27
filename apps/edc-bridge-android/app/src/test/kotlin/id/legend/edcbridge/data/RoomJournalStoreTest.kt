package id.legend.edcbridge.data

import id.legend.edcbridge.core.SaleRecord
import id.legend.edcbridge.core.SaleState
import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeResult
import id.legend.edcbridge.protocol.Op
import id.legend.edcbridge.protocol.RefusalReason
import id.legend.edcbridge.protocol.TransportErrorKind
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * RoomJournalStore and the DAO's transaction body over a storage-only fake
 * DAO (no SQLite on the JVM). The fake does what each query's SQL does; the
 * rules under test live in Kotlin (JournalDao.finishSale, RoomJournalStore).
 */
class RoomJournalStoreTest {
    private class FakeDao : JournalDao {
        val sales = LinkedHashMap<String, SaleRecordEntity>()
        val unackedRows = ArrayList<UnackedResultEntity>()
        private var seq = 0L

        override fun saleRecord(key: String) = sales[key]

        override fun insertSaleRecord(record: SaleRecordEntity) {
            check(record.key !in sales)
            sales[record.key] = record
        }

        // UPDATE ... SET state = 'done', answer_json = :answerJson WHERE key = :key AND state = 'in_flight'
        override fun markSaleDone(key: String, answerJson: String): Int {
            val row = sales[key]?.takeIf { it.state == "in_flight" } ?: return 0
            sales[key] = row.copy(state = "done", answerJson = answerJson)
            return 1
        }

        // INSERT OR REPLACE on the unique command_id
        override fun replaceUnacked(result: UnackedResultEntity) {
            unackedRows.removeAll { it.commandId == result.commandId }
            unackedRows += result.copy(seq = ++seq)
        }

        // INSERT OR IGNORE on the unique command_id
        override fun insertUnackedIfAbsent(result: UnackedResultEntity) {
            if (unackedRows.none { it.commandId == result.commandId }) unackedRows += result.copy(seq = ++seq)
        }

        override fun unacked() = unackedRows.sortedBy { it.seq }

        override fun unackedCount() = unackedRows.size

        override fun deleteUnacked(commandId: String) {
            unackedRows.removeAll { it.commandId == commandId }
        }

        override fun release(keys: List<String>) {
            keys.forEach { k -> sales[k]?.let { sales[k] = it.copy(released = true) } }
        }

        override fun inFlight() = sales.values.filter { it.state == "in_flight" }

        override fun storedBefore(monoCutoffMs: Long) = sales.values.filter { it.storedAtMonoMs <= monoCutoffMs }

        override fun delete(keys: List<String>) {
            keys.forEach { sales.remove(it) }
        }
    }

    private val T = "3f0e2a4c-1b2d-4c3e-8f40-5a6b7c8d9e01"
    private val C1 = "0b1c2d3e-4f50-4162-a374-000000000001"
    private val key = "$T:sale:000123"
    private val first = Answer.TransportError(TransportErrorKind.DISCONNECTED)
    private val late = Answer.Response("eyJyYyI6IjAwIn0=")

    private fun result(answer: Answer) = BridgeResult(C1, T, Op.SALE, "000123", null, "2026-11-27T07:00:00Z", answer)

    private fun startedStore(dao: FakeDao) = RoomJournalStore(dao).also {
        it.startSale(SaleRecord(key, C1, T, "000123", "h", SaleState.IN_FLIGHT, null, 0, 0, false))
    }

    @Test
    fun `a second finishSale for a done record changes nothing (first answer kept)`() {
        val dao = FakeDao()
        val store = startedStore(dao)
        store.finishSale(key, first, result(first))
        store.finishSale(key, late, result(late))
        assertEquals(first, store.saleRecord(key)!!.answer)
        assertEquals(listOf(first), store.unacked().map { it.answer })
    }

    @Test
    fun `a refusal never replaces a queued result of the same command`() {
        val dao = FakeDao()
        val store = startedStore(dao)
        store.finishSale(key, late, result(late))
        store.enqueue(result(Answer.Refused(RefusalReason.TERMINAL_BUSY)))
        assertEquals(listOf(late), store.unacked().map { it.answer })
    }

    @Test
    fun `an unreadable journal row is skipped and counted, the rest is resent`() {
        val dao = FakeDao()
        val store = startedStore(dao)
        dao.replaceUnacked(UnackedResultEntity(commandId = "broken", resultJson = "{not json"))
        store.finishSale(key, late, result(late))
        assertEquals(listOf(C1), store.unacked().map { it.commandId })
        assertEquals(1, store.undecodableResults)
    }
}
