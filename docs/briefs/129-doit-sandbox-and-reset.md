# Brief 129: engineer — reset refund lama dan persiapan uji sandbox DOIT (legend-d21p, legend-0yd1)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.
Tingkat K (refund dan data produksi): `reviewer` Opus dan `architect` bersamaan sebelum melapor.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Folder proyek sedang di cabang lain; jangan checkout di sana.
Base: `ws/doit-refund` (5316426a). `git worktree add .worktrees/doit-sandbox -b ws/doit-sandbox ws/doit-refund`. Jangan pakai `--worktree` Ghostex.

## Keputusan founder (9 Nov 2026)
- Q17: boleh reset satu kali `payout_attempts` dan `lastPayoutError` (kecuali `PAYOUT_QUARANTINED`) untuk refund approved yang di-claim sebelum gateway terpasang, dengan audit, dijalankan SEBELUM `DOIT_REFUNDS_ENABLED` dinyalakan.
- Q18: founder sudah punya akun sandbox DOIT.

## Tugas 1: legend-d21p
Skrip sekali jalan (pola `pnpm db:<nama>`), kriteria persis di `bd show legend-d21p`. Mode `--dry-run` default (hanya menghitung dan mencetak id), `--apply` menulis dengan audit per baris. Idempoten. Test.

## Tugas 2: legend-0yd1 (persiapan, tanpa rahasia dulu)
Baca checklist di `bd show legend-0yd1`. Siapkan harness uji sandbox: cara menghubungkan integrasi DOIT sandbox di env lokal worktree ini, cara webhook DOIT mencapai API lokal (tunnel), dan langkah uji per butir checklist. Jangan meminta rahasia ke founder dan jangan menjalankan `ghostex secret request`. Di laporan, tulis persis rahasia apa yang dibutuhkan (nama, dari menu mana di portal DOIT) dan langkah di portal DOIT yang harus dilakukan founder (misalnya mendaftarkan URL webhook). CTO yang meminta rahasianya, lalu mengirim path berkasnya ke kamu.

## Kartu
`legend-d21p`, `legend-0yd1`: `ghostex board associate <id>`, `bd update <id> --status in_progress` di awal; d21p `--status review` + `bd comment` saat melapor; 0yd1 tetap in_progress.

## Scope
- Boleh: skrip baru di `apps/api/src/db/`, `package.json` (script), test, dokumen harness di `docs/qa/`.
- Jangan: `app.ts`, `routes/index.ts`, `worker-main.ts`, logika payout/webhook DOIT (kecuali bug nyata ditemukan: laporkan dulu).

## Bukti selesai
`LEGEND_TEST_FILES="<file terkait>" pnpm test`, typecheck dan lint lewat `heavy`. Commit lokal di `ws/doit-sandbox`, jangan push.

## Laporan
SHA, hasil gate, temuan review K, daftar rahasia dan langkah portal DOIT untuk founder, rencana uji sandbox.
