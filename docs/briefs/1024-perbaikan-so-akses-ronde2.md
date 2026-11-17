# 1024 Perbaikan SO akses ronde 2 (legend-lzydj, legend-hjwi7, legend-srg8w)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (akses): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per temuan, test-writer real-socket gagal-dulu, implementer ws, implementer notification).

Base: `ghostex/4b06e171` (0069c8c59, 1021; ujung rantai 1006-1021). Cabangmu antre SESUDAH 1021.
Temuan: `docs/qa/second-opinion-akses-ronde2.md` di folder utama repo (baca dari sana; tidak ada di worktree-mu).
1. P1: perangkat yang sudah dicabut tidak boleh tersambung sebagai owner. Sesi yang pernah bertanda perangkat bersama tetap diperlakukan perangkat bersama walau tanda aktif hilang (default membatasi); pencabutan perangkat menutup sesi/socket terkait.
2. P2: penolakan perangkat ke-9 lewat websocket ikut menutup sesi, sama dengan jalur HTTP 1006.
3. P2: hapus langganan push di perangkat bersama hanya untuk langganan perangkat itu sendiri (cocokkan perangkat/sesi pemanggil); langganan perangkat lain milik owner tidak bisa dihapus tanpa PIN.
Test wajib (usul test di laporan SO): real-socket cabut perangkat lalu reconnect ditolak; perangkat ke-9 via ws tidak meninggalkan sesi yang bisa dipakai; hapus push lintas perangkat ditolak, push perangkat sendiri bisa; perangkat pribadi tidak terdampak. Gagal-dulu di base. Perbarui test kontrak 1012.
Tanpa migrasi kecuali perlu (nomor kerja 0640-0641). Jangan sentuh logika uang.
Bukti: test terarah lulus (sebut berkas), prettier/eslint, typecheck API (+web bila tersentuh) lewat heavy. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku per temuan, test, temuan architect, SHA, angka subagent.
