# Brief: second-opinion Codex — area tagihan berulang DOIT (legend-6c6)

Baca `~/.agents/team/roles/second-opinion.md` lalu ikuti. Read-only. Effort xhigh (uang).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Basis `origin/milestone/m1` (3c7217b2).

## Cabang
- `origin/ws/6c6-recurring-billing` 512fe748 (fitur c607a7f9, migrasi 0285 sementara). Architect xhigh 2 putaran, temuan putaran 2 #1-#3, #5-#9 dibetulkan; #4 (kontinuitas periode ketat) sengaja tidak diubah.

## Aturan founder
Jangan sampai rugi: tidak ada pihak dibayar lebih, outlet tidak rugi, akses tidak terbuka tanpa bayar. Kontrak DOIT recurring = asumsi (isolasi di `payment-doit-recurring-wire.ts`), belum diuji sandbox (legend-saov).

## Fokus
Webhook invoice (created/paid/failed) palsu, ganda, terlambat, urutan acak; aktivasi tanpa bayar; bayar di invoice needs_review; pause/resume/cancel balapan dengan pembayaran (pause tanpa row lock); kredensial integrasi salah langganan / lintas tenant; batas periode (period_end eksklusif); idempotensi dan retry; tagihan ganda; RLS. Sudah diketahui, cukup konfirmasi: belum ada transisi ke past_due setelah masa tenggang 3 hari (PRD baris 861); koneksi kedua di dalam transaksi.

## Laporan
Temuan P0..P3: file:baris, skenario (input -> hasil salah), saran. Sebut yang bersih. Angka subagent.
