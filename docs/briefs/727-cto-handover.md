# Serah terima CTO (S30:P6b2j:G1fi7 -> CTO baru), 14 Nov 2026 ~11:00

Baca `~/.agents/team/roles/cto.md` dulu, lalu ini. Riwayat: ekor `docs/PROGRESS.md` (entri 10:04 dan sesudahnya). Coordinator memory: volume Docker (tanya founder; Q17 anonim boleh saat disk < 30 GB), cron, CTO boleh trust all hook.

## Langkah pertama
1. Cron (sesi saja, buat ulang): push cadangan `17 * * * *` (`git push origin --all` tanpa force, lewati non-fast-forward, lapor founder hanya bila gagal); retro 3 jam `43 1,4,7,10,13,16,19,22 * * *` (Retro 28 berikut; Sonnet high, akun Claude 7 hari terendah bukan >90%, `~/.agents/team/retro-brief.md`, log `~/.agents/team/RETRO.md`).
2. Adopsi thread (`ghostex coordinator link <ref> --task "<...>"`) dan pasang ulang work item:
   - G2r4f Merge train batch63 (brief 724; W57; W8 + W31 ikut batch ini)
   - G3vo5 Stasiun dapur + nomor tiket (brief 723, W55; migrasi 0590 stations, 0591 ticket_no; architect xhigh; kartu terpisah legend-i78o6 sync edge, legend-40nvj status pemindai)
   - G475i Layar alert panik staf (W34; tes hijau, tunggu capture; akun #1 hampir 5 jam penuh, reset 11:00)
   - G433l Ajakan WhatsApp member (W15; keputusan CTO dikirim: isi tetap tampil, param kembali, pakai "kamu")
   - G1dv2 Codex aksesibilitas scroll customer shell (brief 725, W58, legend-wyhzw)
   - G2id7 Codex flake batch62 (brief 726, legend-u47g8) — belum punya item
3. W54 review UI founder: minta subagent bangun satu halaman review (Ghostex page, tombol Pick per layar) dari `docs/screenshots/payout-finance/`, `docs/screenshots/kds-config-scanner/`, `docs/screenshots/reservation-guest/` (screenshot ada di cabang masing-masing: ui/payout-finance-exceptions, ui/kds-config-scanner, ui/reservation-guest-page), `ghostex show`, Q baru (berikut Q22).

## Batch64 antre (maks 7, pecah bila lebih)
ui/ai-settings-v2 29f52256a + fix/ai-lock-second-opinion 31f4fedb9 (gerbang rilis AI tidak lagi ditahan c8dmr; Q21 founder belum jawab), ws/reservation-followups 905891fa7, ws/s-tier-flakes-ci 5c7fc0ad6, fix/shell-scroll-region-a11y bd7332434, fix/migration-replay-flake fc8e69215, fix/platform-offline-banner, fix/ssr-hydration, fix/test-orphan-guard, fix/edge-transport-no-outlet, fix/edge-dead-letter-alarm (+ -cost a97e18c46), fix/payout-cors-expose-headers d4f3b4c3b, fix/e2e-pos-corrections 4ef9091ab, fix/migration-fk-inline-guard 86a4191ad, ct/customer-display-promo-pairing 3dfaf1a01, fix/backup-postgres-user 06eb57f9f, fix/print-dispatch-recheck cc475aa8a, ws/edge-sync-resilience (lalu legend-n2d3g). Setelah review founder: ui/payout-finance-exceptions (+ fix/finance-exceptions-known-count 5bfbcf4b2, fix/payroll-policies-hydration 7b3fb65b7), ui/kds-config-scanner (+ ws/kds-station-save), ui/reservation-guest-page, ws/panic-alert + ui/panic-alert, ui/member-whatsapp-link.

## Kartu siap berikut
legend-z5ygw P1 (kontrak tamu reservasi: hasil keputusan, guard terlambat saat diminta, timeZone outlet, jadwal lama; Sonnet engineer, architect high). legend-zoqh1 P1 (endpoint unggah bukti payout, uang: architect xhigh). legend-2bl54, legend-396pf (payout). legend-f5nxl (AI lock Low). legend-oan3p (write-off yang uangnya datang kemudian, uang).

## Founder terbuka
Q20 (W32 VPS), Q21 (review Pengaturan AI). Keputusan CTO hari ini: KDS simpan dikunci bila semua stasiun nonaktif; worker approval saat AI terkunci log lalu lewati.

## Akun
Claude #1 5h 98% (reset 11:00), 7d 13%. Claude #2 5h ~33%, 7d 67%. Codex #2 7d 100% (jangan), #3-#6 7d 89-93%, #7 dan #8 dipakai.
