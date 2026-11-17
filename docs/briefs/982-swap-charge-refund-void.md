# 982 Charge tukar menu: refund, void, tagih di POS non-tunai

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1`. Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0550-0554 (nomor kerja) bila perlu.

Kartu (`bd show <id>`; claim dulu):
- legend-nsvu0: `order_issue_charges` berstatus `paid` belum bisa direfund. Jalur refund memakai `recoveryRefundSplit` + jurnal balik; tidak boleh melebihi nilai charge yang dibayar, refund berulang dijumlah.
- legend-s61sg: order di-void setelah `order_issue.charge_paid` membuat jurnal `aj:order-charge:<id>` parkir sebagai SALE_MISSING. Aturan: void order yang punya charge paid wajib memicu refund charge (jalur nsvu0) atau jurnal balik dalam satu transaksi; tanpa itu void ditolak 409 (blok, jangan lepaskan uang).
- legend-gt98h: lanjutan legend-800h1; endpoint collect-at-pos baru tunai saja. Tambah EDC dan QRIS memakai jalur pembayaran POS yang sudah ada (status pending sampai lunas, idempoten).
Cari kode: grep `order_issue_charge`, `charge_paid`, `collect-at-pos`, `recoveryRefundSplit`.

Jangan sentuh: refund parsial provider/recon (thread 980, cabang `ghostex/980-refund-sisa-4-kartu`), ulasan/MCP (981), payroll. File bertumpuk dengan 980: catat di laporan.

Jangan sampai rugi: test bukti (1) total refund charge tidak pernah melebihi nilai charge paid, termasuk refund berulang dan bersamaan, (2) void + refund tidak menghasilkan pengembalian ganda, (3) jurnal seimbang dan tidak ada SALE_MISSING setelah void, (4) collect-at-pos EDC/QRIS gagal/timeout tidak menandai charge paid, retry tidak menagih dua kali, (5) tenant/outlet lain tidak tersentuh (filter tenant di SQL). Bila ragu: blok pembayaran.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (s61sg setelah nsvu0 bila file sama). Lalu test-runner + architect xhigh bersamaan. Gate (#9): lint, typecheck API, test terarah grup order-issue/refund/pos-payment, `db:generate` kosong, prettier. Satu token heavy per thread.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir; jangan akhiri giliran untuk kabar antara.
