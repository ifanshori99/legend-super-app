# Brief: engineer (Opus) — refund ronde 6 fix + refund otomatis mati (Q45)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Model Opus karena rantai refund sudah 6 ronde SO dan masih P1 (naik tingkat). Sebelum mengedit: satu subagent `architect` (effort xhigh) merumuskan INVARIAN hold konflik dan echo (satu kalimat per invarian: kapan dana boleh dibuka, kapan fact boleh dipasangkan, kapan kredit DP boleh dikurangi), lalu semua fix dan test diturunkan dari invarian itu, bukan tambal per temuan.

## Repo
Worktree base `ghostex/1033-kredit-dp-pool-net-bersama` (head 1c9e3fcaa). Rename cabang ke `ws/1072-refund-ronde6-q45`, push tanpa force.
Langkah 0 (disk sempit): di root worktree jalankan `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Bila butuh migrasi: `node ~/.claude/scripts/worktree-slim.mjs --full` sebelum `pnpm db:generate`.

## Tugas A — temuan SO ronde 6
Laporan: `docs/qa/second-opinion-refund-ronde6-1068.md` (di folder utama; baca lewat path absolut `/Users/ifanshori99/Projects/legend super app/legend/docs/qa/second-opinion-refund-ronde6-1068.md`). P1 x2 (webhook matched melewati batas nominal echo; fact kecil menyembunyikan hold lebih besar dari pool DP), P2 x2 (hold konflik ditutup lewat same_as_counted pasangan anonymous; fact pra-0679 dipakai ulang). Ronde sebelumnya: `docs/qa/second-opinion-refund-*.md`. Yang sudah diterima CTO/founder: brief 1055, 1062, 1068 bagian "Diterima".
Buat bead per temuan (`bd create ... --labels money`), sebut id di commit.

## Tugas B — legend-kmrto (founder Q45: refund otomatis penyedia mati di rilis 1)
Detail di `bd show legend-kmrto`. Saklar `DOIT_REFUNDS_ENABLED` sudah ada (default false). Buktikan dengan test tidak ada panggilan API penyedia saat mati (termasuk `paymentRefundGatewayLegacyMode()`), antrean finance manual idempoten dan <= yang dibayar tamu, pencocokan laporan penyedia tetap jalan dan laporan janggal ditahan, `docs/deployment.md`, log peringatan startup bila true.

## Aturan jangan rugi
Tiap fix uang: test bahwa tidak ada pihak dibayar lebih dan outlet tidak rugi, di urutan mana pun (webhook x poller x resolve hold x refund baru x kredit DP x jurnal). Ragu: pilih aturan yang menahan dana, catat di laporan untuk CTO.

## Migrasi
Rentang kerja 0687-0689 bila tak terhindar. Jalankan `node ~/.agents/team/check-journal.mjs origin/milestone/m1`.

## Pembagian paralel (giliran pertama)
- architect xhigh: invarian (lihat Peran).
- Explore (3): P1 echo webhook; P1/P2 hold + kredit DP + same_as_counted; Tugas B jalur gateway/legacy/antrean manual.
- test-writer (2): gagal-dulu Tugas A; gagal-dulu Tugas B.
- implementer: satu per berkas (payment-webhook.service.ts, reservation-deposit-credit.ts, refund-recon-hold.service.ts, payment-refund.service.ts/gateway), maks 4.
- test-runner: pemegang token heavy.
- Akhir: satu architect xhigh atas seluruh diff.

## Bukti selesai
Test gagal-dulu merah di 1c9e3fcaa lalu hijau; regresi refund terarah hijau; typecheck API, eslint, prettier; `db:generate` kosong; check-journal bila ada migrasi.

## Laporan
Invarian, tiap temuan -> fix -> test, commit SHA, cabang, risiko, keputusan yang perlu CTO/founder. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
