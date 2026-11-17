# 1002 Reseal kunci: ChatGPT + push_subscriptions (K1-K4)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (kunci/akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (K1 dan K2 implementer paralel + test-writer gagal-dulu, K4 doc-writer paralel dengan K3).

Desain wajib: `git show origin/ghostex/c49a6184:docs/design/reseal-chatgpt-push.md` (Opsi B; salin ke cabangmu sebagai docs/design/reseal-chatgpt-push.md). Ikuti persis; menyimpang hanya dengan alasan tertulis di laporan.
Base: cabang `ghostex/995-refund-voucher-hardening-kecil` (892f58a11, mengubah file job reseal yang sama). Cabangmu masuk antrean SESUDAH 995. Jalankan `pnpm worktree:setup` dulu (worktree baru belum punya node_modules).

Kartu:
- legend-7rd7l K1: kerangka job, label `key_version` (`v<N>`) di UPDATE yang sama, entri `push_subscriptions` (AAD `extra: ["user_id"]` sudah didukung). File: worker/sealed-secret-reseal.job.ts + test push baru.
- legend-g24b5 K2: `resealChatgptConnectionAny` di services/ai-chatgpt.service.ts (try-lock lease, lewati baris ber-lease + 10 menit, satu UPDATE CAS atas kedua kolom terenkripsi + generation + operation_id; jangan ubah updated_at/lease/status; tanpa audit; tidak pernah memutus koneksi) + test/ai-chatgpt-reseal.test.ts.
- legend-4w7rf K3 (setelah K1+K2): kait `SEALED_SERVICE_SWEEPS`, hormati `reportOnly`, test pensiun kunci menyeluruh. Test balapan wajib bagian 7: T1, T2, T3, T6, P3, R1, R4, R5, R6.
- legend-iqzet K4: runbook pensiun kunci di docs/deployment.md (aturan bagian 4.4: aborted=false, failed=0, failedTenants=0, remaining=0 termasuk frozen; langkah operator baris rusak) + DECISIONS.md.

Tanpa migrasi (desain menyatakan tidak perlu; bila ternyata perlu: nomor kerja 0611, lapor CTO). Jangan sentuh payout*, payment*, order*.
Bukti selesai: test gagal-dulu, test terarah lulus, prettier/eslint, typecheck API lewat heavy, `db:generate` kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop): perilaku per kartu, test, temuan architect, SHA, angka subagent (total, puncak, pemegang heavy).
