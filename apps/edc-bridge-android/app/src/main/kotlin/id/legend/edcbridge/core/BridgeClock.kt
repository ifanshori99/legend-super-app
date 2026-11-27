package id.legend.edcbridge.core

/** Both clocks the bridge reads at one instant. */
data class Instants(val wallMs: Long, val monoMs: Long)

interface BridgeClock {
    /** Wall clock (the tablet's, can be moved by anyone). */
    fun wallMs(): Long

    /** Monotonic clock that survives reboots (see [PersistentMonotonicClock]). */
    fun monoMs(): Long

    /** Saves the monotonic clock so a restart continues from here. */
    fun checkpoint() {}

    fun now(): Instants = Instants(wallMs(), monoMs())
}

/** Where [PersistentMonotonicClock] keeps its last reading. */
interface ClockCheckpointStore {
    data class Checkpoint(val bootCount: Int?, val elapsedMs: Long, val monoMs: Long)

    fun load(): Checkpoint?
    fun save(checkpoint: Checkpoint)
}

/**
 * A monotonic clock across reboots: the last saved reading plus the time
 * since boot (`SystemClock.elapsedRealtime`). It never runs ahead of real
 * time: after a reboot it only adds the uptime of the new boot, so power-off
 * time is not counted and the sale record age is a lower bound. Moving the
 * wall clock does not change it.
 */
class PersistentMonotonicClock(
    private val store: ClockCheckpointStore,
    private val elapsedRealtime: () -> Long,
    private val bootCount: () -> Int?,
    private val wall: () -> Long,
) : BridgeClock {
    private val elapsedAtStart: Long = elapsedRealtime()
    private val monoAtStart: Long = startReading(store.load(), elapsedAtStart, bootCount())

    override fun wallMs(): Long = wall()

    override fun monoMs(): Long = monoAtStart + (elapsedRealtime() - elapsedAtStart)

    @Synchronized
    override fun checkpoint() {
        store.save(ClockCheckpointStore.Checkpoint(bootCount(), elapsedRealtime(), monoMs()))
    }

    companion object {
        /**
         * Same boot (or boot unknown and uptime still ahead of the saved one):
         * add the uptime since the checkpoint. Another boot: add only the
         * uptime of this boot. Both never exceed the real time passed.
         */
        fun startReading(saved: ClockCheckpointStore.Checkpoint?, elapsedNow: Long, bootNow: Int?): Long {
            if (saved == null) return 0L
            val rebooted = (bootNow != null && saved.bootCount != null && bootNow != saved.bootCount) ||
                elapsedNow < saved.elapsedMs
            return if (rebooted) saved.monoMs + elapsedNow else saved.monoMs + (elapsedNow - saved.elapsedMs)
        }
    }
}
