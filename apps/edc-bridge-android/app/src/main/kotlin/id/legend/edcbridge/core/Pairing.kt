package id.legend.edcbridge.core

import java.net.URI
import java.net.URISyntaxException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

object Pairing {
    /** edcBridgeDeviceTokenSchema: `edcb_<device ULID>_<32 bytes base64url>`. */
    private val TOKEN = Regex("^edcb_[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{43}$")

    /** edcBridgePairingCodeSchema: 8 characters, A-Z and 2-9 without 0, O, 1, I, L. */
    private val CODE = Regex("^[2-9A-HJKMNP-Z]{8}$")
    private val SEPARATORS = Regex("[\\s-]")

    fun isDeviceToken(token: String): Boolean = TOKEN.matches(token)

    /** The pairing code as typed (any case, spaces or dashes allowed), upper-cased;
     * null when it is not a pairing code. */
    fun normalizePairCode(input: String): String? {
        val code = input.replace(SEPARATORS, "").uppercase()
        return if (CODE.matches(code)) code else null
    }

    /** `host[:port]` of an `https://host[:port]` address; null for anything else
     * (plain http, a path, credentials in the URL). */
    private fun authority(serverUrl: String): String? {
        val uri = try {
            URI(serverUrl.trim())
        } catch (e: URISyntaxException) {
            return null
        }
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
        val path = uri.rawPath
        if (!(path.isNullOrEmpty() || path == "/") || uri.rawQuery != null || uri.rawFragment != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "${uri.host}$port"
    }

    /** `https://host[:port]` only; the socket is `wss://host[:port]/api/edc-bridge`. */
    fun socketUrl(serverUrl: String): String? = authority(serverUrl)?.let { "wss://$it/api/edc-bridge" }

    /** Where the code is traded for the device token (B4, no session). */
    fun pairUrl(serverUrl: String): String? = authority(serverUrl)?.let { "https://$it/api/edc-bridge/pair" }

    fun pairRequestBody(code: String): String = buildJsonObject { put("code", code) }.toString()

    sealed class PairAnswer {
        data class Paired(val token: String) : PairAnswer() {
            override fun toString() = "Paired(token=[redacted])"
        }

        /** Wrong, expired, used or locked: the server does not say which. */
        object Invalid : PairAnswer()
        object RateLimited : PairAnswer()
        object Failed : PairAnswer()
    }

    /** The server's answer to POST /api/edc-bridge/pair. */
    fun parsePairAnswer(status: Int, body: String): PairAnswer {
        val json = try {
            Json.parseToJsonElement(body) as? JsonObject
        } catch (e: Exception) {
            null
        }
        return when (status) {
            200 -> {
                val token = ((json?.get("data") as? JsonObject)?.get("token") as? JsonPrimitive)
                    ?.takeIf { it.isString }?.content
                if (token != null && isDeviceToken(token)) PairAnswer.Paired(token) else PairAnswer.Failed
            }
            400 -> {
                val code = ((json?.get("error") as? JsonObject)?.get("code") as? JsonPrimitive)?.content
                if (code == "EDC_PAIR_CODE_INVALID") PairAnswer.Invalid else PairAnswer.Failed
            }
            429 -> PairAnswer.RateLimited
            else -> PairAnswer.Failed
        }
    }
}
