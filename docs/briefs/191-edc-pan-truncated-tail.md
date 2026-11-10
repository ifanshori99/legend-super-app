# Brief: engineer — sisa PAN di pesan EDC yang terpotong 200 karakter (legend-lg45)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/edc-pan-tail` dari ujung `milestone/m1` terbaru, worktree `.worktrees/edc-pan-tail`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-lg45` (tingkat K: data kartu). Jalur tulis lama memasking lalu memotong pesan ke 200 karakter. Tiga sisa lolos dari 0141 dan `maskCardNumbers`: PAN berpemisah ganda terpotong di ujung (<12 digit), mask terpotong yang menampilkan 7 digit awal dengan marker tidak utuh, dan `[disamarkan] - 111` (digit 13-15). Hanya pada pesan tepat 200 karakter. Tambah aturan khusus untuk run di ujung pesan 200 karakter, selaras di SQL scrub, JS, dan runbook. Pertahankan perilaku untuk pesan di bawah 200 karakter. Detail: `bd show legend-lg45`, `bd show legend-ymhh`.

## Kartu
`ghostex board associate legend-lg45`, `bd update legend-lg45 --status in_progress`; saat lapor `--status review` + `bd comment`.

## Scope
Boleh: `maskCardNumbers` dan test-nya, skrip SQL scrub edc-pan (bukan migrasi baru bila bisa: skrip dijalankan di luar jam operasional lewat `psql -1 -v ON_ERROR_STOP=1`), runbook terkait. Bila migrasi wajib: nomor + `when` di atas yang ada di m1 dan di atas 1794230000000; catat, CTO menomori ulang saat merge. Jangan: refund, pos-day, pos-shift, edge PIN, `receipt_sequences`, payroll, `app.ts`, `routes/index.ts`, `worker-main.ts`.

## Bukti selesai
Test reproduksi gagal dulu untuk tiga pola di atas (SQL dan JS memberi hasil sama pada contoh yang sama); pesan biasa tidak berubah; tidak ada positif palsu pada nominal rupiah/ID transaksi di ujung pesan. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob dengan jumlah file jalan; test root hanya lewat `pnpm test`. tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier. Jangan jalankan `pnpm check` penuh. Review K: reviewer Opus + architect paralel. Brief Codex `docs/briefs/191b-second-opinion-edc-pan-tail.md` di folder utama (tidak di-commit).

## Laporan
Sekali: hasil, bukti, file berubah, SHA, skrip/migrasi dan urutan rilis, risiko tersisa. Jangan menunggu proses global. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
