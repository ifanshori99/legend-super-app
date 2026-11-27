package id.legend.edcbridge.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.provider.Settings
import id.legend.edcbridge.BuildConfig
import id.legend.edcbridge.R
import id.legend.edcbridge.core.BridgeCore
import id.legend.edcbridge.core.BridgeDispatcher
import id.legend.edcbridge.core.Pairing
import id.legend.edcbridge.core.PersistentMonotonicClock
import id.legend.edcbridge.data.JournalDatabase
import id.legend.edcbridge.data.RoomJournalStore
import id.legend.edcbridge.link.LinkConnectors
import id.legend.edcbridge.link.TerminalRunner
import id.legend.edcbridge.secure.DeviceSettings
import id.legend.edcbridge.ui.SetupActivity
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient

/**
 * Foreground service (type connectedDevice): keeps the WSS session to the
 * cloud and talks to the EDC on the LAN. Runs while the tablet is on; the
 * cashier PWA does not depend on it being in front.
 */
class BridgeService : Service() {
    private lateinit var scheduler: ScheduledExecutorService
    private lateinit var commands: ExecutorService
    private var connection: WssConnection? = null
    private var database: JournalDatabase? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        scheduler = Executors.newSingleThreadScheduledExecutor()
        commands = Executors.newCachedThreadPool()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW),
        )
        val notification = notification(getString(R.string.status_connecting))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (connection == null) start()
        return START_STICKY
    }

    private fun start() {
        val settings = DeviceSettings(this)
        val url = settings.serverUrl?.let { Pairing.socketUrl(it) }
        if (url == null || !settings.hasToken) {
            status(WssConnection.Status.NOT_PAIRED)
            stopSelf()
            return
        }
        val db = JournalDatabase.open(this).also { database = it }
        val clock = PersistentMonotonicClock(
            store = settings.clockStore,
            elapsedRealtime = SystemClock::elapsedRealtime,
            bootCount = { Settings.Global.getInt(contentResolver, Settings.Global.BOOT_COUNT, -1).takeIf { it >= 0 } },
            wall = System::currentTimeMillis,
        )
        val core = BridgeCore(RoomJournalStore(db.journal()), clock, BuildConfig.VERSION_NAME, ::ownIpv4Addresses)
        val client = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
        val wss = WssConnection(client, url, settings::token, scheduler, ::status)
        wss.dispatcher = BridgeDispatcher(core, TerminalRunner(LinkConnectors(), commands), wss::onGoodbye)
        connection = wss
        scheduler.execute {
            // Before the first hello: sales that were in flight become
            // transport_error results, old records go.
            core.recover()
            core.purge()
            clock.checkpoint()
            wss.connect()
        }
        scheduler.scheduleWithFixedDelay({ clock.checkpoint() }, 1, 1, TimeUnit.MINUTES)
        scheduler.scheduleWithFixedDelay({ core.purge() }, 1, 1, TimeUnit.HOURS)
    }

    private fun status(status: WssConnection.Status) {
        val text = getString(
            when (status) {
                WssConnection.Status.CONNECTING -> R.string.status_connecting
                WssConnection.Status.CONNECTED -> R.string.status_connected
                WssConnection.Status.WAITING -> R.string.status_waiting
                WssConnection.Status.NOT_PAIRED -> R.string.status_not_paired
                WssConnection.Status.REVOKED -> R.string.status_revoked
                WssConnection.Status.UPDATE_REQUIRED -> R.string.status_update_required
                WssConnection.Status.STOPPED -> R.string.status_stopped
            },
        )
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
        getSharedPreferences(STATUS_PREFS, MODE_PRIVATE).edit().putString(STATUS_KEY, text).apply()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, SetupActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        connection?.stop()
        connection = null
        scheduler.shutdownNow()
        commands.shutdown()
        database?.close()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "bridge"
        private const val NOTIFICATION_ID = 1
        const val ACTION_STOP = "id.legend.edcbridge.STOP"
        const val STATUS_PREFS = "edc_bridge_status"
        const val STATUS_KEY = "status"

        fun start(context: Context) {
            context.startForegroundService(Intent(context, BridgeService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BridgeService::class.java).setAction(ACTION_STOP))
        }

        /** The tablet's own IPv4 addresses: a lease pointing at one is refused. */
        fun ownIpv4Addresses(): Collection<String> =
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .mapNotNull { it.hostAddress }
    }
}
