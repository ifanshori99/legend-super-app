# Brief: engineer — penguatan pembayaran (3 kartu)

Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" + kerja berat di `~/.agents/team/TEAM.md` (Grep + Read sempit), lalu ikuti. Tingkat K (uang + migrasi) untuk srf6 dan gjf1; S untuk j75w.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran.

## Repo
Worktree baru dari `milestone/m1`. Push ke `origin` sebagai `ws/payment-hardening`.

## Kartu (baca `bd show <id>`; cek `git log --all --oneline --grep <id>` agar tidak dobel)
1. `legend-srf6`: indeks dedupe webhook DOIT harus memasukkan `integration_id` (sekarang pengirim pertama memiliki eventId). Ikuti keputusan CTO di kartu. Butuh migrasi.
2. `legend-gjf1`: saat pesanan belum lunas di-void, intent QR parsial yang sudah settle harus direfund: panggil `requestQrLatePaymentRefund` per intent terbayar (`apps/api/src/services/qr-order.service.ts` sekitar baris 1964). Refund tepat sekali, idempoten.
3. `legend-j75w`: alert berpembatas (throttled) untuk kegagalan auth Brevo berulang (`apps/api/src/worker/notification-adapters.ts`).

Jangan sentuh alur QRIS hold/DP (cabang lain) dan settlement recon.

## Migrasi
Rentang `0482-0483` saja. `db:generate` kosong setelahnya.

## Aturan uang (founder)
Test gagal-dulu: dua integrasi dengan eventId sama tidak saling memblok dan replay tetap ditolak; void pesanan dengan 2 intent QR terbayar -> 2 refund tepat sekali, ulang void tidak refund dobel; tidak ada pihak dibayar lebih, outlet tidak rugi.

## Pembagian paralel
test-writer, implementer 3 (per kartu), `architect` effort xhigh atas diff srf6+gjf1, satu `test-runner` (run_in_background + Monitor, tanpa loop sleep). Typecheck sekali di akhir.

## Batas
Jangan `pkill`; jangan merge ke m1; jangan deploy; jangan panggil DOIT/Brevo sungguhan. Jam dari `date '+%H:%M'`.

## Laporan
Wajib: `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
