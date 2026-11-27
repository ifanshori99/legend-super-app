package id.legend.edcbridge.protocol

// Kotlin mirror of the wire contract in packages/shared/src/edc/bridge.ts
// (bead legend-wasr7.20). The TypeScript file is the source of truth; the
// JVM test ContractFixturesTest checks this parser against fixtures produced
// by the zod schemas (apps/api/src/test/helpers/edc-bridge-fixtures.ts).
//
// The bridge is a pipe: a command carries opaque base64 bytes the cloud bank
// adapter built, a result carries the terminal's raw answer. Nothing here
// knows an amount or decides "approved".

object BridgeProtocol {
    const val VERSION = 1
    const val MAX_MESSAGE_BYTES = 16_384
    const val SALE_RECORD_MIN_RETENTION_MS = 48L * 3_600_000L
    const val SALE_RECORD_MAX_RETENTION_MS = 30L * 86_400_000L
    const val MAX_COMMAND_TIMEOUT_MS = 300_000L
}

enum class Op(val wire: String) {
    SALE("sale"),
    CANCEL("cancel"),
    INQUIRY("inquiry"),
    VOID("void");

    /** Only `sale` is deduped per terminal + trace (EDC_BRIDGE_DEDUPED_OPS). */
    val deduped: Boolean get() = this == SALE

    companion object {
        fun of(wire: String): Op? = entries.firstOrNull { it.wire == wire }
    }
}

enum class Framing(val wire: String) {
    STX_BCDLEN_ETX_LRC("stx_bcdlen_etx_lrc");

    companion object {
        fun of(wire: String): Framing? = entries.firstOrNull { it.wire == wire }
    }
}

sealed interface Link {
    data class Lan(val host: String, val port: Int) : Link
    data class Usb(val baudRate: Int) : Link
}

data class LeaseGrant(
    val terminalId: String,
    val leaseId: String,
    val ttlMs: Long,
    val link: Link,
    val framing: Framing,
)

data class LeaseRefusal(val terminalId: String, val reason: String)

sealed interface Downlink {
    data class Lease(val grants: List<LeaseGrant>, val refused: List<LeaseRefusal>) : Downlink

    data class Command(
        val commandId: String,
        val leaseId: String,
        val terminalId: String,
        val op: Op,
        val trace: String,
        val frame: String,
        val timeoutMs: Long,
    ) : Downlink

    data class Ack(val commandId: String) : Downlink

    data class SaleRecordRelease(val terminalId: String, val traces: List<String>) : Downlink

    data class Goodbye(val reason: String) : Downlink
}

enum class TransportErrorKind(val wire: String) {
    TIMEOUT("timeout"),
    DISCONNECTED("disconnected"),
    PROTOCOL("protocol");

    companion object {
        fun of(wire: String): TransportErrorKind? = entries.firstOrNull { it.wire == wire }
    }
}

enum class RefusalReason(val wire: String) {
    LEASE_INVALID("lease_invalid"),
    TERMINAL_BUSY("terminal_busy"),
    LINK_DOWN("link_down"),
    DUPLICATE_IN_FLIGHT("duplicate_in_flight"),
    TRACE_CONFLICT("trace_conflict");

    companion object {
        fun of(wire: String): RefusalReason? = entries.firstOrNull { it.wire == wire }
    }
}

sealed interface Answer {
    /** The terminal answered; `frame` is its message body (base64), unframed. */
    data class Response(val frame: String) : Answer

    /** The bridge could not learn the terminal's answer. */
    data class TransportError(val kind: TransportErrorKind) : Answer

    /** The bridge did not run the command. */
    data class Refused(val reason: RefusalReason) : Answer
}

data class Hello(
    val protocolVersion: Int,
    val appVersion: String,
    val unackedResults: Int,
    val heldSaleRecords: Int,
)

data class BridgeResult(
    val commandId: String,
    val terminalId: String,
    val op: Op,
    val trace: String,
    val replayOf: String?,
    val completedAt: String,
    val answer: Answer,
)

/** A message outside the contract: the caller closes the socket. */
class ContractViolation(message: String) : Exception(message)
