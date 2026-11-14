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
