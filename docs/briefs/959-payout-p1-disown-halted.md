# 959 Payout: dua bug P1 persetujuan batch + test grant (K uang + migrasi)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang + migrasi).
Cabang: worktree-mu dari `origin/ghostex/954-payout-so950-followups` (bdb38848e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0485-0489 (nomor kerja).
Kartu (`bd show <id>`; claim dulu):
- legend-s20iu (P1): batch yang disangkal ('Bukan saya') lalu di-unfreeze kembali ke pending_approval; persetujuan utama baru wajib grant batch_approve dari orang lain (bukan pemohon, bukan penyangkal).
- legend-dz8ci (P1): pada batch halted kolom persetujuan tidak bisa diubah tanpa grant (trigger 0344 sekitar baris 249); guard sama dengan PAYOUT-83; test SQL langsung ditolak.
- legend-lf0oj (P3): test grant kedaluwarsa saat menunggu lock baris grant ditolak PAYOUT-70 dan tetap unspent.
Jangan sampai rugi: test bukti tidak ada dana keluar dari batch yang disangkal sebelum persetujuan ulang yang sah, dan update SQL langsung pada batch halted ditolak.
Paralel: Explore + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu; lalu test-runner + architect xhigh bersamaan. Suite payout hanya setelah kode beku (Retro 39).
Bukti: gagal-dulu lalu hijau; test area payout + registry lewat heavy setelah commit terakhir; pra-gate AGENTS.md (prettier, eslint, db:generate kosong, registry migrasi dan `when` unik, typecheck API sekali); architect tanpa P1.
Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari ketiga kartu. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
