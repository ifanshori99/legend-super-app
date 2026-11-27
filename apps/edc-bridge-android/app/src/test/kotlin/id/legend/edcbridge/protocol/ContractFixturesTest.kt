package id.legend.edcbridge.protocol

import id.legend.edcbridge.core.DedupeDecision
import id.legend.edcbridge.core.Instants
import id.legend.edcbridge.core.SaleDedupe
import id.legend.edcbridge.core.SaleRecord
import id.legend.edcbridge.core.SaleRecordRetention
import id.legend.edcbridge.core.SaleState
import id.legend.edcbridge.link.EcrFraming
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Same answers as the zod contract: the fixtures are generated from
 * @starter/shared/edc/bridge by apps/api/src/test/edc-bridge-tablet.test.ts.
 */
class ContractFixturesTest {
    private val fixtures: JsonObject = Json.parseToJsonElement(
        javaClass.getResource("/edc-bridge-contract-fixtures.json")!!.readText(),
    ).jsonObject

    private fun section(name: String) = fixtures.getValue(name).jsonArray.map { it.jsonObject }

    @Test
    fun `downlink parse matches zod for every case`() {
        val cases = section("downlink")
        assertTrue(cases.size > 60)
        val mismatches = mutableListOf<String>()
        for (case in cases) {
            val name = case.getValue("name").jsonPrimitive.content
            val raw = case.getValue("raw").jsonPrimitive.content
            val valid = case.getValue("valid").jsonPrimitive.boolean
            val parsed = try {
                BridgeJson.parseDownlink(raw)
            } catch (e: ContractViolation) {
                null
            }
            when {
                valid && parsed == null -> mismatches += "$name: zod accepts, Kotlin rejects"
                !valid && parsed != null -> mismatches += "$name: zod rejects, Kotlin accepts"
                valid && downlinkElement(parsed!!) != case.getValue("parsed") ->
                    mismatches += "$name: ${downlinkElement(parsed)} != ${case.getValue("parsed")}"
            }
        }
        if (mismatches.isNotEmpty()) fail(mismatches.joinToString("\n"))
    }

    @Test
    fun `uplink encoding matches zod output`() {
        for (message in section("uplink")) {
            val encoded = when (message.getValue("type").jsonPrimitive.content) {
                "hello" -> BridgeJson.encodeHello(
                    Hello(
                        message.getValue("protocolVersion").jsonPrimitive.int,
                        message.getValue("appVersion").jsonPrimitive.content,
                        message.getValue("unackedResults").jsonPrimitive.int,
                        message.getValue("heldSaleRecords").jsonPrimitive.int,
                    ),
                )
                else -> BridgeJson.encodeResult(BridgeJson.decodeResult(message.toString()))
            }
            assertEquals(message, Json.parseToJsonElement(encoded))
        }
    }

    @Test
    fun `frame SHA-256 matches edcBridgeFrameSha256`() {
        for (case in section("frameSha256")) {
            assertEquals(
                case.getValue("sha256").jsonPrimitive.content,
                SaleDedupe.frameSha256(case.getValue("frame").jsonPrimitive.content),
            )
        }
    }

    @Test
    fun `dedupe decision matches edcBridgeDedupeDecision`() {
        for (case in section("dedupe")) {
            val op = Op.of(case.getValue("op").jsonPrimitive.content)!!
            val record = (case.getValue("record") as? JsonObject)?.let {
                SaleRecord(
                    key = "k",
                    commandId = it.getValue("commandId").jsonPrimitive.content,
                    terminalId = "t",
                    trace = "000123",
                    frameSha256 = it.getValue("frameSha256").jsonPrimitive.content,
                    state = if (it.getValue("state").jsonPrimitive.content == "done") SaleState.DONE else SaleState.IN_FLIGHT,
                    answer = (it.getValue("answer") as? JsonObject)?.let { a -> BridgeJson.decodeAnswer(a.toString()) },
                    storedAtWallMs = 0,
                    storedAtMonoMs = 0,
                    released = false,
                )
            }
            val command = Downlink.Command("c", "l", "t", op, "000123", "AAAA", 1_000)
            val decision = SaleDedupe.decide(command, record, case.getValue("frameSha256").jsonPrimitive.content)
            val actual = when (decision) {
                DedupeDecision.Run -> buildJsonObject { put("action", "run") }
                is DedupeDecision.Replay -> buildJsonObject {
                    put("action", "replay")
                    put("replayOf", decision.replayOf)
                }
                is DedupeDecision.Refuse -> buildJsonObject {
                    put("action", "refuse")
                    put("reason", decision.reason.wire)
                }
            }
            assertEquals(case.toString(), case.getValue("decision"), actual)
        }
    }

    @Test
    fun `retention matches edcBridgeSaleRecordDeletable when both clocks agree`() {
        for (case in section("deletable")) {
            val age = case.getValue("ageMs").jsonPrimitive.long
            val record = SaleRecord("k", "c", "t", "1", "h", SaleState.DONE, null, 0, 0, case.getValue("released").jsonPrimitive.boolean)
            assertEquals(
                case.toString(),
                case.getValue("deletable").jsonPrimitive.boolean,
                SaleRecordRetention.deletable(record, Instants(age, age)),
            )
        }
    }

    @Test
    fun `framing matches the Node emulator`() {
        for (case in section("framing")) {
            val body = hex(case.getValue("bodyHex").jsonPrimitive.content)
            assertEquals(case.getValue("framedHex").jsonPrimitive.content, EcrFraming.frame(body).joinToString("") { "%02x".format(it) })
        }
    }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    /** The parsed message back as JSON, to compare with zod's output. */
    private fun downlinkElement(message: Downlink): JsonElement = when (message) {
        is Downlink.Lease -> buildJsonObject {
            put("type", "lease")
            put(
                "grants",
                buildJsonArray {
                    for (g in message.grants) {
                        add(
                            buildJsonObject {
                                put("terminalId", g.terminalId)
                                put("leaseId", g.leaseId)
                                put("ttlMs", g.ttlMs)
                                put(
                                    "link",
                                    when (val link = g.link) {
                                        is Link.Lan -> buildJsonObject {
                                            put("connection", "lan")
                                            put("host", link.host)
                                            put("port", link.port)
                                        }
                                        is Link.Usb -> buildJsonObject {
                                            put("connection", "usb")
                                            put("baudRate", link.baudRate)
                                        }
                                    },
                                )
                                put("framing", g.framing.wire)
                            },
                        )
                    }
                },
            )
            put(
                "refused",
                buildJsonArray {
                    for (r in message.refused) {
                        add(
                            buildJsonObject {
                                put("terminalId", r.terminalId)
                                put("reason", r.reason)
                            },
                        )
                    }
                },
            )
        }
        is Downlink.Command -> buildJsonObject {
            put("type", "command")
            put("commandId", message.commandId)
            put("leaseId", message.leaseId)
            put("terminalId", message.terminalId)
            put("op", message.op.wire)
            put("trace", message.trace)
            put("frame", message.frame)
            put("timeoutMs", message.timeoutMs)
        }
        is Downlink.Ack -> buildJsonObject {
            put("type", "ack")
            put("commandId", message.commandId)
        }
        is Downlink.SaleRecordRelease -> buildJsonObject {
            put("type", "sale_record_release")
            put("terminalId", message.terminalId)
            put("traces", buildJsonArray { message.traces.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } })
        }
        is Downlink.Goodbye -> buildJsonObject {
            put("type", "goodbye")
            put("reason", message.reason)
        }
    }
}
