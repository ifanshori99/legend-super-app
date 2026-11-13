# Brief: engineer — dana kas kecil wajib sebelum belanja kecil outlet

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang). Keputusan sudah diambil founder; implementasi saja.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `ws/cash-bank` (origin, d54f4f71). Push ke `origin` sebagai `fix/petty-fund-required`.

## Keputusan founder Q8 (13 Nov 2026)
Outlet **wajib** punya dana kas kecil sebelum boleh mencatat pembelian sederhana (petty purchase). Sekarang: outlet tanpa dana tetap boleh (perilaku lama). Ubah: tanpa dana -> ditolak dengan kode jelas (mis. `PETTY_CASH_FUND_REQUIRED`) dan pesan UI dari katalog teks yang mengarahkan ke layar Kas kecil untuk membuat dana. Saldo kurang tetap ditolak seperti sekarang.

Sesuaikan test lama petty-purchase yang mengandalkan perilaku lama (beri fixture dana), jangan longgarkan asersi. Cek pemanggil lain (retur pembelian petty, e2e) ikut benar. Layar web: tombol/aksi belanja kecil menampilkan alasan bila outlet belum punya dana.

## Aturan uang (founder)
Test gagal-dulu: outlet tanpa dana -> ditolak, tidak ada jurnal/entri; outlet dengan dana cukup -> sukses, saldo berkurang tepat; saldo kurang -> ditolak; outlet lain/tenant lain ditolak.

## Pembagian paralel
Explore (alur petty purchase + pemanggil), test-writer, implementer 2 (API; web + teks), reviewer, `architect` effort high atas diff, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck lewat `heavy` sekali sebelum lapor. Teks UI baru: `node --test tests/text-contract.test.mjs`.

## Batas
Tanpa migrasi (butuh: lapor). Jangan `pkill`; jangan merge ke m1; jangan deploy. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
