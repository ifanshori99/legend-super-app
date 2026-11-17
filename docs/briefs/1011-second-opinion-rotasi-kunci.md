# 1011 Second opinion rotasi kunci reseal (ChatGPT + push) — legend-e1mtr

Peran: second-opinion (baca ~/.agents/team/roles/second-opinion.md). Codex xhigh. Read-only, tanpa worktree (disk sempit): pakai `git diff`/`git show <ref>:<path>` dari folder utama, jangan checkout.
Langkah pertama: pecah tugas dan spawn subagent paralel dalam satu giliran (maks 3: job reseal, ChatGPT CAS/lease, runbook + test).

Diff: `git diff 892f58a11...origin/ghostex/1002-reseal-chatgpt-push -- . ':!**/meta/*snapshot.json'` (tip 9b1010918). Desain acuan: `git show 9b1010918:docs/design/reseal-chatgpt-push.md` (Opsi B, aturan pensiun bagian 4.4, test bagian 7).
Diterima CTO (jangan dilaporkan): sweep yang error menambah failed += 1 per kolom selain failedTenants; risiko sisa 1 dan 2 di desain (credentialVersion lama, proses beku >10 menit).
Cari: reseal yang bisa membuang token ChatGPT baru (balapan dengan refresh/poll), CAS yang bisa menimpa nilai lebih baru, baris yang terlewat sehingga `remaining=0` palsu (termasuk frozen/busy), `reportOnly` yang menulis data, AAD/`key_version` push yang salah sehingga langganan tidak bisa dibuka setelah rotasi, kunci lama bisa dipensiunkan padahal masih ada ciphertext v lama, kebocoran lintas tenant (SQL/RLS), log yang mencetak token.
Hasil: `docs/qa/second-opinion-rotasi-kunci.md` (P0-P3, lokasi `ref:path:baris`, skenario, perbaikan, usul test). Lapor sekali di akhir.
