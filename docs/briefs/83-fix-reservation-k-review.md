# Brief: perbaikan review K ws/reservation-selfservice (dc4e32bc) — kecil

Kirim ke thread "Reservasi mandiri tamu" (G2m46). Worktree `.worktrees/reservation-selfservice`.

1. Rendah — `apps/api/src/services/reservation-public.ts:520-556`: POST cancel tamu tidak cek `now < row.reservedFor` (hanya `canCancelNow` untuk tampilan); reservasi tanpa DP yang tidak datang bisa dibatalkan tamu sampai 24 jam setelah jam reservasi → catatan no-show hilang. Fix: tolak `RESERVATION_TRANSITION_INVALID` bila `now >= row.reservedFor`, sebelum `assertReservationTransition`. Test.
2. Komentar `routes/reservation-public.routes.ts:371-379` salah: path tetap di `PUBLIC_RATE_LIMIT_PATHS` (`middleware/public-rate-limit.ts:284`), jadi tetap kena batas per-tenant. Betulkan komentar (keputusan CTO: batas bersama dipertahankan).
3. Migration 0068: `when` 1794145373560 < 0068/0069 di `ws/edge-registry-pull`. Tidak diubah sekarang; diurus saat merge ke milestone (generate ulang, lihat "Catatan merge milestone" di PROGRESS).

Bukti: test terfokus + gerbang penuh; commit lokal.
