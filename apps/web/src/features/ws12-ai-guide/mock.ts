// Mock handler for the Pedoman Penggunaan AI page (VITE_API_MOCK=true). The
// contract has no shared fixture for guidelines, so the text lives here and is
// parsed with the same schema the API will use. Scenarios: ?mock=slow shows the
// loading skeleton, ?mock=error and ?mock=offline the error state.
import { aiGuidelinesSchema, getAiGuidelines } from "@starter/shared/ai";
import { registerMock } from "../../lib/mock/registry.ts";

const guidelines = aiGuidelinesSchema.parse({
  version: "1.0",
  updatedAt: "2026-11-12T00:00:00.000Z",
  sections: [
    {
      id: "tentang",
      titleId: "Asisten untuk pekerjaan Anda",
      paragraphsId: [
        "Tanya AI membantu mencari jawaban dan menyiapkan draf berdasarkan data yang boleh Anda akses. Hasilnya perlu diperiksa sebelum digunakan.",
      ],
    },
    {
      id: "periksa-sumber",
      titleId: "Periksa sumber jawaban",
      paragraphsId: [
        "Angka disertai metrik, periode, dan tautan laporan sumber. Buka sumber untuk memastikan konteksnya sesuai.",
      ],
    },
    {
      id: "keputusan-manusia",
      titleId: "Keputusan tetap di tangan manusia",
      paragraphsId: [
        "AI dapat menyusun draf, tetapi tidak menjalankan aksi sendiri. Orang yang berwenang meninjau permintaan melalui kotak persetujuan.",
      ],
    },
    {
      id: "informasi-sensitif",
      titleId: "Jaga informasi sensitif",
      paragraphsId: [
        "Jangan masukkan kode login, data kontak pelanggan, NIK, NPWP, nomor rekening, atau gaji orang lain dalam pertanyaan.",
      ],
    },
    {
      id: "batas-akses",
      titleId: "Kenali batas akses",
      paragraphsId: [
        "Jawaban mengikuti peran dan cakupan outlet Anda. Jika data tidak tersedia atau tidak dapat diakses, AI akan menyatakannya.",
      ],
    },
    {
      id: "hasil-ai",
      titleId: "Hasil yang disusun AI",
      paragraphsId: [
        "Konten yang disusun AI diberi label “Dibantu AI”. Anda dapat menghapus riwayat percakapan milik Anda dari Tanya AI.",
      ],
    },
  ],
});

registerMock(getAiGuidelines, () => ({ data: guidelines }));
