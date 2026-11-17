# 990 Payout lanjutan: recon flag, jurnal fee, bukti return

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Opus 5.5 high (desain baru di uang). Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1b0fd2a9e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0580-0584 (nomor kerja; renumber oleh merge train).

Konteks: payout 905/911/954 sudah di m1 (lihat docs/merge-queue.md dan laporan 905/911 di docs/PROGRESS.md).

Kartu (`bd show <id>`; claim dulu):
- legend-xbagc: aksi dua orang untuk menutup flag recon payout palsu (pembuat tidak boleh menyetujui sendiri).
- legend-d9pxr: cek jurnal fee overpaid saat COMMIT.
- legend-y2lk2: recon mencakup penutupan bukti (closure).
- legend-r8nas: recon mencakup attestation resolve/bank_confirm.
- legend-nsqhm: bukti return payout wajib nomor referensi transaksi bank.
- Opsional bila file terpisah: legend-wrz3v (UI: posting bank yang menunggu mapping biaya). Lewati bila melebar.

Jangan sentuh: refund/recon provider (980, 967), charge tukar menu (982/985), DOIT (965), payroll (983/dd932307), akses perangkat (984), fasilitas (987), approval kas keluar supplier (brief 991 paralel).

Jangan sampai rugi: test bukti (1) flag recon tidak bisa ditutup satu orang, (2) fee/jurnal seimbang dan tidak ada payout dobel atau lebih bayar, termasuk bersamaan, (3) return tanpa referensi bank ditolak, (4) tenant/outlet lain tidak tersentuh. Bila ragu: blok pembayaran dan catat keputusan untuk CTO.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh bersamaan. Gate (#9): prettier, eslint, typecheck API (web bila tersentuh), test terarah payout/recon, `db:generate` kosong. Satu token heavy per thread. Jangan jalankan `pnpm check` atau `pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
