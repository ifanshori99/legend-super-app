# 539-U3 founder review page (Ghostex page)

Goal: one Ghostex page for the founder (non-technical, Indonesian) to review the U3 screens "Tanya AI + MCP". Write it to `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp/docs/review/539-u3-ai-mcp.html` (create folder). Do not publish (`ghostex show` is forbidden). Do not commit.

Read first: `~/.agents/skills/ghostex-visuals/SKILL.md` sections "Ghostex pages", "Layout", "Phones", "No page chrome of your own", "Images, sandbox, publishing", "Ghostex pages with questions". Example: `~/.agents/skills/ghostex-visuals/examples/plan-review.html` (keep `<meta name="ghostex-page" content="v2">`, use `<gx-questions submit="Kirim ke tim">`).

Images: absolute paths to `/Users/ifanshori99/Projects/legend super app/legend/.worktrees/ai-mcp/output/ui-check-ai-mcp/<name>-<1440|390>.png`, inside `<figure class="gx-figure">` with a short Indonesian `<figcaption>`. Desktop and phone shots side by side in a `.gx-grid` (stacks on phone). Keep total images under ~3 MB (pick the list below only).

Language: plain Indonesian, no jargon (no "MCP token", say "akses aplikasi luar"; "MCP" may appear only as the screen name "MCP & AI"). Title: "Review UI Tanya AI dan akses aplikasi luar". Header lede: screens follow the mockups approved 12 Nov; data is example data.

Groups, each = heading + 1–2 sentence what it does + screenshots + one `<gx-question>` with choices `Setujui` (recommended) and `Ubah` (detail "Tulis perubahan di catatan"). Tie: wrap each group's screenshots in `<section data-question="Qn" data-choice="Setujui">`? No: questions are approve/change, not variants, so do NOT add data-choice ties; put the question directly under its screenshots.
1. Q1 Tanya AI (chat): `tanya-ai-1440`, `tanya-ai-390`; states row: `tanya-ai-tidak-tersedia-1440` (AI belum tersedia), `tanya-ai-kuota-1440` (kuota habis), `tanya-ai-empty-390` (belum ada percakapan).
2. Q2 Panduan AI: `panduan-1440`, `panduan-390`.
3. Q3 Draf aksi AI dan kotak persetujuan: `aksi-menunggu-1440`, `aksi-menunggu-390`, `aksi-ditolak-390`, `persetujuan-ai-1440`. Say: AI only drafts; a different person must approve.
4. Q4 Layar izin aplikasi luar (consent): `consent-1440`, `consent-390`, `consent-error-390`. Say: shows where the user returns after approving.
5. Q5 Pengaturan MCP & AI (admin): `admin-1440`, `admin-390`, `admin-cabut-1440`, `admin-cabut-390`. Callout (`gx-callout`): founder decision Q11 shown in the revoke dialog — cabut satu aplikasi = semua sesi aplikasi itu putus, each user must approve again, berlaku dalam 1 menit; admin must write a short reason (required by the system, not in the mockup).
6. Q6 Pemakaian dan riwayat akses: `pemakaian-1440`, `pemakaian-390`, `pemakaian-berhenti-1440`. No own mockup; follows admin page style.

End with a short "Yang sengaja berbeda dari mockup" list (plain words): kolom alasan saat mencabut; riwayat chat di HP dibuka sebagai panel; hapus riwayat per percakapan; deskripsi tiap izin di layar izin belum ada karena sistem baru memberi nama izin; "Kembali ke aplikasi" ke beranda Legend; nama aplikasi contoh ("Claude Desktop", "Cursor Finance Agent") berbeda dari mockup ("Asisten Analitik").

Check: run `ghostex visual check <file>` and `ghostex visual check <file> --width 390`; fix everything it lists until it prints no errors. Report: path, check output summary.
