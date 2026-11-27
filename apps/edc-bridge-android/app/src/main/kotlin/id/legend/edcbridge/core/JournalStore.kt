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

    /** In one transaction: the sale record becomes done with [answer] and
     * [result] joins the unacked queue. */
    fun finishSale(key: String, answer: Answer, result: BridgeResult)

    /** Adds a result to the unacked queue (written before it is sent). */
    fun enqueue(result: BridgeResult)

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
