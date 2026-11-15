# 867 EDC agent: heartbeat kunci, hitungan panggilan hidup, pemasangan produksi (engineer Sonnet, uang)

Cabang fix/edc-agent-867 dari milestone/m1 (46f9d1bca, sudah memuat 829 + 861). Langkah 0: `git log --all --oneline --grep=<id>` per kartu.
- legend-agran: heartbeat kunci outlet (SELECT 1 + timeout di sweep timer; gagal -> handler lock-lost yang ada, fail-stop bila ada panggilan hidup).
- legend-h4c2f: hanya panggilan yang masih menunggu adapter dihitung "hidup"; tulis DB setelah terminal menjawab tidak memicu exit (bukti approval tidak hilang).
- legend-kwy6d: pasang createEdcAgent di proses produksi (worker) dengan restart oleh supervisor setelah process.exit(1) dari onFatal; dokumentasikan di docs/deployment.md.
Jangan sampai rugi: test bahwa tidak ada sale kedua, marker tidak dibersihkan proses lain sebelum jendela, dan bukti approval tersimpan. Tanpa migrasi (bila perlu: lapor dulu).
Paralel: test-writer, satu implementer per kartu (file terpisah; agran dan h4c2f sama-sama di agent.ts -> berurutan). Review: satu subagent architect effort xhigh (uang).
Pra-gate AGENTS.md. Commit + push tanpa force. Klaim kartu bd, jangan close. Lapor sha, test, review, angka subagent.
