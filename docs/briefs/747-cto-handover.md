# Serah terima CTO (S30:P6b2j:G1kkr -> CTO baru), 14 Nov 2026 ~13:15

Baca `~/.agents/team/roles/cto.md` dulu, lalu ini. Riwayat: ekor `docs/PROGRESS.md` dan brief 727-746.

## Langkah pertama
1. Cron (sesi saja, buat ulang): push cadangan `17 * * * *` (`git push origin --all` tanpa force, lewati non-fast-forward, lapor founder hanya bila gagal); retro 3 jam `43 1,4,7,10,13,16,19,22 * * *` (Retro 28 berikut; Sonnet high, akun Claude 7 hari terendah bukan >90%, `~/.agents/team/retro-brief.md`, log `~/.agents/team/RETRO.md`). Bila retro 13:43 belum jalan saat kamu mulai, jalankan sekali.
2. Adopsi thread (`ghostex coordinator link <ref> --task "..."`) dan pasang ulang item:
   - G8dut Merge train batch64a (brief 745; 7 cabang: fk-inline-guard, migration-replay-flake, ai-settings-v2, ai-lock-nowait (memuat ai-lock-second-opinion), shell a11y x2, flakes-u47g8; lint fix dc3863efd di batch; gate sedang antre heavy)
   - G9bm2 Wiring UI payout (brief 740 + pesan CTO: merge ws/payout-evidence-hardening, tampilkan usulan langkah-1 + bukti ke penyetuju kedua, tunai tanpa evidenceKey; legend-gthgq)
   - G86fe Hapus-buku dana terlambat (brief 741, legend-oan3p; 68e7774e2 + tambahan legend-kbf9v keputusan CTO: tolak tutup kasus mismatch tertaut selama koreksi open/pending; rebase ke m1)
   - G2idj Wiring UI alert panik (brief 743, legend-jztb7; overlay di tingkat shell fasilitas = keputusan CTO)
   - G4oon Tindak lanjut payout (brief 744; legend-styqg selesai ce1ff6298; legend-5rh26 tarik usulan dengan migrasi 0608 disetujui CTO, peminta batch tidak boleh menarik)
3. Q29 review UI ajakan WhatsApp member: page sudah dibangun subagent di `/private/tmp/claude-501/-Users-ifanshori99-Projects-legend-super-app-legend/41cd8474-bcda-49c4-bdc9-2a28320c296b/scratchpad/ui-review/review-wa.html` (founder Q28 minta dikirim). `ghostex visual check` dulu (1280 dan 390), lalu `ghostex show`, Q29.

## Antrean batch (maks 7 per batch, berurutan setelah 64a)
- 64b reservasi + KDS: ws/reservation-followups 905891fa7, ws/reservation-guest-contract c9029dfcc (0603), ui/reservation-guest-page 6e980a0e1, ui/kds-config-scanner bad105c02, ws/kds-station-save d0dc5a183 (0590/0591; prevId dari 0349, rantai snapshot wajib dibangun ulang), fix/kds-routing-inactive bee1f8dc4, ws/s-tier-flakes-ci 5c7fc0ad6.
- 64c payout (setelah G9bm2 dan G4oon selesai + second opinion Codex area payout xhigh atas evidence-hardening, followups, wiring): ui/payout-finance-exceptions fd7cc56cd, fix/finance-exceptions-known-count 5bfbcf4b2, fix/payroll-policies-hydration 7b3fb65b7, ws/payout-api-gaps adde2aebe (0600), ws/payout-evidence-hardening 2633c2195, ws/payout-followups (0608), ui/payout-wiring.
- 64d: fix/platform-offline-banner 4b461d82f, fix/ssr-hydration 991876567, fix/test-orphan-guard ea616877f, fix/edge-transport-no-outlet 3c4b17f17, fix/edge-dead-letter-alarm-cost a97e18c46 (memuat e37338e6d), fix/payout-cors-expose-headers d4f3b4c3b, fix/flake-zdfsm 38c1116a8.
- 64e: fix/e2e-pos-corrections 4ef9091ab, ct/customer-display-promo-pairing 3dfaf1a01, fix/backup-postgres-user 06eb57f9f, fix/print-dispatch-recheck cc475aa8a, ws/edge-sync-resilience ebc8a271e (lalu legend-n2d3g), fix/e2e-ijv8-qhh5 8251b8175, ws/codec-print-flake fcb651aef.
- 64f: ws/test-ci-contract 0cc687185, fix/edge-uom-issystem 181547f9f, fix/edge-snapshot-tolerant 49dea22d4 (di atas uom-issystem), ui/panic-alert 8d63ae311 + ws/panic-contract-gaps d3fdd33f5 + ui/panic-alert-wiring (G2idj), ws/writeoff-late-funds (G86fe, 0606), ui/member-whatsapp-link c3e616ddb (setelah Q29).

## Kartu siap berikut
legend-qte35 (jurnal split refund fallback, uang), legend-pitm6 sisa (payload event domain cloud->edge toleran; promo/voucher tetap strict), legend-2t69x (pemindai PDF produksi), legend-i78o6 (edge sync stations), legend-40nvj (status pemindai KDS), legend-0una (transport media umum). Flake dipantau: legend-0lyzf AUTH-01, legend-52659 Duitku (tak tereproduksi; diagnostik ada).

## Keputusan CTO hari ini (sudah di bd)
Bukti payout JPEG/PNG saja di rilis pertama (PDF 503 sampai legend-2t69x); gambar boleh tanpa pemindai nyata karena di-encode ulang sharp. Alasan penolakan reschedule tidak tampil ke tamu. Routing KDS: stasiun nonaktif dialihkan ke stasiun aktif display_order terkecil. Edge: parse cloud->edge toleran (strip) kecuali promo/voucher strict; cloud strict. isSystem opsional aman karena belum ada edge di lapangan.

## Founder
Disetujui hari ini: Q21 (Pengaturan AI), Q23-Q26 (UI payout, KDS, reservasi tamu, alert panik), Q27 (sesi CTO lama ditidurkan), Q28 (kirim review WA). Terbuka: Q20 (W32 VPS), Q29 (akan dikirim).

## Akun dan Mac
Claude #1 7d 14% (dipakai sebagian besar thread), #2 5h reset 12:30 7d 70%, #3 7d 96% (hanya < 30 menit). Codex #7, #8 7d rendah; #2 100%, #3-#6 ~90%. Disk turun cepat (tiap worktree ~1,7 GB): hapus worktree thread selesai yang bersih dan ter-push tiap gelombang; antre heavy adalah hambatan utama, jangan isi slot hanya untuk mengisi.
