# Serah terima CTO (13 Nov 2026, dari S30:P6b2j)

Kamu CTO Legend baru. Ikuti skill `ghostex-coordinator`, `~/.agents/team/roles/cto.md` (bagian "Langkah pertama sesi CTO" dulu), `~/.agents/team/TEAM.md`. Gaya balasan: Indonesia biasa, singkat, bagian bertanda (✅ 🛫 🔄 🧪 ⚠️ 💡 ❓).

## Langkah pertama
1. Cron (CronCreate, cek CronList dulu, jangan ganda):
   - `17 * * * *` Push cadangan: di repo ini `git push origin --all` (tanpa --force). Lapor founder hanya bila gagal.
   - `43 1,4,7,10,13,16,19,22 * * *` Retro 3 jam (lihat cto.md langkah 2).
2. Baca ekor `docs/PROGRESS.md` (50 baris terakhir) dan `bd memories founder` untuk keputusan founder Q3-Q13.
3. Adopsi thread aktif (CTO lama sudah unlink; bila belum, `ghostex coordinator link <ref> --task ...`):
   - `S30:P6b2j:G04hs` Merge train batch56 ke m1 (test penuh 67 mnt 0 gagal, lalu build, FF `milestone/m1`, push, tutup bead). Brief `docs/briefs/631-merge-train-batch56.md`.
   - `S30:P6b2j:G2zip` Posting faktur pemasok AP (`ws/purchasing-posting`, brief 634).

## Langkah berikut
- Setelah batch56 masuk m1: brief batch57 ke merge train (maks 7 cabang, renumber migrasi berurutan dari ujung m1):
  `fix/webhook-retry-guard` 7304b5180, `ws/menu-pdf` f1da34fed (berisi ws/qr-menu), `ws/brand-config` 3844c4f94 (berisi ws/tenant-config-contracts), `fix/panic-relay-load` 003449e73, `fix/thr-gross-up` 3f37e056c, `fix/petty-fund-required` 0abf250ce (berisi ws/cash-bank; ada migrasi 0498_cash_limit_antisplit), `ws/purchasing-posting` (bila G2zip selesai). Rantai QRIS tetap ditahan sandbox S1.
- Setelah batch56: thread untuk `legend-3hb1n` (WA inbound live), `legend-fbf4v` (printer sync ke edge), `legend-65i3t` (Brevo alert statement provider), base m1. Isi slot dari `bd ready` sesuai hook.
- Bead baru dari kas: `legend-wjyps` (P1 tabel Kas & Bank mobile/aksi), `legend-e61s5` (P2 cek mapping saat submit), `legend-4qowr` (P2 inbox persetujuan umum).
- Payroll disbursement epic `legend-wnkep`: slice .2 setelah payroll di m1; UI .6/.7 butuh mockup + gerbang founder.
- Second opinion Codex per area (settlement, payroll, QRIS, payment-hardening, cash-bank, access/RBAC) setelah reset Codex 17-18 Nov, sebelum gerbang rilis.

## Pertanyaan founder terbuka (di board CTO lama, jangan ditanya ulang)
Q14-Q17 (W2 disbursement: Duitku+manual, biaya PT, manual dulu, bank BCA) dan Q18 (W18 anti pecah lintas outlet). CTO lama meneruskan jawabannya ke kamu lewat `agents send`. Tag pertanyaanmu berikutnya mulai Q19.

## Akun dan RAM
Claude #2 satu-satunya dengan ruang 7 hari (~41%); #1 dan #3 93-96%. Codex 89-95% (reset 17-18 Nov). Jalur heavy maks 2 se-Mac; `~/.claude/scripts/ram-guard status`.

## Aturan tetap
Jangan merge ke main/deploy tanpa gerbang founder; tanpa force push; tanpa pkill; kunci DOIT/Duitku dari founder di akhir; jangan jawab kartu persetujuan untuk founder; perintah shell pendek (Q12). Uang: test gagal-dulu, "jangan sampai rugi".
