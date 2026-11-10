# Brief: engineer — Super Admin menunjuk atau mengganti Owner tenant (legend-ktc4d)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/platform-assign-owner` dari `ws/owner-grant-escalation` e2d5df50 (legend-7vsby, sudah antre di merge train). Worktree `.worktrees/platform-assign-owner`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
`legend-ktc4d` (P1, tingkat K auth). Sesudah legend-7vsby, template Owner hanya bisa diberikan oleh Owner tenant aktif, sehingga tenant baru tidak punya jalan untuk mendapat Owner pertama (`platform-admin-provision.service.ts:54/111` hanya membuat admin tenant).
Keputusan founder Q44: Super Admin platform dapat menunjuk atau mengganti Owner tenant kapan saja (tidak hanya saat membuat tenant), lewat Panel Platform dengan MFA dan audit. Sesudah itu Owner tetap bisa menambah Owner lain lewat jalur biasa.
Bangun jalur API platform:
- Tunjuk Owner: beri penugasan template Owner bercakupan tenant ke akun yang ditunjuk (akun yang sudah ada di tenant, atau undang lewat email dengan pola yang sama seperti admin pertama di provisioning).
- Ganti Owner: dalam satu transaksi, tunjuk Owner baru lalu akhiri penugasan Owner lama yang dipilih. Tenant tidak boleh berakhir tanpa Owner aktif lewat aksi ini.
- Hanya peran platform yang setara pembuat tenant (cek izin platform yang dipakai provisioning), dengan MFA/step-up yang sama seperti aksi platform sensitif lain, dan event audit + access event yang mencatat pelaku platform, tenant, akun, dan alasan (wajib diisi).
- Support/impersonate tidak boleh memakai jalur ini.
Pengecualian ini hanya untuk aktor platform; `assertCanGrantRole` untuk aktor tenant tetap seperti legend-7vsby.

## Kartu
`legend-ktc4d`. Di awal: `ghostex board associate legend-ktc4d` dan `bd update legend-ktc4d --status in_progress`. Saat melapor: `bd update legend-ktc4d --status review` dan `bd comment legend-ktc4d "<ringkasan>"`. UI Panel Platform tidak termasuk: buat kartu terpisah `bd create "UI Panel Platform: tunjuk/ganti Owner tenant" -t feature -p 2 -l platform,ui` dan sebut di laporan (UI butuh mockup dulu).

## Scope
Boleh: service/route platform (provisioning dan akses), kontrak shared (validator, DTO, kode error, katalog i18n), `packages/shared/src/access/grants.ts` hanya bila perlu jalur aktor platform yang eksplisit, test. Jangan: UI, refund, write-off service, PIN edge, pajak, support/impersonate selain menolak jalur ini, migrasi (bila ternyata perlu, minta nomor ke CTO dulu).

## Bukti selesai
- Test: Super Admin menunjuk Owner pertama di tenant tanpa Owner, lalu Owner itu bisa memberi Owner ke akun lain; ganti Owner mengakhiri Owner lama dan tenant tetap punya Owner; aktor tenant (admin tenant, custom role), support/impersonate, dan platform tanpa izin/MFA ditolak 403; alasan kosong ditolak 422; event audit tercatat.
- Test akses lama (access-owner-grant, access-hardening, access-audit, platform-access-api, platform provisioning) tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` dengan path `src/test/...` (bukan `apps/api/...`), sebut jumlah file.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Tulis brief Codex `docs/briefs/224b-second-opinion-platform-assign-owner.md` di folder utama (tidak di-commit): rentang diff, berkas berisiko, invariant. Jangan sertakan temuan Claude.

## Laporan
Sekali: hasil, bukti (perintah dan hasil), file berubah, SHA, kartu UI baru, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep; tunggu notifikasi job sendiri. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
