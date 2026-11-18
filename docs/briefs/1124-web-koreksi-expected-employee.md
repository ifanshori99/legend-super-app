# 1124 Web: kirim expectedEmployeeId di koreksi absensi (legend-vxuuc, tingkat S)
Peran: engineer kartu S (`~/.agents/team/roles/engineer.md`). Codex. Langkah pertama: spawn subagent paralel (Explore web hrd/attendance correction, test-writer, implementer).
Base `origin/milestone/m1` (prasyarat 408336d1c dan e27706496 sudah di m1). Cabang `ws/1124-web-koreksi-expected-employee`. Push tanpa `--force`. Tanpa migrasi, tanpa ubah API.
Isi: server menolak 409 `ATTENDANCE_CORRECTION_IDENTITY_MISMATCH` bila identitas beda, tetapi web belum mengirim field `expectedEmployeeId`. Di fitur koreksi absensi web: `hooks.ts` flush antrean kirim `{...row.body, expectedEmployeeId: row.employeeId}`; dialog submit juga mengirim `expectedEmployeeId`; `mock.ts` simulasi 409. Tampilkan pesan 409 yang jelas (teks lewat katalog i18n, `node --test tests/text-contract.test.mjs` hijau). Baris antrean yang kena 409 tidak diulang terus.
Bukti: test web terarah merah-dulu lalu hijau (payload memuat field; 409 ditangani). Typecheck web sekali lewat heavy. Prettier/eslint.
Laporan: commit, head SHA. `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.` Lapor sekali.
