# Brief: engineer — fix SO refund ronde 8 (tingkat K uang)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu, base `ws/1072-refund-ronde6-q45` (head 6c0055dcb). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs --full && heavy pnpm worktree:setup`. Kerja dan push di cabang `ws/1072-refund-ronde6-q45` (bukan cabang baru): `git switch ws/1072-refund-ronde6-q45` bila worktree tidak memakainya; pastikan tidak dipakai worktree lain (`git worktree list`). Migrasi bila perlu: 0696-0697.

## Masukan
- Temuan: `docs/qa/second-opinion-refund-ronde8-1077.md` (folder utama). Kerjakan ketiganya (2 P1, 1 P2).
- Invarian I1-I9: `docs/briefs/1072-invarian.md` di cabang. Tambah I10+ bila aturan baru.
- Runbook finance: `docs/deployment.md` bagian refund.

## Keputusan CTO (sudah diambil, jangan tanya lagi)
- P1 `invalid:` prefix: hold harus selalu tersimpan. Kunci hold dibentuk dengan panjang terbatas (mis. hash/truncate deterministik) atau kolom diperlebar lewat migrasi; pilih yang tidak mengubah identitas hold lama. Test: ID 100 karakter.
- P1 transaksi beda + nominal tak terbaca: tahan sebesar seluruh pembayaran transaksi intent (bukan nominal R transaksi lain). Aturan membatasi.
- P2 `synthetic_full` konflik tidak bisa diselesaikan: beri satu jalur penyelesaian finance yang sah (audit + izin yang sama dengan resolve hold lain), tanpa membuka dana lebih dari yang terbukti. Bila ragu, hold tetap bisa diselesaikan hanya dengan `not_this_intent` sesudah refund penyedia tercatat di intent itu.
- Refund otomatis penyedia tetap MATI (Q45). Jangan sentuh flag.

## Pembagian paralel
- Explore (1): peta jalur hold di payment-webhook.service.ts dan payment-provider-partial-refund.ts.
- test-writer (1): test gagal-dulu tiga temuan (nama `refund-1077-r*`).
- implementer: satu per temuan bila file terpisah; berurutan bila file sama.
- test-runner: pemegang token heavy (setup, test terarah, regresi refund 78 file sekali di akhir, typecheck API sekali).
- architect (effort xhigh, uang): satu review atas diff akhir. Temuan nyata dibetulkan sebelum lapor.

## Bukti selesai
Test 1077 merah di 6c0055dcb dan hijau di head; regresi refund hijau; typecheck API lulus; `db:generate` kosong (atau migrasi baru tercatat); architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`.

## Sebelum melapor
Pra-gate AGENTS.md. Push tanpa `--force` ke `ws/1072-refund-ronde6-q45`. Tutup bead temuan yang dibuat; perbarui `docs/PROGRESS.md` cabang.

## Laporan
Hasil per temuan, invarian baru, bukti, berkas, commit, head SHA, risiko.
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
