package id.legend.edcbridge.core

import id.legend.edcbridge.core.ClockCheckpointStore.Checkpoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClockAndPairingTest {
    @Test
    fun `monotonic clock continues within a boot and adds only new uptime after a reboot`() {
        val saved = Checkpoint(bootCount = 7, elapsedMs = 10_000, monoMs = 1_000_000)
        // Same boot, process restarted 5 s later.
        assertEquals(1_005_000, PersistentMonotonicClock.startReading(saved, 15_000, 7))
        // Rebooted: only the 3 s since this boot count, never the power-off time.
        assertEquals(1_003_000, PersistentMonotonicClock.startReading(saved, 3_000, 8))
        // Boot count unknown, uptime went back: a reboot.
        assertEquals(1_003_000, PersistentMonotonicClock.startReading(saved, 3_000, null))
        // Boot count unknown, uptime ahead: the smaller (safe) difference.
        assertEquals(1_090_000, PersistentMonotonicClock.startReading(saved, 100_000, null))
        assertEquals(0, PersistentMonotonicClock.startReading(null, 99_000, 1))
    }

    @Test
    fun `monotonic clock reads and checkpoints through the store`() {
        var elapsed = 50_000L
        var stored: Checkpoint? = Checkpoint(3, 40_000, 500_000)
        val store = object : ClockCheckpointStore {
            override fun load() = stored
            override fun save(checkpoint: Checkpoint) {
                stored = checkpoint
            }
        }
        val clock = PersistentMonotonicClock(store, { elapsed }, { 3 }, { 0L })
        assertEquals(510_000, clock.monoMs())
        elapsed += 1_000
        clock.checkpoint()
        assertEquals(Checkpoint(3, 51_000, 511_000), stored)
    }

    @Test
    fun `retention age is the shorter of the two clocks`() {
        val now = Instants(wallMs = 10_000_000, monoMs = 2_000)
        assertEquals(1_000, SaleRecordRetention.ageMs(storedAtWallMs = 0, storedAtMonoMs = 1_000, now = now))
        assertEquals(-5, SaleRecordRetention.ageMs(storedAtWallMs = 10_000_005, storedAtMonoMs = 0, now = now))
    }

    @Test
    fun `device token and server url`() {
        assertTrue(Pairing.isDeviceToken("edcb_01JDX0Z8K3QW5N7M2P4R6T8V9A_" + "A".repeat(43)))
        assertFalse(Pairing.isDeviceToken("edcb_01JDX0Z8K3QW5N7M2P4R6T8V9A_" + "A".repeat(42)))
        assertFalse(Pairing.isDeviceToken("edcb_81JDX0Z8K3QW5N7M2P4R6T8V9A_" + "A".repeat(43)))
        assertEquals("wss://pos.contoh.id/api/edc-bridge", Pairing.socketUrl("https://pos.contoh.id"))
        assertEquals("wss://pos.contoh.id:8443/api/edc-bridge", Pairing.socketUrl(" https://pos.contoh.id:8443/ "))
        assertNull(Pairing.socketUrl("http://pos.contoh.id"))
        assertNull(Pairing.socketUrl("https://pos.contoh.id/api"))
        assertNull(Pairing.socketUrl("https://user:pw@pos.contoh.id"))
        assertNull(Pairing.socketUrl("https://pos.contoh.id?token=x"))
        assertNull(Pairing.socketUrl("not a url"))
    }
}
