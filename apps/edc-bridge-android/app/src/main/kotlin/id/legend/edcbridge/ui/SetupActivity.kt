package id.legend.edcbridge.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import id.legend.edcbridge.R
import id.legend.edcbridge.core.Pairing
import id.legend.edcbridge.secure.DeviceSettings
import id.legend.edcbridge.service.BridgeService
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Pairing screen: server address and the 8-character pairing code from
 * backoffice (B4 legend-wasr7.24). The code is traded once at
 * POST /api/edc-bridge/pair for the device token, which goes straight into
 * DeviceSettings (Android Keystore) and is never shown. The code field is
 * cleared at once; neither is logged.
 */
class SetupActivity : Activity() {
    private lateinit var settings: DeviceSettings
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = DeviceSettings(this)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val server = EditText(this).apply {
            hint = getString(R.string.hint_server)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(settings.serverUrl ?: "")
        }
        val code = EditText(this).apply {
            hint = getString(if (settings.hasToken) R.string.hint_code_saved else R.string.hint_code)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        status = TextView(this)
        val save = Button(this).apply {
            text = getString(R.string.action_save_start)
            setOnClickListener { save(server.text.toString(), code) }
        }
        val stop = Button(this).apply {
            text = getString(R.string.action_stop)
            setOnClickListener { BridgeService.stop(this@SetupActivity) }
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad, pad, pad)
                addView(TextView(this@SetupActivity).apply { text = getString(R.string.setup_intro) })
                addView(server)
                addView(code)
                addView(save)
                addView(stop)
                addView(status)
            },
        )
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onResume() {
        super.onResume()
        status.text = getSharedPreferences(BridgeService.STATUS_PREFS, MODE_PRIVATE)
            .getString(BridgeService.STATUS_KEY, getString(R.string.status_stopped))
    }

    private fun save(serverUrl: String, codeField: EditText) {
        val pairUrl = Pairing.pairUrl(serverUrl)
        if (pairUrl == null) {
            status.text = getString(R.string.error_server)
            return
        }
        val typed = codeField.text.toString()
        codeField.text.clear()
        if (typed.isBlank()) {
            if (!settings.hasToken) {
                status.text = getString(R.string.error_code)
                return
            }
            // The saved token belongs to the saved server only.
            if (!Pairing.sameServer(settings.serverUrl, serverUrl)) {
                status.text = getString(R.string.error_code_new_server)
                return
            }
            settings.serverUrl = serverUrl.trim()
            BridgeService.reload(this)
            status.text = getString(R.string.status_connecting)
            return
        }
        val code = Pairing.normalizePairCode(typed)
        if (code == null) {
            status.text = getString(R.string.error_code)
            return
        }
        status.text = getString(R.string.status_pairing)
        Thread {
            val answer = try {
                val request = Request.Builder()
                    .url(pairUrl)
                    .post(Pairing.pairRequestBody(code).toRequestBody(JSON))
                    .build()
                http.newCall(request).execute().use { response ->
                    Pairing.parsePairAnswer(response.code, response.body?.string() ?: "")
                }
            } catch (e: IOException) {
                Pairing.PairAnswer.Failed
            }
            runOnUiThread { paired(serverUrl, codeField, answer) }
        }.start()
    }

    private fun paired(serverUrl: String, codeField: EditText, answer: Pairing.PairAnswer) {
        when (answer) {
            is Pairing.PairAnswer.Paired -> {
                settings.serverUrl = serverUrl.trim()
                settings.saveToken(answer.token)
                codeField.hint = getString(R.string.hint_code_saved)
                BridgeService.reload(this)
                status.text = getString(R.string.status_connecting)
            }
            Pairing.PairAnswer.Invalid -> status.text = getString(R.string.error_code_invalid)
            Pairing.PairAnswer.RateLimited -> status.text = getString(R.string.error_code_rate_limited)
            Pairing.PairAnswer.Failed -> status.text = getString(R.string.error_pair_failed)
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        val http: OkHttpClient = OkHttpClient.Builder()
            .callTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
