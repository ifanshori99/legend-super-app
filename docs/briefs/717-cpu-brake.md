# Brief: engineer (Codex) — rem beban CPU: browser headless satu sekaligus (legend-xar9p)

## Peran
Baca `~/.agents/team/roles/engineer.md`, lalu ikuti. Jangan jalankan `bd` selain `bd show` read-only.

## Lokasi
Skrip tim di luar repo: `~/.claude/scripts/` (`heavy`, `ram-guard`, hook di `~/.claude/hooks/`), test di `~/.claude/scripts/tests/`. Bukan repo git: salin tiap berkas yang diubah ke `<berkas>.bak-717` dulu.

## Tujuan
Retro 27: load1 puncak 27, 22% sampel di atas 10, karena Playwright e2e dan render screenshot/mockup (`chrome-headless-shell`, `ghostex visual check`, skrip screenshot) jalan bersamaan dari banyak thread; ram-guard tidak membaca load. Pilih opsi murah: satu kunci global "browser" sehingga paling banyak SATU proses browser headless berat (Playwright e2e, skrip screenshot, render mockup) berjalan di seluruh Mac; yang lain antre FIFO dengan pesan jelas. Cari dulu bagaimana `heavy` sudah mengklasifikasi Playwright/e2e dan kuncinya (jangan menggandakan mekanisme); bila render screenshot tidak lewat `heavy`, usulkan cara paling sedikit mengubah (mis. `heavy` mengenali perintah itu, atau wrapper kecil). Tambahkan juga pembacaan load1 ke `ram-guard status` (informasi saja, tanpa mengubah mode). Jangan ubah ambang RAM/disk atau jumlah jalur heavy yang ada.

## Bukti, sebelum melapor
Test baru (merah sebelum perubahan): dua job browser bersamaan, yang kedua menunggu; job non-browser tidak terpengaruh. SEMUA `~/.claude/scripts/tests/*.sh` lulus. Laporan: diff ringkas per berkas, cara rollback dari `.bak-717`, dan daftar perintah yang kini dianggap job browser. Ikuti `~/.agents/team/brief-template.md` "Batas kerja ulang", "Sebelum melapor", "Laporan".
