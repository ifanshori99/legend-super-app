# 991 Akuntansi dan kas: bayar supplier ber-approval, kas kecil vs GL

Peran: engineer (baca ~/.agents/team/roles/engineer.md). Sonnet 5.5 high. Review: architect effort xhigh (uang).
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.
Cabang: worktree-mu dari `origin/milestone/m1` (1b0fd2a9e). Langkah pertama `heavy pnpm worktree:setup`. Commit dan push tanpa force. Tidak merge, tidak deploy. Migrasi baru 0585-0589 (nomor kerja; renumber oleh merge train).

Kartu (`bd show <id>`; claim dulu; cek dependensi bd tiap kartu):
- legend-xxqz3: WS-06 BE pembayaran supplier dengan approval (kerjakan dulu; 4qowr memakai pola approval yang sama).
- legend-a4z2f: WS-07 rekonsiliasi saldo kas kecil vs GL 1102.
- legend-4qowr: inbox persetujuan umum untuk kas keluar di atas batas.
- legend-efdx6: peringatan UI journalize penerimaan (risiko persediaan dobel).
- legend-eestb: cek retur lama sebelum flag posting faktur nyala.

Jangan sentuh: payout/recon payout (brief 990 paralel), refund (980/967), charge (982/985), DOIT, payroll, akses perangkat (984), fasilitas (987).

Jangan sampai rugi: test bukti (1) pembayaran supplier tidak bisa melebihi tagihan atau dibayar dua kali, termasuk bersamaan, (2) di atas batas wajib disetujui orang lain, (3) jurnal seimbang dan persediaan tidak terhitung dobel, (4) tenant/outlet lain tidak tersentuh. Bila ragu: blok pembayaran dan catat keputusan untuk CTO.

Paralel: Explore per kartu + test-writer (gagal-dulu) dalam satu giliran; satu implementer per kartu (file terpisah). Lalu test-runner + architect xhigh + ui-auditor (efdx6) bersamaan. Gate (#9): prettier, eslint, typecheck API dan web, test terarah, teks UI baru lewat text-contract, `db:generate` kosong. Satu token heavy per thread. Jangan jalankan `pnpm check` atau `pnpm test` penuh. Tunggu job latar dengan satu Monitor yang hanya memicu saat selesai/gagal.

Laporan: SHA, kartu, migrasi, test, temuan architect, angka subagent (total, puncak, pemegang heavy). Komentari tiap kartu, jangan tutup. Lapor sekali di akhir.
