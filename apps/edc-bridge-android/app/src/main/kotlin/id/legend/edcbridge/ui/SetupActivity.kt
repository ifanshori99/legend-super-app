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

/**
 * Pairing screen: server address and the one-time device token from
 * backoffice. The token field is cleared after saving and the token is never
 * shown again.
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
        val token = EditText(this).apply {
            hint = getString(if (settings.hasToken) R.string.hint_token_saved else R.string.hint_token)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        status = TextView(this)
        val save = Button(this).apply {
            text = getString(R.string.action_save_start)
            setOnClickListener { save(server.text.toString(), token) }
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
                addView(token)
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

    private fun save(serverUrl: String, tokenField: EditText) {
        if (Pairing.socketUrl(serverUrl) == null) {
            status.text = getString(R.string.error_server)
            return
        }
        val token = tokenField.text.toString().trim()
        tokenField.text.clear()
        if (token.isNotEmpty() && !Pairing.isDeviceToken(token)) {
            status.text = getString(R.string.error_token)
            return
        }
        if (token.isEmpty() && !settings.hasToken) {
            status.text = getString(R.string.error_token)
            return
        }
        settings.serverUrl = serverUrl.trim()
        if (token.isNotEmpty()) settings.saveToken(token)
        tokenField.hint = getString(R.string.hint_token_saved)
        BridgeService.start(this)
        status.text = getString(R.string.status_connecting)
    }
}
