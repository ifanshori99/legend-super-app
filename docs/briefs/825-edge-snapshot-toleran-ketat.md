# 825 Snapshot edge toleran tanpa melonggarkan EDG-02 (Codex, engineer kartu S)

## Peran
engineer (baca ~/.agents/team/roles/engineer.md dan bagian "Paralel dulu" di ~/.agents/team/TEAM.md lewat Grep + Read offset/limit).

## Repo
`/Users/ifanshori99/Projects/legend super app/legend`, worktree dari `origin/fix/edge-snapshot-tolerant`, lalu `git merge --no-edit origin/milestone/m1` (konflik: selesaikan dengan menyimpan kedua perilaku; konflik di migrasi: berhenti dan lapor). Push ke cabang yang sama `fix/edge-snapshot-tolerant` tanpa --force.

## Kartu
`legend-pitm6`. CTO memindah status; kamu tidak menjalankan `bd`.

## Masalah
Gerbang merge train 64f merah karena cabang ini membuat parsing cloud ke edge toleran (field asing dibuang), tetapi tiga test menuntut penolakan:
- `apps/api/src/test/device-edge.test.ts` EDG-02: record device dengan field di luar kontrak (mis. token) harus ditolak, kini `applied: 1`.
- `edge-people-snapshot-pull.test.ts` (legend-tkycp): snapshot orang tidak valid harus `BAD_SNAPSHOT`, kini `applied`.
- `edge-uom-compatibility.test.ts` (legend-tkc19, milik cabang ini): skema lama dengan `isSystem` harus ditolak, kini lulus parse.

## Keputusan CTO
Toleran hanya untuk field tambahan yang tidak sensitif dan tidak mengubah arti data. Field terlarang (token, rahasia, kredensial, apa pun yang di luar kontrak device) dan snapshot yang tidak valid tetap ditolak. Ketiga test di atas tidak boleh dilonggarkan; ubah kodenya, bukan assertion-nya. Bila ragu, tolak.

## Scope
- Boleh: parser/schema snapshot edge di `packages/shared` dan `apps/api`/edge yang disentuh cabang ini, test.
- Jangan: migrasi, panik, pembayaran, pemindai, protokol katalog v3.

## Paralel
Subagent bawaan Codex: (a) peta perubahan toleran di cabang ini, (b) satu implementer per kelompok schema (device, people, uom), (c) test-runner.

## Bukti selesai
- `LEGEND_TEST_FILES="src/test/device-edge.test.ts src/test/edge-people-snapshot-pull.test.ts src/test/edge-uom-compatibility.test.ts <test toleran cabang ini>" heavy pnpm test` hijau.
- Pra-gate AGENTS.md: prettier --check, eslint, `heavy pnpm --filter @starter/api typecheck` sekali.
- Lapor hanya saat selesai atau butuh keputusan.

## Laporan
SHA, field mana yang toleran dan mana yang ditolak, test, baris `Subagent: total X, puncak Y bersamaan, token heavy dipegang <siapa>.`
