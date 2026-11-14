# 797 Perbaikan second opinion DOIT refund (3 P2, uang)
Peran: engineer (baca ~/.agents/team/roles/engineer.md). Basis: worktree dari `origin/ws/doit-refund-hardening` (ed32fc48e); commit ke cabang itu dan push.
Temuan dan keputusan CTO sudah tetap: baca `docs/qa/second-opinion-doit-refund.md` (di repo utama /Users/ifanshori99/Projects/legend super app/legend).
1. `deploy/single-vm/check-refund-flag.sh:26` override path shell (`API_ENV_FILE`/`WORKER_ENV_FILE`): checker harus membaca file yang sama dengan yang dipakai Compose. Bandingkan nilai efektif; jangan cetak isi env atau rahasia.
2. `check-refund-flag.sh:34` deklarasi bare setelah deklarasi bernilai: tolak (fail-closed) atau samakan dengan semantik Compose. Pilih fail-closed bila ragu.
3. `payment-webhook.service.ts:358-365` dan `payment-doit.ts:133,:717`: refund dan payment yang sudah tersimpan memakai loader dengan `{ forStoredIntent: true }`, supaya hasil refund tetap tercatat setelah DOIT dicabut dari paket. Binding tenant, provider, integrasi, dan HMAC tetap. Pembayaran baru tetap diblok saat paket dicabut.
Uang: test gagal-dulu per temuan sesuai "Usul test" di laporan: refund selesai tepat sekali, replay tidak menambah, signature salah atau lintas tenant tetap ditolak, flag efektif beda menghentikan deploy sebelum `compose up`.
Paralel: test-writer, satu implementer untuk skrip deploy, satu untuk webhook dan poll (file terpisah).
Selesai: test terarah lewat `heavy`, `deploy/single-vm/test-deploy.sh`, prettier, eslint, typecheck API, satu subagent architect effort xhigh atas diff, commit, push, komentar SHA di legend-gqv7 dan legend-3gna. Laporan: SHA, test, hasil architect, angka subagent (total, puncak, pemegang token heavy). Jangan merge ke m1.
