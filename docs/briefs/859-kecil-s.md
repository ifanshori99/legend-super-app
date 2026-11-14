# 859 Kartu kecil tingkat S (engineer Codex)

Cabang fix/kecil-859 dari milestone/m1. Langkah 0: `git log --all --oneline --grep=<id>`; sudah ada: catat, lewati.
Detail kartu: `.beads/issues.jsonl`.

- legend-esnvi: fixture leave.rededucted_after_settlement di packages/shared/src/hris/fixtures.ts supaya tes PII payload mencakupnya.
- legend-5v8sm: API daftar delivery: parameter filter 'perlu tindakan' di server; klien memakainya.
- legend-s3ex8: dana tak teralokasi: needs_review tidak boleh menimpa resolved.
- legend-nb2mk: indeks push_subscriptions(user_id). Migrasi rentang 0448.

Test gagal-dulu per kartu. Teks UI baru: daftarkan di katalog (tests/text-contract.test.mjs).
Pra-gate AGENTS.md (typecheck api dan web lewat `heavy`). Commit + push tanpa force. Lapor sha, test, kartu mana selesai.
