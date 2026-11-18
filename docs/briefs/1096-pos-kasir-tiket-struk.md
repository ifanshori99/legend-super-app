# Brief: engineer — POS kasir: kontrak tiket kasir + struk edge (3 kartu, tingkat K akses)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti. Langkah pertama: spawn subagent paralel dalam satu giliran.

## Worktree
Worktree Ghostex milikmu, base `ghostex/45769078` b8927ea90 (SIAP batch93, memuat 1059 930b61c77 + 1065, belum di m1). Cabang ini mendarat SESUDAH 45769078. Boleh merge `origin/milestone/m1` dulu (konflik hanya `docs/PROGRESS.md`). Langkah 0: `node ~/.claude/scripts/worktree-slim.mjs && heavy pnpm worktree:setup`. Migrasi diharapkan tidak ada; bila perlu, rentang 0712-0713 dengan `--full`. Cabang: `ws/1096-pos-kasir-tiket-struk`.

## Kartu
Di awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`. Baca `bd show` tiap kartu untuk AC.
1. `legend-hpgyw` sisa kontrak kasir untuk menjual tiket (lihat `apps/web/src/features/ws04-pos-kasir/CONTRACT-GAPS.md`, tabel "Panel pembayaran sisa"). Poin, voucher, EDC ditolak, dan jual tiket sudah tersambung. Tiga baca untuk kasir (izin `pos.sale.create`, lingkup outlet, RLS tenant):
   - cari pelanggan: q minimal 3 karakter, maks 10 hasil, keluaran hanya id, nama, 4 digit akhir telepon; tanpa email atau field CRM lain;
   - katalog tiket: hanya produk `single` aktif dengan `menuItemId` di outlet itu;
   - jam kosong: baca ketersediaan untuk staf, dengan memakai ulang service slot apa adanya.
   Ganti hook `useTicketCustomerSearch`/`useTicketProducts`/`useTicketSlots` ke endpoint baru, lalu perbarui CONTRACT-GAPS.md. Layar tidak berubah (tanpa mockup baru).
2. `legend-ain0` + `legend-ol6v` audit AC terhadap m1. Applier `receipt_run.reported` sudah terpasang (zy43, `edge/receipt-run-applier.ts`, `runtime.ts`), Tutup Hari sudah menolak `RECEIPT_SEQUENCE_GAP` (1d9b64441/6b0ld), skip n1fzg/n2d3g ada. Buktikan dengan test end-to-end edge→cloud: (a) penjualan offline lalu void offline tidak deadlock `RECEIPT_VOID_UNMATCHED` (void di-ingest sebelum merge run); (b) replay tidak menambah apa pun; (c) `edge_reported_at` distempel. Kalau lulus: tutup keduanya dengan bukti. Kalau tidak: perbaiki. Hitungan "struk belum sinkron" di rekap hari: buat bead P2 bila belum ada; JANGAN dikerjakan di sini.

## Aturan
- Akses: bila ragu, pilih yang menolak. Test lintas tenant/outlet dan kasir tanpa izin (403) untuk kartu 1. Pelanggan dari tenant lain tidak pernah muncul.
- Uang: tidak ada angka harga yang dihitung di klien; harga tiket dari server.
- Jangan edit `facility-slots.service.ts`, `facility-config.service.ts`, `facility.ts` (diubah `ghostex/993-fasilitas-lanjutan`, batch92). Buat route/service baca baru.
- Teks UI baru: daftarkan ke katalog text-contract.
- Hindari area aktif: refund ws/1072, kas cek-kas-1102, edge ws/1073 (jangan ubah `edge/ports.ts`, `db-link-store.ts`), int/batch90.

## Pembagian paralel
- Explore (2): (a) pola izin kasir + endpoint facility/customer yang ada; (b) peta AC ain0/ol6v vs kode m1.
- test-writer (1): gagal-dulu kartu 1 (`pos-1096-ticket-cashier-*`) dan test bukti kartu 2.
- implementer: API kartu 1, web hooks kartu 1, perbaikan kartu 2 bila perlu (berkas terpisah).
- test-runner: pemegang token heavy (test terarah, typecheck API + web sekali, text-contract).
- architect (effort xhigh, akses): satu review atas diff kartu 1. reviewer sonnet: kartu 2.

## Bukti selesai
Test terarah lulus dan merah-dulu tercatat, typecheck API + web lulus, text-contract lulus bila teks berubah, `db:generate` kosong, architect tanpa P0-P2 terbuka.

## Batas kerja ulang
Ikuti `~/.agents/team/brief-template.md` bagian "Batas kerja ulang". Jangan `pkill`. Jangan akhiri giliran untuk "Menunggu" (founder Q10).

## Sebelum melapor
Pra-gate AGENTS.md. Commit di cabang `ws/1096-pos-kasir-tiket-struk`, push tanpa `--force`.

## Laporan
Hasil per kartu, bukti, berkas, commit, cabang, risiko, urutan merge (SESUDAH 45769078).
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
