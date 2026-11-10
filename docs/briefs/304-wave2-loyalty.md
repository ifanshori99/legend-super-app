# Gelombang 2 member loyalty (10 Nov, CTO)

Berlaku untuk tiga thread di bawah. Baca `~/.agents/team/roles/engineer.md`, `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), `docs/briefs/290-aturan-bersama.md`, dan `docs/design/ws08-member-loyalty.md`, lalu bagianmu di bawah.

## Bersama
- Basis: `milestone/m1` 7d388b02 (sudah berisi buku poin 111j, hadiah/misi/voucher 290c, split bill). Jangan checkout di folder utama. Worktree `.worktrees/<cabang-tanpa-ws/>`, `worktree:setup`. Jangan push, jangan merge. Disk Mac sempit: satu worktree per thread.
- Keputusan founder yang berlaku: Q68 Rp10.000 = 1 poin, 1 poin = Rp100; Q69 batas 500 poin per hari; Q71 pencatatan poin sesuai PSAK 72.
- Thread lain paralel: login member (`ws/ws01-k2l`), adapter gateway (`ws/gateway-adapter-duitku`), dua thread loyalty lain di sini. Jangan sentuh berkas milik mereka; berkas loyalty bersama (`packages/shared/src/crm/*`, `loyalty.ts`, `routes/index.ts`): ubah sesempit mungkin, merge train yang menggabung.
- Test: data sendiri di tenant fixture, bersihkan hanya milik sendiri; outlet baru wajib `opening_hours` valid (batch44 gagal 4 putaran karena ini). Jalankan juga file tes lain yang memakai tenant fixture yang sama dengan tabel yang kamu ubah.
- Bukti selesai: `pnpm db:generate` lalu periksa SQL, generate kedua kosong, test RLS migrasi; test gagal-dulu; `LEGEND_TEST_FILES` terarah (sebut jumlah file dan tes); typecheck api dan shared lewat `heavy` sekali; eslint + prettier berkas berubah, daftar berkas lewat berkas sementara + `xargs` (jangan ekspansi array zsh). Jangan `pnpm test` penuh atau `pnpm check`.
- Typecheck gagal 3 kali berturut: berhenti menebak, panggil subagent `architect`.
- Review: tingkat K (uang poin, data pribadi): satu subagent `architect` effort high (uang: xhigh).
- Kartu: `ghostex board associate <id>`, `bd update <id> --status in_progress`; selesai `--status review` + `bd comment` bahasa biasa.
- Laporan sekali di akhir: SHA, migrasi (`when`, prevId), keputusan desain, bukti, file berubah, kontrak untuk UI, kartu baru, risiko, jumlah subagent dan puncak.

## A. 290d — `legend-ts50` Customer 360, segmentasi RFM, feedback
Brief: `docs/briefs/290d-ts50-customer360-segments-feedback.md`. Cabang `ws/ts50-customer360`. Migrasi `0209`, `when` 1794288000000. Data pribadi: hormati consent dan masking yang sudah ada; lookup nomor HP jangan membocorkan terdaftar/tidak (lihat `legend-9ehr6`).

## B. 290e — `legend-3zd1` tier, kedaluwarsa poin, ulang tahun, referral + `legend-xzr10`
Brief: `docs/briefs/290e-3zd1-tiers-expiry.md`. Cabang `ws/3zd1-tiers-expiry`. Migrasi `0210`, `when` 1794289000000. Sesudah 3zd1, kerjakan `legend-xzr10` di cabang yang sama (voucher `loyalty_reward` ditolak di API voucher staf umum; `REWARD_HAS_PENDING_REDEMPTIONS` dan `REDEMPTION_CODE_UNAVAILABLE` masuk kontrak shared; `vouchers_source_check` ganda dirapikan tanpa migrasi baru bila bisa).

## C. `legend-msqvi` jurnal poin loyalti (PSAK 72)
Cabang `ws/msqvi-points-journal`. Migrasi bila perlu `0212`, `when` 1794291000000. Earn: sebagian pendapatan ditangguhkan sebagai utang poin (nilai wajar poin, Q68: 1 poin = Rp100 dikali tingkat penukaran yang diharapkan; bila belum ada data, 100% dan catat asumsinya). Tukar: utang poin turun, pendapatan diakui. Kedaluwarsa: sisa utang jadi pendapatan. Void/refund: dibalik. Pakai `posting-rules.ts` dan consumer jurnal otomatis yang ada; akun dan kebijakan lewat satu subagent `architect` (xhigh, uang), catat di `docs/DECISIONS.md`. Program poin tetap mati sampai tenant menyalakan; jurnal hanya untuk tenant yang menyala. Test: jurnal seimbang, sekali per event, isolasi tenant, pesanan latihan tidak dijurnal. Tulis brief Codex `docs/briefs/304c-second-opinion-points-journal.md`, jangan dijalankan.
