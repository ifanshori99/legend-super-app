# Brief: engineer (Opus) — WS-10 onboarding/offboarding, exit clearance, KPI

## Peran
Baca `~/.agents/team/roles/engineer.md` dan `~/.agents/team/TEAM.md` (bagian "Paralel dulu", kerja berat, definisi selesai), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`. Cabang baru `ws/hr-lifecycle-kpi` dari `ws/hr-scheduling` (88cc626e; jadwal karyawan belum masuk m1, dan berkas hris bersama seperti `routes/index.ts` dan `packages/shared/src/hris/endpoints.ts` sudah berubah di sana). Worktree `.worktrees/hr-lifecycle-kpi`, `worktree:setup`. Jangan checkout di folder utama. Jangan push, jangan merge. Disk Mac sempit: jangan buat worktree tambahan.

Nomor migrasi dipesan: `0206`, `when` 1794285000000, satu migrasi. `prevId` = snapshot 0199 di cabang dasar; merge train merangkai ulang.

## Tujuan
`legend-ovxw` (P2, tingkat K: pencabutan akses dan uang). PRD v1.7 §3 F26 Onboarding/Offboarding, §3 F32 KPI. Audit 9 Nov: belum ada apa pun di m1. Catatan kartu: UI `legend-u3x3` butuh endpoint aksi tugas checklist (complete/block/unblock/waive), render surat keterangan kerja, dan ringkasan penyelesaian akhir; UI sekarang memakai pratinjau lokal (`apps/web/src/features/ws10-*`).

Potongan:
1. Checklist onboarding dan offboarding: template per tenant, instance per karyawan, aksi tugas complete/block/unblock/waive dengan audit.
2. Exit clearance: offboarding mencabut sesi, perangkat, dan PIN karyawan, serta menutup shift terjadwal sesudah tanggal keluar. Pakai service akses, sesi, dan perangkat yang ada; jangan tulis ulang.
3. KPI: metrik dari sistem (sumber metrik yang ada, `metrics_daily`) dan siklus review manajer.
4. Ringkasan penyelesaian akhir: hanya ringkasan dari data yang sudah ada (gaji berjalan, kasbon, cuti). Mesin payroll lengkap (`legend-j2l2`) belum ada: jangan bangun hitungan BPJS atau THR. Buat kartu untuk bagian yang menunggu `legend-j2l2`.
5. Surat keterangan kerja: data render saja, tanpa PDF bila belum ada pola PDF di repo.

Mulai dengan `Explore` untuk memetakan hris, sesi/perangkat/PIN, dan sumber metrik. Desain skema dan urutan pencabutan lewat satu subagent `architect`, catat di `docs/DECISIONS.md`. Sesudah skema masuk, potongan 1, 3, 5 lewat `implementer` paralel di berkas terpisah; potongan 2 dan 4 kamu pegang sendiri.

## Kartu
Awal: `ghostex board associate legend-ovxw`, `bd update legend-ovxw --status in_progress`. Selesai: `--status review` + `bd comment` bahasa biasa.

## Scope
Boleh: schema/service/route hris lifecycle dan KPI, migrasi 0206, `packages/shared/src/hris/*`, test. Jangan: UI web, mesin payroll, absensi (`legend-wh71`), berkas jadwal karyawan kecuali memanggil service-nya.

## Bukti selesai
- `pnpm db:generate` lalu periksa SQL; generate kedua kosong. Test migrasi RLS (`migration-force-rls-guard`, `migration-fk-force-rls`).
- Test gagal-dulu: isolasi tenant dan outlet; offboarding mencabut sesi, perangkat, dan PIN sekali walau dipanggil dua kali; karyawan yang keluar tidak bisa login atau memakai PIN; tugas checklist hanya bisa diubah peran berizin; waive butuh alasan dan tercatat; metrik KPI dari sistem cocok dengan sumbernya.
- `bash -c 'cd <worktree> && pwd && LEGEND_TEST_FILES="src/test/..." pnpm test'`, sebut jumlah file dan tes. Contract root bila `packages/shared` berubah.
- Typecheck api dan shared lewat `heavy` sekali; eslint + prettier berkas berubah. Jangan `pnpm check` penuh atau `pnpm test` penuh.
- Review (tingkat K): satu subagent `architect`.
- Tulis brief Codex `docs/briefs/299b-second-opinion-hr-lifecycle.md`, jangan dijalankan.

## Laporan
Sekali di akhir: keputusan desain, SHA, migrasi (`when`, prevId), bukti, file berubah, kontrak untuk UI, kartu baru, risiko, jumlah subagent dan puncak bersamaan.
