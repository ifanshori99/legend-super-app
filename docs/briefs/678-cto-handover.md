# Serah terima CTO (S30:P6b2j:G5nn9 -> CTO baru), 14 Nov 2026 ~06:40

Baca `~/.agents/team/roles/cto.md` dulu, lalu ini. Riwayat: ekor `docs/PROGRESS.md`. Coordinator memory: note 1 volume Docker (tanya founder), note 2 cron, note 3 CTO boleh trust all hook.

## Langkah pertama
1. Cron (note 2): push cadangan `17 * * * *`, retro 3 jam `43 1,4,7,10,13,16,19,22 * * *` (Retro 27 belum jalan; terakhir Retro 26 02:13).
2. Adopsi thread (`ghostex coordinator link <ref> --task "<...>"`) dan pasang ulang work item:
   - G2r4f Merge train batch61 (run penuh terakhir; architect sudah APPROVE fix 0348 191163780 + allowlist 02512c581; boleh fast-forward milestone/m1 bila hijau; e2e mzg/rx0h/sgg merah juga di base -> legend-y4f3l)
   - G1zoc Celah jurnal otomatis GL (brief 675, K uang, architect xhigh)
   - G5qf5 Reschedule reservasi (brief 676)
   - G2md5 Lanjutan bonus referral (brief 677, base ws/loyalty-points-money; keputusan founder Q5 pulihkan, Q6 tidak boleh)
   - G4zrq Codex designer Pengaturan AI (brief 668, akun #7)
   - G0jin Codex designer pencairan gaji + pengecualian finance (brief 669, akun #7)
   - G7b5z Codex second-opinion payout gaji xhigh (brief 670, akun #8) — sempat terinterupsi, sudah dikirimi ulang brief
3. Hook Codex: layar "Hooks need review" -> `ghostex send-text <ref> "2"` lalu `ghostex send-key <ref> enter` (izin founder, note 3).

## Batch62 (setelah batch61, maks 7)
ws/finance-exceptions 598cd9cb1 (memuat edge-sync-resilience + payroll-payout-hardening), ws/platform-pos-security-small c5e32f9b7, ws/reports-ops-backend b37720212, ws/suite-flakes 42c01af2c, ws/loyalty-points-money 4bf7760b5, ws/reports-dashboard-fixes 10f70821c, ws/hris-leave-flakes e6a423b3d.
WAJIB: `_journal.json` idx 333/334 ganda dan `when` 0538/0539 > 0534-0543 (pakai `~/.agents/team/check-journal.mjs`); 0550 snapshot disalin dari 0347; e2e auth.spec.ts (postLoginPath). Setelah merge tutup gnm6y, 9uks, u7ozi, 60psh, y9uop.
Batch63: ws/panic-alert 6bf7beb1b, ws/loyalty-referral-followups, auto-journal, reservasi.

## Workflow baru (founder 14 Nov, sudah di TEAM.md/main.md 3.6)
Codex boleh engineer kartu S (akun #7 lalu #8, tanpa batas 5 jam). Claude #1 (7d ~3%, reset 17 Nov) dan #2 (60%) untuk K. Slot Codex dibatasi RAM 3. Brief: rename cabang ws/* + push, fail-first terhadap base, check-journal.

## Keputusan founder hari ini
Q1: format file bank BCA setelah rilis; awal Duitku disbursement atau transfer manual. Q5: bonus referral dipulihkan bila refund ditolak. Q6: order dibayar penuh poin tidak memicu bonus referral.

## Antre
legend-alovk mockup banner darurat (designer Codex, setelah slot kosong). legend-p4q10 diparkir (arah di komentar). legend-eqdcd, legend-kkojp, legend-ecgfy lanjutan.
