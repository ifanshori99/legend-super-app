package id.legend.edcbridge.link

/**
 * `stx_bcdlen_etx_lrc` link framing (edcBridgeFramingSchema): STX, 2-byte BCD
 * body length, body, ETX, LRC = XOR of length..ETX. ACK 0x06 / NAK 0x15.
 * Done on the tablet because ACK/NAK must not cross 4G.
 */
object EcrFraming {
    const val STX: Int = 0x02
    const val ETX: Int = 0x03
    const val ACK: Int = 0x06
    const val NAK: Int = 0x15
    const val MAX_BODY = 9_999

    /** Resends after a NAK, so at most 1 + 3 sends of one frame. */
    const val MAX_RESENDS = 3

    fun bcdLength(length: Int): ByteArray {
        require(length in 0..MAX_BODY) { "body too long" }
        val digits = "%04d".format(length)
        return byteArrayOf(
            (((digits[0] - '0') shl 4) or (digits[1] - '0')).toByte(),
            (((digits[2] - '0') shl 4) or (digits[3] - '0')).toByte(),
        )
    }

    /** null when a nibble is not a decimal digit. */
    fun lengthOf(high: Int, low: Int): Int? {
        val nibbles = intArrayOf(high shr 4, high and 0x0f, low shr 4, low and 0x0f)
        if (nibbles.any { it > 9 }) return null
        return nibbles.fold(0) { acc, d -> acc * 10 + d }
    }

    fun lrc(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): Int {
        var x = 0
        for (i in from until to) x = x xor (bytes[i].toInt() and 0xff)
        return x
    }

    fun frame(body: ByteArray): ByteArray {
        val len = bcdLength(body.size)
        val out = ByteArray(body.size + 5)
        out[0] = STX.toByte()
        len.copyInto(out, 1)
        body.copyInto(out, 3)
        out[body.size + 3] = ETX.toByte()
        out[body.size + 4] = lrc(out, 1, body.size + 4).toByte()
        return out
    }
}
