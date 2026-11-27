package id.legend.edcbridge.core

import java.net.URI
import java.net.URISyntaxException

object Pairing {
    /** edcBridgeDeviceTokenSchema: `edcb_<device ULID>_<32 bytes base64url>`. */
    private val TOKEN = Regex("^edcb_[0-7][0-9A-HJKMNP-TV-Z]{25}_[A-Za-z0-9_-]{43}$")

    fun isDeviceToken(token: String): Boolean = TOKEN.matches(token)

    /** `https://host[:port]` only; the socket is `wss://host[:port]/api/edc-bridge`.
     * null for anything else (plain http, a path, credentials in the URL). */
    fun socketUrl(serverUrl: String): String? {
        val uri = try {
            URI(serverUrl.trim())
        } catch (e: URISyntaxException) {
            return null
        }
        if (uri.scheme != "https" || uri.host.isNullOrEmpty() || uri.rawUserInfo != null) return null
        val path = uri.rawPath
        if (!(path.isNullOrEmpty() || path == "/") || uri.rawQuery != null || uri.rawFragment != null) return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        return "wss://${uri.host}$port/api/edc-bridge"
    }
}
