# Brief: engineer — hold QRIS beku saat nominal salah ditolak Duitku

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `fix/codex-money` (13c03953). Push ke `origin` sebagai `fix/qris-hold-strict-amount`.

## Kartu `legend-baz8i` (keputusan CTO; jangan ditanyakan)
Bila Duitku `assertStrictAmount` menolak nominal salah, hold QRIS tetap `open` dan job tidak menutupnya: tagihan beku tanpa alert ke kasir.
Benar (ikut QH-13 + founder Q93):
- Uang nominal salah diparkir tepat sekali di dana tak teralokasi (sama dengan jalur webhook/polling di `applyConfirmation`), bukan dibuang.
- Kasir mendapat alert jelas di POS: QR dibayar nominal salah, uang diparkir, minta manajer.
- Hold tidak dilepas otomatis; manajer buka kunci lewat jalur Q93 (PIN manajer, maks 30 menit setelah QR kedaluwarsa, audit) lalu refund manual dari dana tak teralokasi.

`bd update legend-baz8i --status in_progress` di awal; lapor `--status review` + `bd comment`.

## Aturan uang (founder)
Test gagal-dulu: nominal salah via jalur Duitku strict -> parkir sekali, tagihan tidak tertutup, alert tercatat; dua notifikasi sama tidak parkir dua kali. Tidak ada pihak dibayar lebih, outlet tidak rugi.

## Pembagian paralel
Explore (jalur assertStrictAmount -> hold), test-writer, implementer, satu `architect` effort xhigh atas diff, satu `test-runner` pemegang heavy. Typecheck sekali di akhir (antrean heavy panjang). Tanpa migrasi kecuali terpaksa: rentang `0474-0475`.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy; jangan panggil Duitku sungguhan. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
