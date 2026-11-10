# Brief 320: engineer — penerap edge kuota Wi-Fi

## Peran
Baca `~/.agents/team/roles/engineer.md` dan hanya bagian "Paralel dulu" serta kerja berat di `~/.agents/team/TEAM.md` (Grep judul bagian, Read dengan offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (folder utama di cabang lain: jangan checkout di sana). Buat worktree: `git worktree add .worktrees/wifi-edge -b ws/wifi-edge ws/wifi-quota`, kerja hanya di sana (PORT dan nama DB sendiri).

## Tujuan
`legend-xk7az`: event outbox `wifi_quota.updated` dari cloud harus sampai ke edge node outlet dan diterapkan ke controller Wi-Fi lewat `applyWifiQuotaToEdge` / WifiProvider yang sudah ada, <=1 menit sesudah bayar. Pakai jalur cloud->edge yang sudah ada di m1 (edge link, event relay, pola event lain yang turun ke edge); jangan buat transport baru. Idempoten (event dobel atau urutan terbalik tidak menurunkan kuota), retry bila controller belum siap, edge offline: terapkan saat tersambung lagi.

## Kartu
`legend-xk7az`. Di awal: `ghostex board associate legend-xk7az` dan `bd update legend-xk7az --status in_progress`. Saat melapor: `bd update legend-xk7az --status review` dan `bd comment legend-xk7az "<ringkasan>"`.

## Scope
- Boleh: kode edge yang ada, relay/link cloud->edge, servis Wi-Fi (aditif), tes.
- Jangan: migrasi cloud baru (lapor dulu bila perlu), UI, entitlement, pembayaran. Jangan pkill proses lain; jangan ekspansi array zsh `${(@f)...}`. Jalankan tes dari root worktree.

## Bukti selesai
- Tes gagal-dulu: event sampai ke edge dan memanggil provider sekali; dobel/urutan terbalik aman; controller gagal -> retry; edge offline -> diterapkan saat tersambung; tenant lain tidak menerima.
- Tes edge + Wi-Fi hijau; typecheck lewat `heavy` bersih; eslint/prettier.
- Tingkat K (nilai berbayar): satu subagent `architect` effort high.

## Sebelum melapor
Commit lokal di `ws/wifi-edge`. Jangan push, jangan merge.

## Laporan
Hasil, bukti, file berubah, SHA, risiko tersisa.
