package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.BridgeProtocol
import id.legend.edcbridge.protocol.BridgeResult
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.Hello
import id.legend.edcbridge.protocol.LeaseGrant
import id.legend.edcbridge.protocol.Link
import id.legend.edcbridge.protocol.Op
import id.legend.edcbridge.protocol.RefusalReason
import id.legend.edcbridge.protocol.TransportErrorKind
import java.time.Instant

/** What to do with a command once the bridge looked at it. */
sealed interface Admission {
    /** Run it on the terminal, then call [BridgeCore.complete]. */
    data class Run(val command: Downlink.Command, val grant: LeaseGrant) : Admission

    /** Answered without touching the terminal; already in the unacked queue. */
    data class Reply(val result: BridgeResult) : Admission
}

/**
 * The bridge's rules, without Android or sockets: lease bookkeeping, sale
 * dedupe, journal writes before anything is sent, ack handling and record
 * retention. Not a single money rule: answers go back raw.
 */
class BridgeCore(
    private val store: JournalStore,
    private val clock: BridgeClock,
    private val appVersion: String,
    private val ownAddresses: () -> Collection<String>,
) {
    private data class ActiveLease(val grant: LeaseGrant, val receivedAtMonoMs: Long)

    private val leases = HashMap<String, ActiveLease>()
    private val busy = HashSet<String>()

    /**
     * After a restart: a sale that was in flight may have reached the
     * terminal. Its record becomes done with `transport_error disconnected`
     * and that result is queued, so the cloud records `unknown` and inquires.
     * A repeated sale replays that answer, never runs again.
     */
    @Synchronized
    fun recover(): Int {
        val open = store.inFlightSales()
        for (record in open) {
            val answer = Answer.TransportError(TransportErrorKind.DISCONNECTED)
            store.finishSale(
                record.key,
                answer,
                BridgeResult(record.commandId, record.terminalId, Op.SALE, record.trace, null, completedAt(), answer),
            )
        }
        return open.size
    }

    @Synchronized
    fun hello(): Hello = Hello(
        protocolVersion = BridgeProtocol.VERSION,
        appVersion = appVersion,
        unackedResults = store.unackedCount().coerceAtMost(10_000),
        heldSaleRecords = heldSaleRecords().coerceAtMost(100_000),
    )

    /** Results to resend, oldest first, until the cloud acks them. */
    @Synchronized
    fun pending(): List<BridgeResult> = store.unacked()

    /** `lease` is the full set: a terminal missing from it is no longer ours.
     * `ttlMs` counts from now on the monotonic clock. */
    @Synchronized
    fun onLease(lease: Downlink.Lease) {
        val now = clock.monoMs()
        leases.clear()
        for (grant in lease.grants) leases[grant.terminalId] = ActiveLease(grant, now)
    }

    @Synchronized
    fun grant(terminalId: String): LeaseGrant? = leases[terminalId]?.grant

    @Synchronized
    fun admit(command: Downlink.Command): Admission {
        if (!leaseValid(command)) return reply(command, Answer.Refused(RefusalReason.LEASE_INVALID))
        val key = SaleDedupe.key(command)
        val hash = SaleDedupe.frameSha256(command.frame)
        if (key != null) {
            when (val decision = SaleDedupe.decide(command, store.saleRecord(key), hash)) {
                is DedupeDecision.Refuse -> return reply(command, Answer.Refused(decision.reason))
                is DedupeDecision.Replay -> return reply(command, decision.answer, decision.replayOf)
                DedupeDecision.Run -> Unit
            }
        }
        if (command.terminalId in busy) return reply(command, Answer.Refused(RefusalReason.TERMINAL_BUSY))
        if (key != null) {
            val now = clock.now()
            store.startSale(
                SaleRecord(
                    key = key,
                    commandId = command.commandId,
                    terminalId = command.terminalId,
                    trace = command.trace,
                    frameSha256 = hash,
                    state = SaleState.IN_FLIGHT,
                    answer = null,
                    storedAtWallMs = now.wallMs,
                    storedAtMonoMs = now.monoMs,
                    released = false,
                ),
            )
            clock.checkpoint()
        }
        busy.add(command.terminalId)
        return Admission.Run(command, leases.getValue(command.terminalId).grant)
    }

    /** The terminal (or the link) answered a command from [Admission.Run].
     * The result is journaled before the caller sends it. */
    @Synchronized
    fun complete(command: Downlink.Command, answer: Answer): BridgeResult {
        busy.remove(command.terminalId)
        val result = resultOf(command, answer, null)
        val key = SaleDedupe.key(command)
        if (key != null) store.finishSale(key, answer, result) else store.enqueue(result)
        return result
    }

    @Synchronized
    fun onAck(ack: Downlink.Ack) = store.acknowledge(ack.commandId)

    @Synchronized
    fun onRelease(release: Downlink.SaleRecordRelease) = store.release(release.terminalId, release.traces)

    /** Deletes sale records per [SaleRecordRetention]. Returns how many. */
    @Synchronized
    fun purge(): Int {
        val now = clock.now()
        val gone = candidates(now).filter { SaleRecordRetention.deletable(it, now) }.map { it.key }
        if (gone.isNotEmpty()) store.deleteSaleRecords(gone)
        return gone.size
    }

    @Synchronized
    fun heldSaleRecords(): Int {
        val now = clock.now()
        return candidates(now).count { SaleRecordRetention.held(it, now) }
    }

    private fun candidates(now: Instants): List<SaleRecord> =
        store.saleRecordsStoredBefore(now.monoMs - BridgeProtocol.SALE_RECORD_MIN_RETENTION_MS)

    private fun leaseValid(command: Downlink.Command): Boolean {
        val lease = leases[command.terminalId] ?: return false
        if (lease.grant.leaseId != command.leaseId) return false
        if (clock.monoMs() - lease.receivedAtMonoMs >= lease.grant.ttlMs) return false
        val link = lease.grant.link
        return !(link is Link.Lan && link.host in ownAddresses())
    }

    private fun reply(command: Downlink.Command, answer: Answer, replayOf: String? = null): Admission.Reply {
        val result = resultOf(command, answer, replayOf)
        store.enqueue(result)
        return Admission.Reply(result)
    }

    private fun resultOf(command: Downlink.Command, answer: Answer, replayOf: String?) = BridgeResult(
        commandId = command.commandId,
        terminalId = command.terminalId,
        op = command.op,
        trace = command.trace,
        replayOf = replayOf,
        completedAt = completedAt(),
        answer = answer,
    )

    private fun completedAt(): String = Instant.ofEpochMilli(clock.wallMs()).toString()
}
