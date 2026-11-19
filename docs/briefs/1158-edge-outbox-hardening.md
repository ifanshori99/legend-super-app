# 1158 Bundel edge/outbox hardening (tingkat S, tanpa uang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, test-writer, satu implementer per kartu, berkas terpisah).
Cabang dari `origin/milestone/m1` (worktree dari Ghostex). Push tanpa `--force`. Tanpa migrasi (bila wajib: berhenti dan lapor). `bd show <id>` dulu, klaim, tutup bila selesai.
Kartu:
1. `legend-gzcw`: job outbox yang superseded menjadi no-op, recovery dihitung (`apps/api/src/services/core-outbox.ts:93-107`).
2. `legend-1ffe`: batas waktu + peringatan pada `stop()` agent EDC (`apps/api/src/edge/edc/agent.ts`).
3. `legend-7z9c`: batasi retry `revoke_retry_at` Wi-Fi + alert (cari service revoke Wi-Fi).
4. `legend-2lp.10`: heartbeat perangkat edge naik ke cloud (`apps/api/src/services/edge-device-sync.ts`, `apps/api/src/routes/edge-device.routes.ts:176`). Endpoint baru wajib auth/token edge yang sama dengan route sync yang ada.
Jangan sentuh `legend-h0q4` (kontrak bootstrap) dan berkas uang (refund, payment, kas, payout).
Bukti: test gagal-dulu per kartu. Test terarah lewat `heavy` (gabung jadi satu `LEGEND_TEST_FILES`). Prettier, eslint. Typecheck API sekali lewat `heavy` (WAJIB walau hanya test berubah). `reviewer` sonnet sekali. Jangan kirim laporan sela.
Laporan: head SHA + nama cabang, kartu selesai/dilewati, risiko. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
