# 1018 Tablet bersama: token KDS websocket lewat subprotocol + keep-alive sesi (legend-dsbqr, legend-hlmbk)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore kds-realtime + web KDS, test-writer, implementer API, implementer web).

Base: `ghostex/34755844` (a4fd0a639, 1017: websocket KDS wajib kredensial perangkat lewat header). Cabangmu antre SESUDAH 1017.
1. legend-dsbqr: browser tidak bisa memasang header di websocket, jadi layar KDS di tablet bersama sekarang ditolak. Tambah pembawa token perangkat (+ token kasir bila wajib) lewat `Sec-WebSocket-Protocol`, validasi sama dengan header 1017, jangan pernah lewat query string atau log. Server membalas subprotocol yang dipilih. Client web KDS (bila belum ada, buat client tipis di features KDS) memakai pembawa ini. Perangkat pribadi tetap jalan seperti sebelumnya.
2. legend-hlmbk (keputusan CTO 17 Nov): izinkan `POST /api/auth/sessions/current/activity` untuk sesi perangkat bersama (`requireAuthAllowSharedDevice`). Tanpa ini tablet logout saat idle. Endpoint lain di /api/auth tetap 403; perbarui test kontrak 1012/1017.
Test wajib: ws dengan subprotocol sah diterima, token salah/dicabut/outlet lain/tenant lain ditolak, token tidak muncul di log; keep-alive lulus di perangkat bersama dan endpoint ubah akun tetap 403. Gagal-dulu di base.
Tanpa migrasi. Jangan sentuh logika uang.
Bukti: test terarah API + web lulus (sebut berkas), prettier/eslint, typecheck API dan web lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
