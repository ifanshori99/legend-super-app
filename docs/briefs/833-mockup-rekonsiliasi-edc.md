# Brief: designer Codex — mockup layar rekonsiliasi EDC

## Peran
Baca `~/.agents/team/roles/designer.md` dan `~/.agents/team/ui-standard.md`, lalu ikuti. Jangan menjalankan `bd`.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend` (hanya `design/mockups/payments/edc-reconciliation/`, tanpa kode aplikasi).

## Tujuan
Mockup layar back office untuk Owner/Finance Manager menyelesaikan transaksi EDC yang ditandai (kartu legend-khi8n): daftar permintaan ditandai (outlet, kasir, nominal, jam, status unknown/approved/declined, umur), detail dengan bukti (struk/trace), tombol selesaikan approved/declined dengan konfirmasi + MFA, keadaan kosong, gagal, dan "masih menunggu respons terminal" (fail-closed, tidak bisa diselesaikan dulu). Route API: `POST /edc/transactions/:id/reconciliation` (cabang fix/edc-followups). Bahasa Indonesia, gaya back office yang sudah ada (lihat `design/screens/` dan mockup BO lain).

## Bukti selesai
- HTML mockup desktop + 390px; `ghostex visual check <file> --out <png>` dan `--width 390` tanpa error, PNG disimpan di folder yang sama.
- Commit lokal di cabang `design/edc-reconciliation` dari `origin/milestone/m1`, push tanpa force. Laporan: path file + PNG.
