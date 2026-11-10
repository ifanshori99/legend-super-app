# Brief: engineer — config codec kind (5cwrq) + sisa timestamp PIN (hbaml)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" serta "Kerja berat" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Dua worktree terpisah:
- `ws/5cwrq-config-codec-kind` dari `origin/ws/tenant-config-followups` (997d4a47) bila kartu menyebut basis lain ikuti kartu; `.worktrees/5cwrq`.
- `ws/hbaml-pin-timestamps` dari `origin/fix/codex-418-pin` (98966d1b); `.worktrees/hbaml`.

## Kartu
`legend-5cwrq`, `legend-hbaml`. Awal: `ghostex board associate <id>` + `bd update <id> --status in_progress`. Lapor: `--status review` + `bd comment`.

## Tujuan
- 5cwrq: lihat `bd show legend-5cwrq`. Diskriminator `kind` dari tenant-config-export (`packages/shared/src/platform/config.ts` configSectionItemSchemas) jadi bentuk tunggal; `config-codecs.ts` ikut bentuk itu untuk roles, approval_policies, chart_of_accounts; hapus jembatan `hasKind` di configBundleSchema. Tidak boleh mengubah data tenant yang sudah diekspor tanpa jalur baca kompatibel (aturan "jangan sampai rugi": impor lama tidak boleh gagal diam-diam).
- hbaml: `payslip-pin.service.ts` `resetEmployeePayslipPin` (~522) ambil `now` setelah lock; `viewedAt` di `viewMyPayslip` dibaca setelah lock PIN. `requestPayslipPinResetOtp` JANGAN diubah (akan dihapus kartu legend-9h2oj).

## Pembagian paralel (giliran pertama, satu giliran)
- 2 `Explore` (satu per kartu) + 2 `test-writer` (test gagal-dulu per kartu, vitest backend termasuk lingkup test-writer).
- Lalu 1 `implementer` per kartu. Satu token heavy per thread: hanya satu subagent menjalankan test/typecheck pada satu waktu.
- Review: 5cwrq `reviewer` sonnet; hbaml `reviewer` sonnet.

## Scope
Hanya file kartu ini + test. Tanpa migrasi.

## Bukti selesai
`LEGEND_TEST_FILES="<src/test/...>" heavy pnpm test` lulus per kartu; `heavy pnpm --filter @starter/api typecheck` 0 (dan `@starter/shared` bila disentuh); gagal-dulu tercatat.

## Batas kerja ulang
typecheck gagal 2x: baca log heavy-fail lengkap, betulkan semua sekaligus; gagal ke-3 lapor. Jangan pkill. Jam dari `date '+%H:%M'`.

## Sebelum melapor
Commit + push tiap cabang. Hapus worktree yang bersih.

## Laporan
Per kartu: hasil, bukti, sha, temuan review. Subagent: total, puncak bersamaan, siapa memegang token heavy.
