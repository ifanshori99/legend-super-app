package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.BridgeProtocol

/**
 * `edcBridgeSaleRecordDeletable` on the tablet: a sale record goes once it is
 * 48 h old AND released, or 30 days old whatever happened.
 *
 * Age (review B1 P3): the wall clock alone can be moved forward, which would
 * drop a dedupe record early and let a repeated sale reach the terminal
 * again. The record keeps both the wall reading and the reboot-safe
 * monotonic reading ([PersistentMonotonicClock]); the age used is the
 * SHORTER of the two, so a record is deleted only when both clocks agree the
 * time has passed. This keeps the record longer, never shorter (founder rule
 * "jangan sampai rugi"); see the open question in docs/briefs/1272-b3-progress.md.
 */
object SaleRecordRetention {
    fun ageMs(storedAtWallMs: Long, storedAtMonoMs: Long, now: Instants): Long =
        minOf(now.wallMs - storedAtWallMs, now.monoMs - storedAtMonoMs)

    fun ageMs(record: SaleRecord, now: Instants): Long = ageMs(record.storedAtWallMs, record.storedAtMonoMs, now)

    fun deletable(record: SaleRecord, now: Instants): Boolean {
        val age = ageMs(record, now)
        if (age >= BridgeProtocol.SALE_RECORD_MAX_RETENTION_MS) return true
        return record.released && age >= BridgeProtocol.SALE_RECORD_MIN_RETENTION_MS
    }

    /** Counted in `hello.heldSaleRecords`: past 48 h, still waiting for a release. */
    fun held(record: SaleRecord, now: Instants): Boolean =
        !record.released && ageMs(record, now) >= BridgeProtocol.SALE_RECORD_MIN_RETENTION_MS
}
