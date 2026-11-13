# Brief: engineer — adapter WhatsApp Kirimdev outbound + verifikasi webhook

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1` (sudah dibuat Ghostex). Push cabang kerja ke `origin` sebagai `ws/kirim-whatsapp`.

## Kartu
`legend-w8dfz` (adapter Kirim outbound produksi untuk MessagingProvider WhatsApp, dipakai reset PIN slip gaji), `legend-6qyk` (verifikasi webhook Kirimdev live: pemetaan phone_number_id, rotasi secret, tolak replay).
Cek dulu tiap kartu belum dikerjakan di basis; bila sudah, tutup dengan bukti. Di awal `bd update <id> --status in_progress`; lapor `--status review` + `bd comment <id> "<ringkasan>"`. Detail: `bd show <id>` dan PRD di `docs/prd/`.

## Tujuan dan aturan
Penyedia: Kirimdev, dokumentasi https://docs.kirimdev.com/ (BUKAN kirim.dev). Pakai Context7/dokumentasi resmi untuk API. Tanpa token nyata: test pakai fixture/mock HTTP. Webhook: verifikasi tanda tangan waktu-konstan, tolak replay (timestamp + nonce/id), dukung dua secret saat rotasi. Jangan log nomor telepon penuh, token, atau isi pesan.

## Scope
Boleh: adapter messaging, route/handler webhook Kirimdev, env.ts + .env.example key baru, test.
Migrasi: hanya rentang `0450-0452`. Jangan rahasia nyata; nama key dari `.env.example`. Jangan sentuh uang/QRIS/AI/edge darurat kecuali disebut.

## Pembagian paralel (giliran pertama)
Explore 2 (peta kode per kartu), test-writer (test gagal-dulu), implementer satu per kartu/potongan file (tidak bertumpuk), review: satu `architect` effort xhigh (auth/akses webhook), satu `test-runner` pemegang heavy.

## Bukti selesai
Gagal-dulu lalu hijau via `heavy env LEGEND_TEST_FILES="..." pnpm test`; typecheck paket yang berubah via `heavy`; `db:generate` kosong bila ada migrasi; pra-gate AGENTS.md (prettier, eslint, text-contract bila teks baru).

## Batas
Jangan `pkill`; jangan merge ke milestone/m1; jangan deploy. Jam dari `date '+%H:%M'`. tsc gagal identik 2x: baca `~/.claude/state/heavy-fail/<terbaru>` sampai habis.

## Laporan
Hasil, bukti, commit, risiko. Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
