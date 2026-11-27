package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeResult

/** In-memory [JournalStore] with the same semantics as RoomJournalStore. */
class InMemoryJournalStore : JournalStore {
    val records = LinkedHashMap<String, SaleRecord>()
    val queue = LinkedHashMap<String, BridgeResult>()

    override fun saleRecord(key: String) = records[key]

    override fun startSale(record: SaleRecord) {
        check(record.key !in records) { "sale record exists" }
        records[record.key] = record
    }

    override fun finishSale(key: String, answer: Answer, result: BridgeResult): Boolean {
        val record = records[key] ?: return false
        if (record.state != SaleState.IN_FLIGHT) return false
        records[key] = record.copy(state = SaleState.DONE, answer = answer)
        enqueueRan(result)
        return true
    }

    override fun enqueue(result: BridgeResult) {
        if (result.commandId !in queue) queue[result.commandId] = result
    }

    override fun enqueueRan(result: BridgeResult) {
        queue.remove(result.commandId)
        queue[result.commandId] = result
    }

    override fun unacked() = queue.values.toList()

    override fun unackedCount() = queue.size

    override fun acknowledge(commandId: String) {
        queue.remove(commandId)
    }

    override fun release(terminalId: String, traces: List<String>) {
        for (trace in traces) {
            val key = SaleDedupe.key(terminalId, trace)
            records[key]?.let { records[key] = it.copy(released = true) }
        }
    }

    override fun inFlightSales() = records.values.filter { it.state == SaleState.IN_FLIGHT }

    override fun saleRecordsStoredBefore(monoCutoffMs: Long) = records.values.filter { it.storedAtMonoMs <= monoCutoffMs }

    override fun deleteSaleRecords(keys: Collection<String>) {
        keys.forEach { records.remove(it) }
    }
}

class FakeClock(var wall: Long = 1_764_000_000_000L, var mono: Long = 5_000_000L) : BridgeClock {
    var checkpoints = 0

    override fun wallMs() = wall

    override fun monoMs() = mono

    override fun checkpoint() {
        checkpoints++
    }

    fun advance(ms: Long) {
        wall += ms
        mono += ms
    }
}
