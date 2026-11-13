# Brief: webhook retry guard (legend-okrmg) + flake edge (legend-gcdq0)

Worktree: root repo ini (cabang dari milestone/m1 4d299ba5e). Jangan merge, jangan deploy.

## Kartu 1: legend-okrmg (tingkat K, uang)
- `reprocessStoredWebhookEvents` (apps/api/src/services/payment-webhook.service.ts, ~1887) mengambil baris `received`/`failed` bila `updated_at + least(2^attempts, 60) menit <= now`. attempts=0 berarti 1 menit, melewati pengaman "masih diproses" 5 menit.
- Keputusan CTO: baris `received` ditahan sampai batas 5 menit (sama dengan pengaman stuck yang ada). Baris `failed` tetap backoff biasa.
- Test gagal-dulu (aturan uang founder): (a) event `received` berumur < 5 menit tidak diproses ulang; (b) event yang sedang diproses tidak diproses dua kali, pembayaran tidak tercatat ganda, dua worker pada event sama tidak menghasilkan proses ganda (dedupe/lock); (c) event `received` macet > 5 menit tetap diretry.
- Test terkait: apps/api/src/test/payment-webhook-retry-integration.test.ts (REC-39 memakai 30 detik karena bug ini; sesuaikan bila perlu tanpa melemahkan).

## Kartu 2: legend-gcdq0 (tingkat S)
- Flake saat beban penuh: `edge-access-applier.test.ts` 'clamps a setAt in the future to the cloud clock' (set_in_past false) dan `panic-relay.test.ts` EM-19 Q94 (first_delivered_at null dalam PANIC_DELIVERY_BUDGET_MS). Hijau bila dijalankan sendiri.
- Cari akar (waktu, data bersama, urutan). Perbaiki test atau kode. Jangan sekadar menaikkan timeout.

## Aturan
- Tanpa migrasi. Test terarah dari root worktree: `LEGEND_TEST_FILES="src/test/x.test.ts" heavy pnpm test` (path relatif apps/api? lihat CLAUDE.md "Test terarah").
- Satu token heavy: hanya satu subagent menjalankan vitest/tsc pada satu waktu.
- Jangan pkill, jangan panggil DOIT/Duitku sungguhan.

## Putaran 2 kartu 1 (hasil review architect, test saja)
Kode claim (payment-webhook.service.ts) sudah benar; JANGAN ubah. Celah test: two-worker lulus di HEAD karena penyaring bukti bayar menyerap proses ganda, jadi claim belum terbukti. Kerjakan di apps/api/src/test/payment-webhook-retry-integration.test.ts:
1. Pada test two-worker (~804) dan worker-vs-live (~825): tambah asersi `attempts === 1` pada baris event dan jumlah `processed` gabungan dua worker === 1.
2. Test baru deterministik: client `owner.connect()` -> BEGIN + SELECT ... FOR UPDATE baris event stuck; jalankan worker (tertahan di claim); tunggu `pg_locks` menunjukkan lock belum didapat; `UPDATE updated_at = now` (meniru claim worker lain); COMMIT; harapkan processed 0, status tetap `received`, attempts 0, bukti bayar 0. Di HEAD (kode lama tanpa claim) test ini harus gagal: buktikan di worktree HEAD sementara (git worktree add di scratchpad, hapus sesudahnya), atau dengan menonaktifkan sementara claim lewat salinan.
3. payment-recurring-round4.test.ts ~1069-1076: perbarui komentar/nilai REC-39 yang menyebut backoff 1 menit (kini received ditahan 5 menit); jangan melemahkan asersi.
Token heavy: sebelum menjalankan vitest, tunggu baris `exit=` muncul di /private/tmp/claude-501/panic-alone.log (run panic-relay milik agent induk). Hanya LEGEND_TEST_FILES terarah lewat heavy.
