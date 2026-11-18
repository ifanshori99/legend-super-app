# 1109 Second opinion area gerbang rilis 1 (pembayaran, payout, deploy)
Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree: `git diff`/`git show` dari folder utama, jangan checkout. Selesaikan dan lapor dalam SATU giliran (jangan akhiri giliran untuk kabar antara).

Fokus (tiap cabang terhadap milestone, kecualikan `':!**/meta/*snapshot.json'`), sesudah `git fetch origin`:
- `git diff origin/milestone/m1...origin/ws/1097-gerbang-payout-rekon` (7585a887f): gerbang data rilis 1 payout/rekon (0go0p, 7hg1q, 9bfh7, ofu02). Brief: docs/briefs/1097*.md bila ada.
- `git diff origin/milestone/m1...origin/ws/1098-gerbang-doit-duitku` (7ada4e49b): DOIT recurring mati default (`DOIT_RECURRING_ENABLED`, 503 `RECURRING_BILLING_DISABLED`), preflight promo active/paused/draft, probe DOIT/Duitku opt-in. Brief: docs/briefs/1098-gerbang-doit-duitku.md, docs/briefs/1102-fix-1098-doit-off.md.
- `git diff origin/milestone/m1...origin/ws/1100-gerbang-deploy` (2db9947b6): runner gerbang data `apps/api/src/db/release-gates.ts` di predeploy-check (READ ONLY, satu statement per berkas, N/A di DB baru), drift hash migrasi, peran migrator production. Brief: docs/briefs/1100-gerbang-deploy.md.
Urutan landing: 1097 dan 1098 sebelum 1100 (lihat docs/merge-queue.md).

Diterima CTO/founder (jangan dilaporkan): refund otomatis penyedia mati di rilis 1 (Q45); DOIT recurring mati di rilis 1; tidak ada backfill legacy di rilis 1 (finance manual); P2 service-level DOIT sudah jadi bead legend-ww562.

Cari: gerbang bisa lolos padahal data berisiko (false pass), terutama kondisi yang membuat uang keluar lebih dari yang dibayar atau outlet rugi; jalur pembayaran/recurring yang masih bisa menagih atau membayar saat saklar mati (route lain, job, webhook, retry); runner gerbang tidak benar-benar read-only (statement ganda, fungsi bervolatil, `SET`, CTE yang menulis, peran salah); N/A di DB baru menyembunyikan DB lama yang bermasalah; probe sandbox bisa memanggil production atau membocorkan rahasia di log; drift hash bisa dilewati; urutan landing yang salah membuat gerbang rusak.

Hasil: tulis `docs/qa/second-opinion-gerbang-rilis-1109.md` di folder utama (P0-P3, berkas:baris, skenario, usul test). JANGAN commit, JANGAN edit file lain.
