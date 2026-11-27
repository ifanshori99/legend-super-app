package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeResult

/**
 * The bridge's durable journal: the unacked result queue and, separately,
 * the sale dedupe records. Implemented with Room on the tablet
 * (data/RoomJournalStore.kt) and in memory for the JVM tests.
 */
interface JournalStore {
    fun saleRecord(key: String): SaleRecord?

    /** Writes an in-flight sale record before the terminal is touched. */
    fun startSale(record: SaleRecord)

    /** In one transaction: an IN-FLIGHT sale record becomes done with
     * [answer] and [result] joins the unacked queue (replacing any earlier
     * result of that command). Returns false and changes nothing when the
     * record is missing or already done: the first answer is the one kept and
     * replayed (a late completion after a restart is dropped). */
    fun finishSale(key: String, answer: Answer, result: BridgeResult): Boolean

    /** Adds a reply (refusal, replay) to the unacked queue, written before it
     * is sent. A result already queued for that command id is kept. */
    fun enqueue(result: BridgeResult)

    /** Adds the result of a command that ran on the terminal, replacing a
     * queued reply of the same command id. */
    fun enqueueRan(result: BridgeResult)

    /** Unacked results, oldest first. */
    fun unacked(): List<BridgeResult>

    fun unackedCount(): Int

    /** Drops the result from the unacked queue. Sale records stay. */
    fun acknowledge(commandId: String)

    /** Marks the sale records of these traces released. Unknown traces are ignored. */
    fun release(terminalId: String, traces: List<String>)

    fun inFlightSales(): List<SaleRecord>

    /** Sale records whose monotonic reading is at or before [monoCutoffMs]. */
    fun saleRecordsStoredBefore(monoCutoffMs: Long): List<SaleRecord>

    fun deleteSaleRecords(keys: Collection<String>)
}
