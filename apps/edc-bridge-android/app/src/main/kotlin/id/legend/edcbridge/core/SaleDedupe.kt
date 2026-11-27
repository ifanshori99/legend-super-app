package id.legend.edcbridge.core

import id.legend.edcbridge.protocol.Answer
import id.legend.edcbridge.protocol.Downlink
import id.legend.edcbridge.protocol.RefusalReason
import java.security.MessageDigest

enum class SaleState { IN_FLIGHT, DONE }

/**
 * The dedupe record of one sale (terminal + trace). Kept apart from the
 * unacked result queue: an `ack` never deletes it, only [SaleRecordRetention].
 * Both clocks are stored so the age cannot be shortened by moving the wall
 * clock forward.
 */
data class SaleRecord(
    val key: String,
    val commandId: String,
    val terminalId: String,
    val trace: String,
    val frameSha256: String,
    val state: SaleState,
    /** The first answer, replayed as is; null while in flight. */
    val answer: Answer?,
    val storedAtWallMs: Long,
    val storedAtMonoMs: Long,
    val released: Boolean,
)

sealed interface DedupeDecision {
    data object Run : DedupeDecision
    data class Replay(val replayOf: String, val answer: Answer) : DedupeDecision
    data class Refuse(val reason: RefusalReason) : DedupeDecision
}

object SaleDedupe {
    /** `edcBridgeDedupeKey`: null for ops that pass through to the terminal. */
    fun key(command: Downlink.Command): String? =
        if (command.op.deduped) "${command.terminalId}:${command.op.wire}:${command.trace}" else null

    fun key(terminalId: String, trace: String): String = "$terminalId:sale:$trace"

    /** `edcBridgeFrameSha256`: lowercase hex SHA-256 of the base64 text as received. */
    fun frameSha256(frame: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(frame.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }

    /**
     * `edcBridgeDedupeDecision`. Same frame and done: replay the first answer.
     * Same frame and still running (or done without an answer): refuse
     * `duplicate_in_flight`. Another frame for a known sale trace: refuse
     * `trace_conflict`, so an old approval never answers a new sale.
     */
    fun decide(command: Downlink.Command, record: SaleRecord?, frameSha256: String): DedupeDecision {
        if (!command.op.deduped || record == null) return DedupeDecision.Run
        if (record.frameSha256 != frameSha256) return DedupeDecision.Refuse(RefusalReason.TRACE_CONFLICT)
        val answer = record.answer
        if (record.state == SaleState.IN_FLIGHT || answer == null) {
            return DedupeDecision.Refuse(RefusalReason.DUPLICATE_IN_FLIGHT)
        }
        return DedupeDecision.Replay(record.commandId, answer)
    }
}
