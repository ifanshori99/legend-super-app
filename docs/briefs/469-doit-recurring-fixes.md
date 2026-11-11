# Brief: perbaikan review architect (putaran 3) + Codex second-opinion — tagihan berulang DOIT (legend-6c6)

Peran: engineer (`~/.agents/team/roles/engineer.md`). Cabang `ws/6c6-recurring-billing` (512fe748); buat worktree `.worktrees/6c6` lagi. Keputusan CTO: semua nyata, uang -> architect xhigh setelah perbaikan. Migrasi bila wajib: nomor sementara 0290. Termasuk legend-9wqgx (pause row lock).

## Architect putaran 3 (file di apps/api/src/services/)
1. P1 `payment-recurring.service.ts:90-92` (start :342-346, resume :472-476): `loadIntegrationCredentialsById` abaikan status. Integrasi nonaktif -> DOIT menagih, secret webhook tidak dimuat -> semua event 401 -> tamu bayar, akses tidak buka. Fix: flag tujuan di `defaultClientFor`; start/resume -> SERVICE_UNAVAILABLE kecuali `status === "active"`. Test tanpa stub `clientFor`.
2. P2 :91: pause/cancel diblok `assertProviderAvailable` saat DOIT ditarik dari tenant -> tenant tak bisa hentikan tagihan. Fix: `{ forStoredIntent: true }` hanya untuk pause dan cancel.
3. P2 `payment-webhook.service.ts:1571-1579`: fallback integrasi nonaktif hanya cari payment intent, bukan langganan -> perpanjangan 401 terus, tamu bayar tanpa akses. Fix: resolve secret lewat `data.invoice.subscription_id` -> integrasi langganan. Test.
4. P3 :534-543: pause menimpa cancel (update kedua tanpa syarat status). Fix: `status <> 'cancelled'` di WHERE + row lock (legend-9wqgx). Test balapan.
5. P3 :632-634: `integrationAccepts` buka koneksi kedua di bawah FOR UPDATE (pool 10, timeout 5 dtk). Fix: cek signer sebelum lock, atau query di `tx`.
6. P3 :847-861: insert invoice paid yang belum pernah terlihat tanpa `paid_at`. Fix: isi `paidAt` bila payload paid.

## Codex second-opinion (G4j75) — tumpang tindih dengan architect: butir 1-6 di atas sudah mencakup pause timpa cancel, fallback webhook, pause/cancel diblok, paid tanpa paidAt
7. P1 `payment-webhook.service.ts:1796`: worker pakai secret terkini integrasi, bukan yang memverifikasi event (rotasi/grace). Keputusan: simpan binding verifikasi (integration_id + versi secret) saat event diterima; worker memakai binding itu, tidak memverifikasi ulang dengan secret baru.
8. P1 `payment-recurring.service.ts:341`: UUID `reference` baru tiap retry dengan idempotency key sama -> langganan ada di DOIT tanpa catatan lokal. Keputusan: simpan intent + reference stabil SEBELUM panggilan DOIT; retry pakai reference yang sama; respons hilang/409 -> status `needs_reconcile`.
9. P1 `payment-webhook.service.ts:1335`: event langganan belum dikenal jadi `ignored` setelah 15 menit. Keputusan: jangan ignored; simpan di antrean rekonsiliasi yang bisa dipulihkan (diproses ulang saat langganan lokal muncul). Test: event datang, langganan lokal tercatat 20 menit kemudian -> diproses.
10. P1 `payment-recurring.service.ts:484`: respons pause/resume/cancel dibuang. Keputusan: validasi id + status hasil; tidak cocok/ambigu -> `needs_reconcile`, jangan nyatakan sukses.
11. P2 :967: pembayaran periode mendatang langsung ganti periode berjalan / active sebelum period_start. Keputusan: simpan periode berikutnya terpisah, pindah saat period_start; cek akses periksa kedua batas.
12. P2 :835: `invoice.paid` dengan payload status `open` -> tolak/abaikan, jangan buat needs_review.
Di luar putaran ini: legend-rsrcb (past_due tenggang 3 hari) kartu terpisah; `invoice.failed` tunggu kontrak sandbox (legend-saov).

Paralel: test-writer gagal-dulu per butir, implementer per file (recurring.service, webhook.service), lalu architect xhigh. Bukti: test gagal-dulu, test terarah 6 berkas + baru hijau, eslint+prettier file berubah, typecheck api heap 6144, commit+push. Laporan: commit, angka test, angka subagent (total, puncak, pemegang heavy).
