# 513 Bukti migrasi 0318 dengan migrator non-BYPASSRLS (legend-2pt9d P2, migrasi, tingkat K)

Peran: engineer (~/.agents/team/roles/engineer.md). Repo: /Users/ifanshori99/Projects/legend super app/legend.
Langkah 0: `git -C "/Users/ifanshori99/Projects/legend super app/legend" fetch origin ws/ledger-guards && git -C "/Users/ifanshori99/Projects/legend super app/legend" worktree add .worktrees/ledger-0318-proof ws/ledger-guards` (cabang ada, 253b1ff7; jangan buat cabang baru). PORT dan nama DB sendiri. Migrasi sementara milik cabang: 0312-0314, 0317-0319; jangan tambah nomor lain kecuali benar perlu (pakai 0323).

Konteks: 0318 melepas dan memasang lagi FORCE RLS di sekitar backfill (fix 42501). Belum dibuktikan di DB berisi data lama dengan migrator non-BYPASSRLS, dan backfill tidak mendeteksi data lama yang sudah terklaim ganda.
Tugas: test migrasi yang membangun DB sampai 0317, mengisi baris reversal dan koreksi lama (termasuk kasus klaim ganda), menjalankan 0318-0319 sebagai role non-BYPASSRLS, lalu memastikan sukses, FORCE RLS terpasang lagi, dan data ganda dilaporkan/ditolak jelas (bukan diam). Betulkan migrasi bila gagal.
Bukti: test gagal-dulu bila ada bug; subagent architect effort xhigh atas diff. Gate test terarah lewat `heavy`, db:generate kosong. Commit, push ws/ledger-guards fast-forward (tanpa --force). bd: 2pt9d.
Laporan: commit, hasil test, temuan architect, angka subagent.
