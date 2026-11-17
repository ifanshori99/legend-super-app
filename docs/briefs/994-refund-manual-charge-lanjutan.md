# 994 Refund manual charge lanjutan 985 + tampilan void/collect 982

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/ghostex/985-charge-refund-manual-void` (cda5730e0; di atas 982 2ba47d846; belum di m1, antre batch86). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru bila perlu 0600-0604 (nomor kerja).

Kartu (`bd show <id>`; claim dulu):
- legend-ng3tf (P3): approve refund manual EDC tanpa kunci hari bisnis.
- legend-ayobh (P4): reject refund manual charge salah tolak karena scope outlet HANDLE vs APPROVE.
- legend-7e8kx (P2): POS menampilkan alasan QRIS di-void karena `edc_request_open`.
- legend-khvqb (P2): field payment di `charge-endpoints.ts` dan mock collect-at-pos.

Jangan sentuh: legend-1c5xg (ditahan), refund/recon provider (980), payout (990), supplier/kas (991), akses perangkat (984), payroll, fasilitas.

Jangan sampai rugi: test bukti (1) refund manual + intent + void tidak pernah melebihi nilai charge, termasuk bersamaan, (2) approve refund EDC terkunci hari bisnis/periode yang benar, (3) reject tidak salah tolak tapi juga tidak membuka izin lebih luas, (4) jurnal seimbang, (5) tenant/outlet lain tidak tersentuh. Bila ragu: blok pembayaran.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu. Lalu test-runner + architect xhigh + ui-auditor (7e8kx) bersamaan. Gate (#9): prettier, eslint, typecheck API dan web, test terarah order-issue/refund/pos, text-contract bila teks UI baru, `db:generate` kosong. Satu token heavy per thread. Jangan `pnpm check`/`pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal; JANGAN akhiri giliran untuk kabar antara.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
