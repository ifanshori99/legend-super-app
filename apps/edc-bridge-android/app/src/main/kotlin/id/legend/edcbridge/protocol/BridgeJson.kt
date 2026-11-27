package id.legend.edcbridge.protocol

import java.math.BigDecimal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Strict JSON codec for the bridge contract. Every object is checked like a
 * zod `strictObject`: missing or extra keys, wrong types and out-of-range
 * values throw [ContractViolation].
 */
object BridgeJson {
    private val json = Json

    private val UUID = Regex(
        "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}" +
            "|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    )
    private val TRACE = Regex("^[A-Za-z0-9]+$")
    private val BASE64 = Regex("^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$")
    private const val OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])"
    private val IPV4 = Regex("^(?:$OCTET\\.){3}$OCTET$")
    private val BAUD_RATES = setOf(9_600, 19_200, 38_400, 57_600, 115_200)
    private val LEASE_REFUSALS = setOf("held_by_other_device", "terminal_inactive", "connection_unsupported")
    private val GOODBYES = setOf("protocol_unsupported", "token_revoked", "replaced_by_newer_session", "server_shutdown")

    /** RFC 1918 only (zod `z.ipv4()` + `isPrivateIpv4`). */
    fun isPrivateIpv4(host: String): Boolean {
        if (!IPV4.matches(host)) return false
        val parts = host.split('.').map { it.toInt() }
        val a = parts[0]
        val b = parts[1]
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
    }

    /** One WebSocket text frame from the cloud. */
    fun parseDownlink(raw: String): Downlink {
        if (raw.toByteArray(Charsets.UTF_8).size > BridgeProtocol.MAX_MESSAGE_BYTES) {
            throw ContractViolation("message too large")
        }
        val element = try {
            json.parseToJsonElement(raw)
        } catch (e: Exception) {
            throw ContractViolation("bad JSON")
        }
        val obj = element as? JsonObject ?: throw ContractViolation("not an object")
        return when (val type = obj.string("type")) {
            "lease" -> {
                obj.exactKeys("type", "grants", "refused")
                Downlink.Lease(
                    grants = obj.array("grants", max = 8).map { leaseGrant(it.asObject()) },
                    refused = obj.array("refused", max = 8).map { refusal(it.asObject()) },
                )
            }
            "command" -> {
                obj.exactKeys("type", "commandId", "leaseId", "terminalId", "op", "trace", "frame", "timeoutMs")
                Downlink.Command(
                    commandId = obj.uuid("commandId"),
                    leaseId = obj.uuid("leaseId"),
                    terminalId = obj.uuid("terminalId"),
                    op = Op.of(obj.string("op")) ?: throw ContractViolation("op"),
                    trace = obj.trace("trace"),
                    frame = obj.frame("frame"),
                    timeoutMs = obj.int("timeoutMs", 1_000, BridgeProtocol.MAX_COMMAND_TIMEOUT_MS),
                )
            }
            "ack" -> {
                obj.exactKeys("type", "commandId")
                Downlink.Ack(obj.uuid("commandId"))
            }
            "sale_record_release" -> {
                obj.exactKeys("type", "terminalId", "traces")
                Downlink.SaleRecordRelease(
                    terminalId = obj.uuid("terminalId"),
                    traces = obj.array("traces", min = 1, max = 500).map { traceOf(it) },
                )
            }
            "goodbye" -> {
                obj.exactKeys("type", "reason")
                val reason = obj.string("reason")
                if (reason !in GOODBYES) throw ContractViolation("goodbye reason")
                Downlink.Goodbye(reason)
            }
            else -> throw ContractViolation("unknown type $type")
        }
    }

    fun encodeHello(hello: Hello): String = buildJsonObject {
        put("type", "hello")
        put("protocolVersion", hello.protocolVersion)
        put("appVersion", hello.appVersion)
        put("unackedResults", hello.unackedResults)
        put("heldSaleRecords", hello.heldSaleRecords)
    }.toString()

    fun resultElement(result: BridgeResult): JsonObject = buildJsonObject {
        put("type", "result")
        put("commandId", result.commandId)
        put("terminalId", result.terminalId)
        put("op", result.op.wire)
        put("trace", result.trace)
        put("replayOf", result.replayOf?.let { JsonPrimitive(it) } ?: JsonNull)
        put("completedAt", result.completedAt)
        put("answer", answerElement(result.answer))
    }

    fun encodeResult(result: BridgeResult): String = resultElement(result).toString()

    /** Journal storage of a result written by [encodeResult]. */
    fun decodeResult(raw: String): BridgeResult {
        val obj = json.parseToJsonElement(raw).asObject()
        obj.exactKeys("type", "commandId", "terminalId", "op", "trace", "replayOf", "completedAt", "answer")
        val replayOf = obj["replayOf"]
        return BridgeResult(
            commandId = obj.uuid("commandId"),
            terminalId = obj.uuid("terminalId"),
            op = Op.of(obj.string("op")) ?: throw ContractViolation("op"),
            trace = obj.trace("trace"),
            replayOf = if (replayOf is JsonNull) null else obj.uuid("replayOf"),
            completedAt = obj.string("completedAt"),
            answer = answerOf(obj.getValue("answer").asObject()),
        )
    }

    fun answerElement(answer: Answer): JsonObject = when (answer) {
        is Answer.Response -> buildJsonObject {
            put("outcome", "response")
            put("frame", answer.frame)
        }
        is Answer.TransportError -> buildJsonObject {
            put("outcome", "transport_error")
            put("kind", answer.kind.wire)
        }
        is Answer.Refused -> buildJsonObject {
            put("outcome", "refused")
            put("reason", answer.reason.wire)
        }
    }

    fun encodeAnswer(answer: Answer): String = answerElement(answer).toString()

    fun decodeAnswer(raw: String): Answer = answerOf(json.parseToJsonElement(raw).asObject())

    private fun answerOf(obj: JsonObject): Answer = when (obj.string("outcome")) {
        "response" -> {
            obj.exactKeys("outcome", "frame")
            Answer.Response(obj.frame("frame"))
        }
        "transport_error" -> {
            obj.exactKeys("outcome", "kind")
            Answer.TransportError(TransportErrorKind.of(obj.string("kind")) ?: throw ContractViolation("kind"))
        }
        "refused" -> {
            obj.exactKeys("outcome", "reason")
            Answer.Refused(RefusalReason.of(obj.string("reason")) ?: throw ContractViolation("reason"))
        }
        else -> throw ContractViolation("outcome")
    }

    private fun leaseGrant(obj: JsonObject): LeaseGrant {
        obj.exactKeys("terminalId", "leaseId", "ttlMs", "link", "framing")
        return LeaseGrant(
            terminalId = obj.uuid("terminalId"),
            leaseId = obj.uuid("leaseId"),
            ttlMs = obj.int("ttlMs", 10_000, 600_000),
            link = link(obj.getValue("link").asObject()),
            framing = Framing.of(obj.string("framing")) ?: throw ContractViolation("framing"),
        )
    }

    private fun link(obj: JsonObject): Link = when (obj.string("connection")) {
        "lan" -> {
            obj.exactKeys("connection", "host", "port")
            val host = obj.string("host")
            if (!isPrivateIpv4(host)) throw ContractViolation("host")
            Link.Lan(host, obj.int("port", 1, 65_535).toInt())
        }
        "usb" -> {
            obj.exactKeys("connection", "baudRate")
            val baud = obj.int("baudRate", 1, 115_200).toInt()
            if (baud !in BAUD_RATES) throw ContractViolation("baudRate")
            Link.Usb(baud)
        }
        else -> throw ContractViolation("connection")
    }

    private fun refusal(obj: JsonObject): LeaseRefusal {
        obj.exactKeys("terminalId", "reason")
        val reason = obj.string("reason")
        if (reason !in LEASE_REFUSALS) throw ContractViolation("refusal reason")
        return LeaseRefusal(obj.uuid("terminalId"), reason)
    }

    private fun JsonElement.asObject(): JsonObject = this as? JsonObject ?: throw ContractViolation("not an object")

    private fun JsonObject.exactKeys(vararg keys: String) {
        val expected = keys.toSet()
        if (this.keys != expected) throw ContractViolation("keys ${this.keys} != $expected")
    }

    private fun stringOf(element: JsonElement?): String {
        val primitive = element as? JsonPrimitive ?: throw ContractViolation("not a string")
        if (primitive is JsonNull || !primitive.isString) throw ContractViolation("not a string")
        return primitive.content
    }

    private fun JsonObject.string(key: String): String = stringOf(this[key])

    private fun uuidOf(value: String): String {
        if (!UUID.matches(value)) throw ContractViolation("uuid")
        return value.lowercase()
    }

    private fun JsonObject.uuid(key: String): String = uuidOf(string(key))

    private fun traceOf(element: JsonElement): String {
        val value = stringOf(element)
        if (value.length !in 1..32 || !TRACE.matches(value)) throw ContractViolation("trace")
        return value
    }

    private fun JsonObject.trace(key: String): String = traceOf(this[key] ?: throw ContractViolation(key))

    private fun JsonObject.frame(key: String): String {
        val value = string(key)
        if (value.length !in 4..8_192 || !BASE64.matches(value)) throw ContractViolation("frame")
        return value
    }

    /** zod `z.number().int().min().max()`: a JSON number with an integer value. */
    private fun JsonObject.int(key: String, min: Long, max: Long): Long {
        val primitive = this[key] as? JsonPrimitive ?: throw ContractViolation(key)
        if (primitive is JsonNull || primitive.isString) throw ContractViolation(key)
        val number = primitive.content.toBigDecimalOrNull() ?: throw ContractViolation(key)
        val integral = try {
            number.toBigIntegerExact()
        } catch (e: ArithmeticException) {
            throw ContractViolation(key)
        }
        if (BigDecimal(integral) < BigDecimal.valueOf(min) || BigDecimal(integral) > BigDecimal.valueOf(max)) {
            throw ContractViolation(key)
        }
        return integral.toLong()
    }

    private fun JsonObject.array(key: String, min: Int = 0, max: Int): JsonArray {
        val array = this[key] as? JsonArray ?: throw ContractViolation(key)
        if (array.size < min || array.size > max) throw ContractViolation(key)
        return array
    }
}
