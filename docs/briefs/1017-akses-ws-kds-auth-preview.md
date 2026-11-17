# 1017 Akses: websocket KDS, /api/auth/*, dan preview customer-display di perangkat bersama (legend-wa9n7, legend-dgtz0)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per kartu, test-writer, implementer per kartu; berkas tidak bertumpuk).

Base: `ghostex/1012-guard-router-perangkat-bersama` (ca8ba4eb7; requireAuth tertutup default, test kontrak 182 router). Cabangmu antre SESUDAH 1012.
1. legend-wa9n7: websocket KDS (`kds-realtime-auth.ts:88`) dan `/api/auth/*` Better Auth tidak lewat gate perangkat bersama. Websocket: wajib token kasir/perangkat KDS terdaftar sesuai pola 1012. `/api/auth/*`: sesi bertanda perangkat bersama tidak boleh mengubah akun pemilik (ganti password/email, sesi lain, MFA, passkey) dari tablet; sign-in/sign-out dan get-session tetap jalan. Default membatasi.
2. legend-dgtz0: preview customer-display tanpa token kasir bisa membaca bill outlet lain. Batasi ke outlet perangkat terdaftar/tenant pemanggil; data minimal.
Test wajib: tiap jalur menolak di perangkat bersama tanpa hak; perangkat pribadi tidak terdampak; lintas outlet dan lintas tenant ditolak; tidak ada data bill outlet lain terbaca. Gagal-dulu di base. Perbarui test kontrak 1012 bila menambah keputusan.
Tanpa migrasi. Jangan sentuh logika uang.
Bukti: test terarah lulus (sebut berkas), test web terkait, prettier/eslint, typecheck API (+web bila tersentuh) lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
