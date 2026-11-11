# 539 Gelombang UI 12 Nov: aturan umum (U1-U5)
- Peran: ui-engineer (~/.agents/team/roles/ui-engineer.md), standar ~/.agents/team/ui-standard.md. Gerbang mockup sudah disetujui founder 12 Nov (docs/PROGRESS.md entri 06:00). Ikuti mockup persis; mockup di design/mockups/<area>/ (README di tiap folder). Baca gambar mockup satu layar saat membangun layar itu.
- Cari kartu FE dengan `bd show` / `bd ready | grep <area>`; cek `git log --all -i --grep=<id>` dulu.
- Worktree sendiri: `git worktree add .worktrees/<nama> -b ui/<nama> origin/milestone/m1`. Commit lokal per layar; push cabang kerja boleh; jangan merge.
- Pakai kontrak API yang ada. Bila endpoint belum ada: pakai mock/fixture sesuai kontrak di packages/shared dan catat kartu backend yang dibutuhkan; jangan tulis backend.
- Paralel: Explore per layar, satu implementer per layar (berkas terpisah), ui-auditor setelah layar jadi, test-runner. tsc/lint/test lewat heavy (satu tsc per giliran). Playwright lewat heavy.
- Bukti: screenshot tiap layar desktop + 390px (`ghostex visual check <page> --out <png> --width 390`), keadaan kosong/error/offline/loading seperti mockup, ui-auditor bersih, test komponen terarah lulus.
- Akhir: bangun satu Ghostex page review UI untuk founder (contoh ~/.agents/skills/ghostex-visuals/examples/plan-review.html, satu pertanyaan Setujui/Ubah per kelompok layar, `ghostex visual check` tanpa error). Laporkan path page; CTO yang menampilkannya. Angka subagent di laporan.
