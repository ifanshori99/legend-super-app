# Brief: engineer — persetujuan kas keluar ditahan + jurnalnya (2 kartu)

## Peran
Baca `~/.agents/team/roles/engineer.md` dan bagian "Paralel dulu" di `~/.agents/team/TEAM.md` (Grep judul, Read offset/limit), lalu ikuti.

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `milestone/m1`, cabang `ws/cash-out-approval`.

## Kartu
legend-3l4q (flow approve kas keluar ditahan harus memperbarui angka laci sebelum menulis outcome `approved`) dan legend-ym2kr (auto-journal kas keluar `needsApproval`). Baca keduanya + komentar dengan `bd show`. Temuan sebelumnya: emisi `cash_movement.recorded` sudah terjadi (`pos-shift.service.ts:645`); jurnal null bila `needsApproval` (`accounting-auto-journal-amounts.ts:1430`); trigger `app.cash_movement_outcomes_guard` (`pos-shift.custom.sql:236`) menolak `approved`. Di awal: `bd update <id> --status in_progress`. Saat lapor: `--status review` + `bd comment`.

## Aturan
- Uang: test wajib membuktikan kas keluar terhitung tepat sekali di `expected`/`difference` laci, jurnal terbentuk tepat sekali saat approve (idempoten pada replay), ditolak = tidak ada jurnal dan tidak ada efek laci, dan outlet tidak rugi.
- Penyetuju: pakai izin/role yang sudah ada untuk persetujuan kas di kode. Bila belum ada aturan siapa penyetuju, berhenti dan lapor ke CTO dengan pilihan (jangan menebak).
- Migrasi: satu berkas, nomor sementara 0385 (merge train menomori ulang). Shift yang sudah ditutup tidak boleh berubah angkanya.

## Pembagian paralel
Explore (2): alur kas laci + trigger; auto-journal. test-writer gagal-dulu. implementer: migrasi/trigger, service laci + approve, auto-journal (file tidak bertumpuk). Satu pemegang heavy. Review akhir: subagent architect effort xhigh (uang + migrasi).

## Bukti selesai
Test terarah hijau lewat heavy, pra-gate AGENTS.md (termasuk text-contract bila ada teks UI baru), `pnpm db:generate` kosong, typecheck API sekali lewat heavy, push tanpa force, laporan dengan angka subagent.
