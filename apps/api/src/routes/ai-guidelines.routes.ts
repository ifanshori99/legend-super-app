// "Pedoman Penggunaan AI" page content (PRD v1.7 §40 Transparansi; contract
// `getAiGuidelines` in @starter/shared/ai, bead legend-jk6s contract). Static
// per release, not per tenant: any signed-in user may read it.
import { Router } from "express";
import { aiGuidelinesSchema, type AiGuidelines } from "@starter/shared/ai";
import { requireAuth } from "../middleware/auth";
import { requireTrustedOrigin } from "../middleware/origin";
import { requireTenantContext } from "../middleware/tenant";

export const AI_GUIDELINES: AiGuidelines = aiGuidelinesSchema.parse({
  version: "1.0",
  updatedAt: "2026-11-09T00:00:00.000Z",
  sections: [
    {
      id: "apa-itu",
      titleId: "Apa itu Tanya AI",
      paragraphsId: [
        "Tanya AI membantu Anda membaca data usaha dengan bahasa sehari-hari, misalnya penjualan kemarin, stok yang menipis, atau jadwal shift.",
        'Jawaban yang dibuat AI selalu diberi label "Dibantu AI" dan menyebut sumber angkanya: metrik, periode, dan tautan ke halaman asalnya.',
      ],
    },
    {
      id: "data-dan-izin",
      titleId: "Data apa yang bisa dibaca AI",
      paragraphsId: [
        "AI hanya membaca data yang memang boleh Anda lihat. Izin peran, outlet, dan usaha Anda tetap berlaku persis seperti di aplikasi.",
        "Data pribadi seperti gaji orang lain, NIK, NPWP, rekening bank, kontak pelanggan, dan kode masuk tidak pernah dikirim ke AI. Slip gaji dan bagi hasil hanya bisa dilihat oleh pemiliknya sendiri.",
      ],
    },
    {
      id: "perubahan-butuh-persetujuan",
      titleId: "AI tidak mengubah data sendiri",
      paragraphsId: [
        "AI hanya boleh menyiapkan draf, misalnya draf pesanan pembelian, penyesuaian stok, promo, atau perubahan harga.",
        "Draf masuk ke kotak persetujuan. Perubahan baru berjalan setelah orang yang berwenang menyetujuinya.",
      ],
    },
    {
      id: "batas-pemakaian",
      titleId: "Batas pemakaian",
      paragraphsId: [
        "Setiap pengguna punya kuota pertanyaan per hari, dan setiap usaha punya batas biaya AI per bulan yang diatur pemilik. Saat batas tercapai, Tanya AI berhenti sementara dan aplikasi lain tetap berjalan normal.",
        "Admin dapat mematikan Tanya AI atau alat AI tertentu kapan saja.",
      ],
    },
    {
      id: "periksa-jawaban",
      titleId: "Periksa sebelum memutuskan",
      paragraphsId: [
        "AI bisa keliru. Untuk keputusan penting, buka tautan sumber dan periksa angkanya di laporan aslinya.",
        "Bila AI menjawab tidak tahu atau tidak berizin, artinya data itu memang tidak tersedia untuk Anda, bukan kesalahan aplikasi.",
      ],
    },
    {
      id: "riwayat",
      titleId: "Riwayat percakapan",
      paragraphsId: [
        "Riwayat percakapan hanya bisa dilihat oleh Anda sendiri dan dapat Anda hapus kapan saja. Jawaban yang tidak disimpan dihapus otomatis paling lama 7 hari.",
      ],
    },
  ],
});

export const aiGuidelinesRouter = Router();

aiGuidelinesRouter.get(
  "/guidelines",
  requireAuth,
  requireTrustedOrigin,
  requireTenantContext,
  (_req, res) => {
    res.json({ data: AI_GUIDELINES });
  },
);
