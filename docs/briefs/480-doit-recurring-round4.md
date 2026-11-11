# Brief: tagihan berulang DOIT putaran 4 — temuan architect + legend-rsrcb + legend-05am0

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/6c6-recurring-billing` (b41cadd5); buat worktree `.worktrees/6c6` lagi. Keputusan CTO: semua nyata. Migrasi bila wajib: 0290 sementara (ubah) + snapshot.

## Architect putaran 4 (tidak ada P0/P1)
1. P2 `payment-recurring.service.ts:792-798`, `:450-453`: langganan `needs_reconcile` dengan `providerSubscriptionId` hanya bisa cancel -> tamu bayar tanpa akses, tidak bisa dipulihkan. Fix: izinkan pause/resume/cancel dari `needs_reconcile` bila provider id ada; jawaban terkonfirmasi menerapkan aturan status normal. Tambah `isNull(providerSubscriptionId)` di cek kunci baru. Test: resume setelah mismatch memulihkan baris; kunci baru tidak diblok baris mismatch.
2. P3 `:570-576`: start PLAN_MISMATCH tidak menyimpan id langganan DOIT. Simpan id dengan `needs_reconcile`; event plan-mismatch masuk `needs_review`.
3. P3 `payment-webhook.service.ts:1935-1970`: created-sebelum-paid hanya dalam satu batch sweep. Lewati delay retry untuk event parkir yang langganannya sekarang ada.
4. P3 `:1945`: event macet `received` > 24 jam tidak di-retry. Ambil juga `received` lebih tua dari ~5 menit.
5. P3 retry start lewat jendela idempotensi DOIT bisa membuat langganan kedua. Keputusan CTO: tolak retry otomatis intent lebih tua dari 24 jam (-> `needs_reconcile`); verifikasi reuse `reference` di sandbox tetap di legend-s5c.

## Kartu
6. legend-05am0: event langganan diparkir dijawab 200 setelah tersimpan durable (bukan 500).
7. legend-rsrcb (P1): langganan active -> past_due setelah masa tenggang 3 hari invoice tidak dibayar (PRD baris 861); cek akses membaca `current_period_end` + status; bayar terlambat -> active lagi tanpa periode ganda. Worker job harian idempoten.

Paralel: test-writer gagal-dulu per butir, implementer per file (recurring.service, webhook.service, worker past_due), lalu reviewer architect xhigh hanya untuk diff butir 1 dan 7. Bukti: test gagal-dulu, 7 berkas recurring + baru hijau, eslint+prettier, typecheck api heap 6144, `db:generate` kosong, commit+push. Laporan: commit, angka test, angka subagent.
