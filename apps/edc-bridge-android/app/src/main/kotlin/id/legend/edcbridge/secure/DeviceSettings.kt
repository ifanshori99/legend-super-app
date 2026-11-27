package id.legend.edcbridge.secure

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import id.legend.edcbridge.core.ClockCheckpointStore
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Pairing settings. The device token (`edcb_...`) is encrypted with an AES-GCM
 * key that never leaves the Android Keystore; only the ciphertext sits in
 * SharedPreferences. The token is never logged, shown again or put in a URL.
 */
class DeviceSettings(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("edc_bridge", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER, null)
        set(value) {
            prefs.edit().putString(KEY_SERVER, value).apply()
        }

    val hasToken: Boolean get() = prefs.contains(KEY_TOKEN)

    fun saveToken(token: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(KEY_TOKEN, Base64.getEncoder().encodeToString(sealed)).commit()
    }

    fun token(): String? {
        val sealed = prefs.getString(KEY_TOKEN, null)?.let { Base64.getDecoder().decode(it) } ?: return null
        if (sealed.size <= IV_BYTES) return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
    }

    /** Unpair: the token is gone; the journal stays (unacked results, sale records). */
    fun clearToken() {
        prefs.edit().remove(KEY_TOKEN).commit()
    }

    val clockStore: ClockCheckpointStore = object : ClockCheckpointStore {
        override fun load(): ClockCheckpointStore.Checkpoint? {
            if (!prefs.contains(KEY_CLOCK_MONO)) return null
            val boot = prefs.getInt(KEY_CLOCK_BOOT, -1)
            return ClockCheckpointStore.Checkpoint(
                bootCount = if (boot < 0) null else boot,
                elapsedMs = prefs.getLong(KEY_CLOCK_ELAPSED, 0),
                monoMs = prefs.getLong(KEY_CLOCK_MONO, 0),
            )
        }

        override fun save(checkpoint: ClockCheckpointStore.Checkpoint) {
            prefs.edit()
                .putInt(KEY_CLOCK_BOOT, checkpoint.bootCount ?: -1)
                .putLong(KEY_CLOCK_ELAPSED, checkpoint.elapsedMs)
                .putLong(KEY_CLOCK_MONO, checkpoint.monoMs)
                .commit()
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "edc_bridge_device_token"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val KEY_SERVER = "server_url"
        private const val KEY_TOKEN = "device_token_sealed"
        private const val KEY_CLOCK_BOOT = "clock_boot_count"
        private const val KEY_CLOCK_ELAPSED = "clock_elapsed_ms"
        private const val KEY_CLOCK_MONO = "clock_mono_ms"
    }
}
