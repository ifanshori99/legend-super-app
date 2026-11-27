package id.legend.edcbridge.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import id.legend.edcbridge.secure.DeviceSettings

/** Starts the bridge after the tablet boots, once it is paired. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (DeviceSettings(context).hasToken) BridgeService.start(context)
    }
}
