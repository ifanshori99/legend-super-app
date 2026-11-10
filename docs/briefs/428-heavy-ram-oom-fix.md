# Brief: implementer — heavy/ram-guard fix setelah OOM 11 Nov 05:34-05:44

Mac 16 GB kehabisan memori (free 3%, swap 4.2 GB, dialog macOS Force Quit). Penyebab utama: 2-3 tsc (2-4 GB tiap proses) + vitest berjalan bersamaan; `heavy` membuka 5 jalur, bukan 2.

## Temuan (file:baris dari audit)
- `~/.claude/scripts/heavy:57` MAXSLOTS=4 + fast lane slot 5 (13-15, 219). Kebijakan `~/.agents/main.md:50`: 2 jalur.
- `slot_allowed` heavy:196-231: RAM dibaca sekali per putaran (157-162), swap tidak dicek (193-194). Hitung tsc via pgrep (210-216) race: tsc yang baru start belum terlihat.
- `pretool-guard.sh:62-66` `targeted()`: `LEGEND_TEST_FILES=... pnpm test` dan `vitest <path>` dianggap ringan, tanpa lock.
- `ram-sampler` interval 60 s; mode merah baru saat free<25% / level>=4 / swap>3072 MB -> terlambat (05:33 masih kuning 33%, 05:34 free 3%).

## Ubah
1. heavy: total maks 2 jalur (MAXSLOTS=2, fast lane mati). Jalur 2 hanya bila free>=50%, swap<2048 MB, pressure bukan kuning/merah, dibaca ULANG setelah lock didapat (lepas lock dan antre bila gagal).
2. tsc/typecheck: maks 1 di seluruh Mac bila free<60%, maks 2 bila >=60%. Hitung di bawah mutex yang sama dengan pengambilan lock (catat job yang sedang start di berkas state), bukan pgrep saja.
3. Test terarah (`LEGEND_TEST_FILES`, `vitest <path>`): jalur ringan sendiri, maks 2 bersamaan di seluruh Mac, dengan `--maxWorkers=2` (atau env VITEST_MAX_WORKERS) dipaksa. Tetap tidak memakai jalur berat.
4. Jangan pasang batas heap tsc di bawah kebutuhan (tsc API butuh ~6 GB heap); cukup batasi jumlah tsc bersamaan.
5. ram-sampler interval 20 s. Mode merah lebih awal: free<30% atau swap>2560 MB atau pressure>=4. Kuning: free<50% atau swap>1536 MB.
6. `~/.claude/scripts/parallel-report ... --since 00:00` mencetak "(tidak ada sesi)" padahal ada sesi hari ini: cari sebab (filter tanggal/zona waktu) dan perbaiki.
7. Perbarui teks: `~/.agents/main.md` bagian RAM (2 jalur, aturan tsc, jalur ringan test terarah) dan `~/.agents/team/TEAM.md` "Paralel dulu": satu token heavy per thread (hanya satu subagent per thread menjalankan tsc/vitest/e2e; subagent lain baca/edit saja); Explore/reviewer/architect tetap paralel penuh di mode kuning. `~/.agents/team/roles/test-writer.md` dan engineer.md: checklist test-writer (id ULID bukan UUID bila API minta ULID; path test `src/test/...` relatif ke app; gagal-dulu harus karena sebab yang benar, bukan 422/setup).

## Bukti selesai
- Test yang ada untuk ram-guard/heavy (cari `test-ram-guard*`) lulus; tambah test untuk jalur maks 2, recheck setelah lock, batas tsc, jalur ringan.
- `bash -n` semua script yang diubah.
- Jangan membunuh proses yang sedang berjalan; jangan hapus berkas lock yang dipegang PID hidup.

## Laporan
Diff ringkas per file, hasil test, perilaku baru dalam 5 baris.
