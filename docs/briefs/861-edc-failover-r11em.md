# 861 legend-r11em EDC failover wire marker (cabang fix/edc-failover-861, worktree root legend-50298aa5)

File: apps/api/src/edge/edc/agent.ts (dan test apps/api/src/test/edc-failover-861.test.ts BARU; helper test: lihat edc-so-829.test.ts P1-D/P1-H).
Uang: kartu tidak boleh tertagih dua kali; sale terbuka tidak boleh hilang. Ragu: pilih yang membatasi pembayaran.

## Desain (diputuskan engineer, fail-closed)
A. Marker dipasang ATOMIK saat dispatch claim (performSale, update claim ~L1160): set `saleWireOpenAt: now()` bersama `dispatchedAt`. Gagal tulis = claim gagal = sale tidak pernah terkirim (fail closed). Tidak ada lagi jalur "marker gagal ditulis, hanya jendela 10 menit".
B. Marker dihapus hanya saat panggilan adapter benar-benar selesai:
   - jawaban normal / error adapter yang sudah settle (bukan timeout dengan call masih jalan): applyPatch(..., {clearWireOpen:true}).
   - NotSentError (revokeDispatch): clearWireOpen juga.
   - timeout dengan call belum settle (`signal.aborted && call && !wire.settled`): marker TETAP (sudah terpasang); jalur late tetap menghapus saat settle. `setSaleWireOpen(ctx, claimed, true)` tidak perlu menulis lagi, tapi `wireOpen.add(id)` tetap sebelum apa pun.
   - Jalur late: pertahankan.
C. clearStaleWireOpen (outlet baru diakuisisi, lintas proses): hapus marker HANYA bila `dispatched_at IS NULL OR dispatched_at < now - EDC_LATE_RESPONSE_WINDOW_MS` (proses lain mungkin masih memegang panggilan; di dalam jendela marker dipertahankan). Tetap lewati id di `wireOpen` (proses ini).
D. recoverInFlight(ctx) juga memanggil clearStaleWireOpen untuk outlet yang dimiliki (agar marker proses mati yang sudah lewat jendela hilang tanpa restart).
Layanan rekonsiliasi (edc-reconciliation.service.ts) TIDAK diubah: marker non-null tetap memblokir.
Tidak ada migrasi.

## Ronde 2 (architect, temuan 1 high)
E. Marker proses mati di dalam jendela tidak pernah terhapus karena `recoverInFlight` tidak dipanggil produksi. Tambah sweep sendiri di agent: untuk tiap outlet yang diakuisisi di `start()`, `setInterval` (dep baru `staleWireSweepMs`, default 60_000, `unref()`) memanggil `clearStaleWireOpen(ctx, [outletId])` (error: logger.error, tidak melempar); dihentikan di `releaseOutlet(key)` dan `stop`. Tes baru di edc-failover-861.test.ts: crash tengah sale, start ulang di dalam jendela (marker tetap), geser `now` lewat jendela, TANPA memanggil recoverInFlight, tunggu sweep (staleWireSweepMs kecil): marker hilang; dan panggilan proses ini yang masih jalan melewati jendela TETAP menjaga markernya (wireOpen).
Temuan 2 (medium, lock hilang + adapter menggantung >10 menit di proses lama) dibawa ke CTO, tidak diubah.

## Ronde 3 (keputusan CTO: tutup residual, fail-stop)
G. Saat kunci outlet hilang (handler `lost` di acquireOutlet, agent.ts) dan proses ini masih punya panggilan adapter hidup untuk outlet itu (`wires.get(key)?.size > 0`): hentikan proses, jangan lanjut kirim. Dep baru `onFatal?: (info: {tenantId: string; outletId: string; liveCalls: number}) => void`; default produksi: `logger.fatal(...)` lalu `process.exit(1)` (supervisor restart). `owned.delete(key)` dan stopSweep tetap lebih dulu. Tanpa panggilan hidup: perilaku lama (hanya log error, tanpa exit). Marker tidak disentuh (tetap dari dispatch claim; proses lain membersihkan hanya setelah jendela).
Tes (edc-failover-861.test.ts): `newAgent` default `onFatal` = spy (JANGAN pernah process.exit di vitest). Kasus baru gagal-dulu: (1) kunci hilang + panggilan sale menggantung -> onFatal dipanggil sekali dengan liveCalls>=1; (2) kunci hilang tanpa panggilan hidup -> onFatal tidak dipanggil; (3) setelah onFatal, marker masih ada, agent kedua yang mengambil outlet di dalam jendela tidak membersihkannya, dan sale kedua tidak pernah dikirim ke adapter (saleCalls tetap 1) / rekonsiliasi 409; (4) tanpa dep onFatal custom, handler default memanggil process.exit(1) (spy pada process.exit, kode 1) - pakai vi.spyOn(process, "exit").mockImplementation.

## Ronde 3b (architect xhigh atas delta fail-stop)
H (temuan 1, high): `stop()/releaseOutlet` menghapus `owned` SEBELUM menunggu panggilan hidup, sehingga `lost` (guard `owned.get(key)?.client !== client`) tidak fail-stop saat kunci hilang selama drain. Perbaikan: peta baru `locks: Map<key, entry>` berisi entry selama kunci benar-benar dipegang. `acquireOutlet`: `owned.set` dan `locks.set`. `lost`: guard `locks.get(key)?.client !== client` -> return; lalu `locks.delete(key)`, `owned.delete(key)` bila masih entry itu, `stopSweep`, log error, `client.release(new Error("EDC outlet lock connection lost"))` (temuan 3: kembalikan slot pool; JANGAN lepas listener error/end, agar 'error' tak jadi unhandled), terakhir cek panggilan hidup -> onFatal. `releaseOutlet`: setelah loop tunggu, bila `locks.get(key) !== entry` (hilang saat drain) -> return tanpa unlock/release (sudah dilepas `lost`); selain itu `locks.delete(key)` sebelum unlock seperti sekarang.
I (temuan 4, rendah): tidak diubah (fail-stop tetap konservatif; baris tetap unknown + marker). Temuan 2 (tanpa heartbeat: kunci hilang diam-diam) dibawa ke CTO sebagai kartu.
Tes baru: (H1) sale hidup, `stop(ctx)` TIDAK di-await, loseLock -> onFatal sekali liveCalls>=1; setelah gate dilepas stop selesai tanpa error. (H3) kunci hilang tanpa panggilan hidup -> slot pool kembali (`lockPool.totalCount` 0 lewat vi.waitFor) dan onFatal tidak dipanggil.
