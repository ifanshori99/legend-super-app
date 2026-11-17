# 965 DOIT recurring: cegah tagih dobel + alat reconcile

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang, migrasi).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (0c31ff40e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0500-0504 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-ycb85: kunci start baru di samping baris PLAN_MISMATCH yang sudah punya id DOIT bisa menagih dua kali. Tolak start baru selama ada baris mismatch ber-id DOIT yang belum dibatalkan.
- legend-yqne1: alat resolve untuk langganan `needs_reconcile` yang sudah punya provider id (cocokkan status DOIT), plus unique index supaya dua start bersamaan untuk plan+pelanggan yang sama tidak lolos keduanya (migrasi; cek dulu data yang bisa melanggar index).
- legend-lch2o: alat reconcile manual untuk start intent > 24 jam yang terblokir (cek status DOIT, lanjutkan atau batalkan).
- legend-145n0: satu integrasi DOIT AKTIF dengan kredensial rusak membuat `loadWebhookSecrets`/`listIntegrations` melempar dan semua webhook tenant itu 500. Lewati integrasi rusak, catat peringatan (tanpa log rahasia).
Cari kode: grep `PLAN_MISMATCH`, `needs_reconcile`, `loadWebhookSecrets`. Konteks lama: `docs/briefs/480-doit-recurring-round4.md`, kartu legend-6c6.

Jangan sentuh: alur refund/rekonsiliasi pembayaran (milik thread 958, cabang `ghostex/60a93dca`) dan `services/ai-*` (milik 964). File bertumpuk: catat di laporan.

Jangan sampai rugi: test bukti pelanggan tidak ditagih dua kali (start bersamaan, retry, mismatch), alat resolve/reconcile tidak bisa mengaktifkan langganan yang belum dibayar di DOIT, dan webhook tenant lain tetap jalan saat satu integrasi rusak. Alat reconcile hanya untuk peran ber-izin (`requirePermission`), filter tenant di SQL.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah; ycb85 dan yqne1 berurutan bila file sama). Lalu test-runner + architect xhigh bersamaan. Gate: lint, typecheck API, test terarah, `db:generate` kosong, prettier.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
