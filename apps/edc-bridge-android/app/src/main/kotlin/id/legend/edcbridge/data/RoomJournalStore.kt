package id.legend.edcbridge.data

import id.legend.edcbridge.core.JournalStore
import id.legend.edcbridge.core.SaleDedupe
import id.legend.edcbridge.core.SaleRecord
import id.legend.edcbridge.core.SaleState
import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeJson
import id.legend.edcbridge.protocol.BridgeResult

/** [JournalStore] on Room. Callers run it off the main thread. */
class RoomJournalStore(private val dao: JournalDao) : JournalStore {
    override fun saleRecord(key: String): SaleRecord? = dao.saleRecord(key)?.toRecord()

    override fun startSale(record: SaleRecord) = dao.insertSaleRecord(record.toEntity())

    /** Queued rows that no longer decode (skipped on resend, still counted
     * in `hello.unackedResults`). One bad row must not stop every resend. */
    @Volatile
    var undecodableResults = 0
        private set

    override fun finishSale(key: String, answer: Answer, result: BridgeResult): Boolean =
        dao.finishSale(key, BridgeJson.encodeAnswer(answer), result.toEntity())

    override fun enqueue(result: BridgeResult) = dao.insertUnackedIfAbsent(result.toEntity())

    override fun enqueueRan(result: BridgeResult) = dao.replaceUnacked(result.toEntity())

    override fun unacked(): List<BridgeResult> {
        var bad = 0
        val results = dao.unacked().mapNotNull {
            try {
                BridgeJson.decodeResult(it.resultJson)
            } catch (e: Exception) {
                bad++
                null
            }
        }
        undecodableResults = bad
        return results
    }

    override fun unackedCount(): Int = dao.unackedCount()

    override fun acknowledge(commandId: String) = dao.deleteUnacked(commandId)

    override fun release(terminalId: String, traces: List<String>) =
        dao.release(traces.map { SaleDedupe.key(terminalId, it) })

    override fun inFlightSales(): List<SaleRecord> = dao.inFlight().map { it.toRecord() }

    override fun saleRecordsStoredBefore(monoCutoffMs: Long): List<SaleRecord> =
        dao.storedBefore(monoCutoffMs).map { it.toRecord() }

    override fun deleteSaleRecords(keys: Collection<String>) {
        keys.chunked(500).forEach { dao.delete(it) }
    }

    private fun SaleRecordEntity.toRecord() = SaleRecord(
        key = key,
        commandId = commandId,
        terminalId = terminalId,
        trace = trace,
        frameSha256 = frameSha256,
        state = if (state == "done") SaleState.DONE else SaleState.IN_FLIGHT,
        answer = answerJson?.let { BridgeJson.decodeAnswer(it) },
        storedAtWallMs = storedAtWallMs,
        storedAtMonoMs = storedAtMonoMs,
        released = released,
    )

    private fun SaleRecord.toEntity() = SaleRecordEntity(
        key = key,
        commandId = commandId,
        terminalId = terminalId,
        trace = trace,
        frameSha256 = frameSha256,
        state = if (state == SaleState.DONE) "done" else "in_flight",
        answerJson = answer?.let { BridgeJson.encodeAnswer(it) },
        storedAtWallMs = storedAtWallMs,
        storedAtMonoMs = storedAtMonoMs,
        released = released,
    )

    private fun BridgeResult.toEntity() = UnackedResultEntity(commandId = commandId, resultJson = BridgeJson.encodeResult(this))
}
