# 1012 Akses: audit dan tutup router tanpa guard perangkat bersama (legend-3z0ds)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (2-3 Explore membagi apps/api/src/routes/*.routes.ts per kelompok, test-writer, implementer per kelompok router).

Base: `ghostex/f12296d2` (419e34451, 1006: sign-in terstempel, outletFloorRouter ber-guard, batas 8 penanda). Cabangmu antre SESUDAH 1006. Konteks: laporan thread 1006 (`ghostex read-session-chat S30:P6b2j:G65pc --last 6 --format text`) menyebut router lain yang belum memakai `resolveActingStaff` + `requireActingStaffOnSharedDevice`.
Kerja:
1. Inventaris semua router: mana yang dipanggil dari layar POS/kasir/KDS di perangkat bersama (cocokkan dengan `POS_PATH` di web dan pemakaian di apps/web/src/features/ws04-*), mana yang hanya backoffice.
2. Router yang bisa dipakai di perangkat bersama: pasang kedua guard (pola `floorRouter`). Default membatasi: bila ragu, pasang guard.
3. Router backoffice-only: pastikan perangkat bersama tidak bisa memakainya dengan cookie owner (tolak atau wajib PIN), sesuai pola yang ada.
4. Tambah test kontrak yang gagal bila router baru dibuat tanpa keputusan guard (daftar eksplisit, bukan filter longgar).
Test wajib: tiap router yang ditutup menolak cookie owner di perangkat bersama tanpa PIN; perangkat pribadi tidak terdampak; web POS_PATH ikut diperbarui sehingga layar tidak 401. Gagal-dulu di base.
Tanpa migrasi. Jangan sentuh logika uang.
Bukti: test terarah lulus (sebut berkas), test web terkait, prettier/eslint, typecheck API + web lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): tabel router -> keputusan, test, temuan architect, SHA, angka subagent.
