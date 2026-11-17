# 1013 Jurnal otomatis dan breakfast memakai nilai net setelah refund provider (legend-tlm3h)

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5, effort high. Tingkat K (uang/akuntansi): review satu subagent architect effort xhigh.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (Explore per lokasi, test-writer gagal-dulu, implementer akuntansi dan implementer breakfast terpisah).

Base: `ghostex/1009-so996-f1-lunas-refund` (daf8ace2a, di atas 980). Cabangmu antre SESUDAH 1009.
Lokasi dari laporan 1009: `accounting-auto-journal-amounts.ts:1672`, `accounting-auto-journal-guards.ts:753-763` dan `:1343-1372` (memakai nominal intent bruto, mengabaikan refund provider), `facility-breakfast-consumers.ts:268-275` (0 < net < total diteruskan sebagai split). Pakai `netAllocatedIdrSql`/`refundableBalance` dari 980; jangan salin aturan.
Perilaku: jurnal pendapatan/kas mengikuti nilai net yang benar-benar diterima; refund provider tercermin sekali (tidak ganda dengan jurnal refund yang sudah ada). Breakfast: net di bawah total tidak dianggap lunas sebagian diam-diam; ikuti pola void + refund sisa 1009.
Test wajib: refund provider sebagian lalu paid -> jurnal seimbang dan sama dengan net; refund provider setelah jurnal paid -> jurnal pembalik tepat sekali; event ganda tidak menggandakan jurnal; breakfast net < total tidak menerbitkan voucher/akses; tenant lain tidak tersentuh. Gagal-dulu di base.
Migrasi hanya bila perlu, nomor kerja 0632-0633.
Bukti: test akuntansi/pembayaran/breakfast terarah lulus (sebut berkas), prettier/eslint, typecheck API lewat heavy, db:generate kosong. Commit, push tanpa force, hapus worktree subagent milikmu.
Laporan sekali di akhir (Monitor, bukan sleep loop; jangan akhiri giliran untuk kabar antara): perilaku, test, temuan architect, SHA, angka subagent.
