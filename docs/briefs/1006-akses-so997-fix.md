# 1006 Perbaikan temuan SO 997 akses (2 P1 + 1 P2)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (test-writer gagal-dulu per temuan, satu implementer per kartu; file terpisah).

Sumber: docs/qa/second-opinion-akses.md (lokasi, skenario, usul test). Base: `ghostex/984-f586w-shared-device-wip` (839500696). Cabangmu antre SESUDAH cabang itu.
Kartu:
- legend-sq1ux (P1): sesi yang dibuat lewat sign-in Better Auth di perangkat bersama harus langsung terstempel/wajib PIN kasir; tidak boleh ada jendela sesi baru tanpa PIN. Hook pembuatan sesi membaca perangkat dari header login.
- legend-42gqp (P1): `outletFloorRouter` (floor.routes.ts ~202) memasang `resolveActingStaff` + `requireActingStaffOnSharedDevice` seperti `floorRouter` (~81). Periksa router alias lain dengan pola sama dan tutup juga (sebut di laporan).
- legend-dn7uo (P2): perangkat ke-9 tetap terlindungi saat 8 penanda aktif (tolak atau gusur yang tertua; pilih yang membatasi akses, tulis alasan).
Temuan P1 #3 (journal when) BUKAN milikmu: ditangani merge train.

Test wajib: sign-in baru di perangkat bersama tanpa PIN -> ditolak di route ber-guard; alias denah dengan cookie owner di perangkat bersama -> ditolak; perangkat ke-9 terlindungi; perangkat pribadi tidak terdampak; tenant lain tidak tersentuh. Gagal-dulu di base.
Tanpa migrasi kecuali perlu (nomor kerja 0619-0620, lapor CTO).
Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per kartu, test, temuan architect, SHA, angka subagent.
