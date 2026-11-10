# Brief: engineer — perbaikan pajak P2 dari Codex 219 (legend-5yeyq, legend-7gwap, legend-usa4b)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai, item 9), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/tax-p2-fixes` dari `milestone/m1` 94d769c6. Worktree `.worktrees/tax-p2-fixes`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge.

## Tujuan
Tiga temuan Codex second-opinion (tingkat K pajak/uang, gerbang rilis). Ketiganya di berkas berbeda, jadi kerjakan paralel lewat subagent `implementer` (satu per kartu). Detail, probe, dan saran ada di berkas hasil Codex; baca dulu:
- `docs/briefs/170b-second-opinion-pph21-receivable.result.md` — `legend-5yeyq`: `packages/shared/src/hris/payroll/pph21.ts:552-559` membatasi cap caller dengan penghasilan kena pajak, sehingga kas non-pajak tidak bisa dipakai membayar PPh 21 dan muncul piutang palsu (contoh: kas non-pajak Rp1 juta, piutang Rp325 ribu). Cap harus mengikuti definisi brief/B8: seluruh tunai tanpa tunjangan PPh, dikurangi semua BPJS karyawan dan potongan pra-net non-pinjaman.
- `docs/briefs/177b-second-opinion-tax-rule-overlap.result.md` — `legend-7gwap`: `packages/shared/src/tax/overlap.ts:103` (juga 111, konstanta 33) memakai UUID tetap `NO_ITEM` sebagai probe; bila UUID itu ada di `appliesTo.itemIds`, konflik item biasa tidak terlihat, publish lolos, lalu preview gagal `TAX_RULE_AMBIGUOUS`. Probe harus tidak bisa ditabrak input (`tax.service.ts:530` menyimpan `appliesTo` tanpa validasi katalog).
- `docs/briefs/173b-second-opinion-provisioning-race.result.md` — `legend-usa4b`: `apps/api/src/edge/master-sync.ts:183` import edge menulis CoA (264) dan mapping (291/306) tanpa `lockChartOfAccounts`; backfill (`accounting-provisioning.service.ts:162-197`) memegang lock CoA sendiri, jadi akun cloud tercampur 63 akun template. Import edge harus mengambil lock CoA yang sama, dengan urutan lock yang konsisten (tidak boleh deadlock dengan lock `edge-master-sync`).

## Kartu
`legend-5yeyq`, `legend-7gwap`, `legend-usa4b`. Di awal: `ghostex board associate <id>` dan `bd update <id> --status in_progress` per kartu. Saat melapor: `bd update <id> --status review` dan `bd comment <id> "<ringkasan bahasa biasa>"`.

## Scope
Boleh: berkas di atas, `packages/shared/src/hris/payroll/payslip-tax.ts`, `apps/api/src/services/accounting-provisioning.service.ts`, `tax.service.ts` bila perlu, test. Jangan: refund, write-off, grant/role, PIN edge (cabang lain), edge link instance, UI, migrasi (tidak perlu; bila ternyata perlu, tanya CTO dulu).

## Bukti selesai
- Test reproduksi gagal dulu di basis untuk tiap kartu (probe Codex di berkas hasil bisa dipakai), lalu lulus sesudah perbaikan. Race CoA: dua transaksi berselang (barrier/dua koneksi) tidak lagi mencampur akun.
- Test payroll/PPh 21, pajak, dan provisioning lama tetap lulus. `LEGEND_TEST_FILES` daftar eksplisit lewat `bash -c 'cd <worktree> && pwd && ...'` + nullglob, sebut jumlah file. Test shared/root hanya lewat `pnpm test`.
- tsc lewat `heavy` (satu kali per perbaikan), eslint, prettier untuk berkas berubah. Jangan jalankan `pnpm check` penuh.
- Review K: subagent reviewer Opus + architect paralel; temuan nyata dibetulkan.
- Tulis brief Codex `docs/briefs/222b-second-opinion-tax-p2-fixes.md` di folder utama (tidak di-commit): rentang diff, berkas berisiko, invariant. Jangan sertakan temuan Claude.

## Laporan
Sekali: hasil per kartu, bukti (perintah dan hasil), file berubah, SHA, risiko tersisa, jumlah subagent dan puncak bersamaan. Jangan menunggu proses global atau loop sleep; tunggu notifikasi job sendiri. Bila sesimu sudah compact 2 kali, jangan mulai: lapor saja.
