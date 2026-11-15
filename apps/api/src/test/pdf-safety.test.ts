import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { HttpError } from "../lib/http-error";
import { assertSafePdf, type PdfSafetyOptions } from "../services/pdf-safety";

// Contract: docs/briefs/sub-storage-scanner-pdf.md (M5) and design D-5.
// Assumptions:
// - Every rejection is HttpError(422, "UPLOAD_REJECTED") with a generic
//   Indonesian message that never echoes the dangerous key name.
// - The encrypted message is the exact text from the brief.
// - Fixtures are built here with pdf-lib; no binary files in the repo.

const MAX_BYTES = 10 * 1024 * 1024;
const OPTIONS: PdfSafetyOptions = { maxBytes: MAX_BYTES };

type Ctx = PDFDocument["context"];

async function build(
  mutate?: (doc: PDFDocument) => void,
  pages = 1,
  useObjectStreams = true,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  mutate?.(doc);
  return doc.save({ useObjectStreams });
}

const dict = (ctx: Ctx, entries: Record<string, unknown>): PDFDict => {
  // pdf-lib's `obj` converts plain JS values into PDF objects.
  const created = ctx.obj(entries as Parameters<Ctx["obj"]>[0]);
  if (!(created instanceof PDFDict)) throw new Error("expected a PDF dict");
  return created;
};

const withOpenAction =
  (action: (doc: PDFDocument) => unknown) => (doc: PDFDocument) => {
    doc.catalog.set(
      PDFName.of("OpenAction"),
      action(doc) as Parameters<PDFDict["set"]>[1],
    );
  };

const withPageAnnotation =
  (annotation: (doc: PDFDocument) => PDFDict) => (doc: PDFDocument) => {
    const page = doc.getPage(0);
    const ref = doc.context.register(annotation(doc));
    page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  };

const rejection = async (
  bytes: Uint8Array,
  options: PdfSafetyOptions = OPTIONS,
): Promise<HttpError> => {
  const error = await assertSafePdf(bytes, options).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
};

const expectRejected = async (
  bytes: Uint8Array,
  options: PdfSafetyOptions = OPTIONS,
) => {
  const error = await rejection(bytes, options);
  expect(error.status).toBe(422);
  expect(error.code).toBe("UPLOAD_REJECTED");
  return error;
};

const text = (value: string) => new TextEncoder().encode(value);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const replaceAscii = (bytes: Uint8Array, from: string, to: string) => {
  const source = new TextDecoder("latin1").decode(bytes);
  expect(source).toContain(from);
  return text(source.replace(from, to));
};

describe("assertSafePdf accepts", () => {
  it("a plain valid PDF and reports its page count", async () => {
    await expect(assertSafePdf(await build(), OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
    await expect(
      assertSafePdf(await build(undefined, 3), OPTIONS),
    ).resolves.toEqual({ pageCount: 3 });
  });

  it("a PDF without object streams (classic xref)", async () => {
    const bytes = await build(undefined, 2, false);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 2,
    });
  });

  it("a PDF with exactly 50 pages", async () => {
    const bytes = await build(undefined, 50);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 50,
    });
  });

  it("a PDF with a %PDF-2. header", async () => {
    const bytes = replaceAscii(
      await build(undefined, 1, false),
      "%PDF-1.7",
      "%PDF-2.0",
    );
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });

  it("an OpenAction that is a destination array", async () => {
    const bytes = await build((doc) => {
      const pageRef = doc.getPage(0).ref;
      doc.catalog.set(
        PDFName.of("OpenAction"),
        doc.context.obj([pageRef, PDFName.of("Fit")]),
      );
    });
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });

  it("an OpenAction with /S /GoTo", async () => {
    const bytes = await build(
      withOpenAction((doc) =>
        dict(doc.context, {
          Type: "Action",
          S: "GoTo",
          D: [doc.getPage(0).ref, PDFName.of("Fit")],
        }),
      ),
    );
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });

  it("an ordinary /URI link (bank letterheads carry links)", async () => {
    const bytes = await build(
      withPageAnnotation((doc) =>
        dict(doc.context, {
          Type: "Annot",
          Subtype: "Link",
          Rect: [0, 0, 50, 20],
          A: dict(doc.context, {
            S: "URI",
            URI: PDFString.of("https://example.com/"),
          }),
        }),
      ),
    );
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });
});

describe("assertSafePdf rejects with 422 UPLOAD_REJECTED", () => {
  it("an empty file", async () => {
    await expectRejected(new Uint8Array(0));
  });

  it("a file larger than maxBytes", async () => {
    const bytes = await build();
    await expectRejected(bytes, { maxBytes: bytes.length - 1 });
  });

  it("a file that is not a PDF", async () => {
    await expectRejected(text("hello, this is plain text\n%%EOF\n"));
  });

  it("a file with the PDF header but garbage body", async () => {
    await expectRejected(text("%PDF-1.4\nnot a real document\n%%EOF\n"));
  });

  it("a truncated PDF without %%EOF in the last 1024 bytes", async () => {
    const bytes = await build(undefined, 1, false);
    const source = new TextDecoder("latin1").decode(bytes);
    const cut = source.lastIndexOf("%%EOF");
    expect(cut).toBeGreaterThan(0);
    await expectRejected(bytes.slice(0, cut));
  });

  it("a polyglot with %PDF- at offset 100", async () => {
    const bytes = await build();
    await expectRejected(concat(new Uint8Array(100).fill(0x20), bytes));
  });

  it("an encrypted PDF, with the dedicated message", async () => {
    const bytes = await build(
      (doc) => {
        const ctx = doc.context;
        const encrypt = ctx.register(
          dict(ctx, {
            Filter: "Standard",
            V: 1,
            R: 2,
            O: PDFString.of("0123456789abcdef0123456789abcdef"),
            U: PDFString.of("0123456789abcdef0123456789abcdef"),
            P: -4,
          }),
        );
        ctx.trailerInfo.Encrypt = encrypt;
      },
      1,
      false,
    );
    const error = await expectRejected(bytes);
    expect(error.message).toBe(
      "PDF bersandi tidak diterima; simpan ulang tanpa sandi.",
    );
  });

  it("a PDF with 51 pages", async () => {
    await expectRejected(await build(undefined, 51));
  });

  it("an OpenAction that runs JavaScript, without echoing the key name", async () => {
    const bytes = await build(
      withOpenAction((doc) =>
        dict(doc.context, {
          Type: "Action",
          S: "JavaScript",
          JS: PDFString.of("app.alert('x')"),
        }),
      ),
    );
    const error = await expectRejected(bytes);
    expect(error.message).not.toMatch(/javascript/i);
    expect(error.message).not.toMatch(/OpenAction/);
  });

  it("an action name hidden with hex escapes (/J#61vaScript)", async () => {
    // Same-length placeholder keeps the xref offsets intact.
    const built = await build(
      withOpenAction((doc) =>
        dict(doc.context, { Type: "Action", S: "JQQQvaScript" }),
      ),
      1,
      false,
    );
    const bytes = replaceAscii(built, "/JQQQvaScript", "/J#61vaScript");
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/J#61vaScript");
    await expectRejected(bytes);
  });

  it("an /AA additional-actions entry on a page", async () => {
    const bytes = await build((doc) => {
      doc
        .getPage(0)
        .node.set(
          PDFName.of("AA"),
          dict(doc.context, { O: dict(doc.context, { S: "GoTo" }) }),
        );
    });
    await expectRejected(bytes);
  });

  it("an /AA entry on the catalog", async () => {
    const bytes = await build((doc) => {
      doc.catalog.set(PDFName.of("AA"), dict(doc.context, {}));
    });
    await expectRejected(bytes);
  });

  it("an /EmbeddedFiles name tree", async () => {
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const embedded = ctx.register(dict(ctx, { Names: [] }));
      const names = ctx.register(dict(ctx, { EmbeddedFiles: embedded }));
      doc.catalog.set(PDFName.of("Names"), names);
    });
    await expectRejected(bytes);
  });

  it("a file attachment annotation (/EmbeddedFile stream)", async () => {
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const stream = ctx.register(
        ctx.stream("hello", { Type: "EmbeddedFile" }),
      );
      const spec = ctx.register(
        dict(ctx, {
          Type: "Filespec",
          F: PDFString.of("a.txt"),
          EF: dict(ctx, { F: stream }),
        }),
      );
      const annot = ctx.register(
        dict(ctx, {
          Type: "Annot",
          Subtype: "FileAttachment",
          Rect: [0, 0, 10, 10],
          FS: spec,
        }),
      );
      doc.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([annot]));
    });
    await expectRejected(bytes);
  });

  it.each(["Launch", "SubmitForm", "ImportData", "GoToE", "RichMedia"])(
    "a link action of type /%s",
    async (type) => {
      const bytes = await build(
        withPageAnnotation((doc) =>
          dict(doc.context, {
            Type: "Annot",
            Subtype: "Link",
            Rect: [0, 0, 50, 20],
            A: dict(doc.context, { S: type }),
          }),
        ),
      );
      await expectRejected(bytes);
    },
  );

  it("a /JS key on a form field", async () => {
    const bytes = await build(
      withPageAnnotation((doc) =>
        dict(doc.context, {
          Type: "Annot",
          Subtype: "Widget",
          Rect: [0, 0, 50, 20],
          JS: PDFString.of("app.alert(1)"),
        }),
      ),
    );
    await expectRejected(bytes);
  });

  it("an /XFA entry in the AcroForm", async () => {
    const bytes = await build((doc) => {
      doc.catalog.set(
        PDFName.of("AcroForm"),
        dict(doc.context, { Fields: [], XFA: [] }),
      );
    });
    await expectRejected(bytes);
  });

  it("active content nested inside arrays", async () => {
    const bytes = await build((doc) => {
      const ctx = doc.context;
      const nested = ctx.obj([[dict(ctx, { S: "Launch" })]]) as PDFArray;
      doc.catalog.set(PDFName.of("Legend"), nested);
    });
    await expectRejected(bytes);
  });

  it("a parse that exceeds the time limit", async () => {
    // 1 ms cannot cover starting a worker and parsing, so the timeout fires.
    const bytes = await build(undefined, 50);
    await expectRejected(bytes, { maxBytes: MAX_BYTES, timeoutMs: 1 });
  });
});

// ---------------------------------------------------------------------------
// Hand-written PDFs (round 1 hardening, docs/briefs/sub-storage-scanner-pdf-fix1.md).
// pdf-lib cannot emit these shapes, so the bytes are assembled here with a
// correct classic xref table. Assumptions:
// - Anything pdf-lib's sequential parser and a xref-based reader could see
//   differently (duplicate object numbers, object headers hidden in comments
//   or stream data, an ObjStm without /Type) is refused, even if the copy that
//   pdf-lib keeps is clean.
// - Forbidden names apply both as the value of /S and as a dictionary key;
//   the newly added names are checked in the form they naturally appear in.
// ---------------------------------------------------------------------------

type RawItem =
  { id: number; body: string | Uint8Array } | { raw: string | Uint8Array };

interface RawPdf {
  bytes: Uint8Array;
  xrefOffset: number;
}

const latin1 = (value: string | Uint8Array) =>
  typeof value === "string" ? Buffer.from(value, "latin1") : Buffer.from(value);

const objectChunk = (id: number, body: string | Uint8Array) =>
  Buffer.concat([latin1(`${id} 0 obj\n`), latin1(body), latin1("\nendobj\n")]);

const xrefEntry = (offset: number) =>
  `${String(offset).padStart(10, "0")} 00000 n \n`;

/** Classic-xref PDF. With duplicate ids, `xref` picks which copy the table
 * points at (a reader that trusts the table sees that copy). */
function rawPdf(
  items: RawItem[],
  options: { xref?: "first" | "last" } = {},
): RawPdf {
  const parts: Buffer[] = [latin1("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")];
  let length = parts[0]!.length;
  const offsets = new Map<number, number[]>();
  for (const item of items) {
    const chunk =
      "raw" in item ? latin1(item.raw) : objectChunk(item.id, item.body);
    if ("id" in item)
      offsets.set(item.id, [...(offsets.get(item.id) ?? []), length]);
    parts.push(chunk);
    length += chunk.length;
  }
  const maxId = Math.max(...offsets.keys());
  let table = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    const seen = offsets.get(id);
    if (!seen) table += "0000000000 00000 f \n";
    else
      table += xrefEntry(
        options.xref === "first" ? seen[0]! : seen[seen.length - 1]!,
      );
  }
  const xrefOffset = length;
  parts.push(
    latin1(
      `${table}trailer\n<</Size ${maxId + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ),
  );
  return { bytes: new Uint8Array(Buffer.concat(parts)), xrefOffset };
}

/** Appends an incremental update that rewrites the given objects. */
function appendUpdate(
  base: RawPdf,
  objects: Array<[number, string | Uint8Array]>,
): Uint8Array {
  const parts: Buffer[] = [Buffer.from(base.bytes)];
  let length = base.bytes.length;
  const offsets: Array<[number, number]> = [];
  for (const [id, body] of objects) {
    const chunk = objectChunk(id, body);
    offsets.push([id, length]);
    parts.push(chunk);
    length += chunk.length;
  }
  let table = "xref\n0 1\n0000000000 65535 f \n";
  for (const [id, offset] of offsets) table += `${id} 1\n${xrefEntry(offset)}`;
  const size = Math.max(...offsets.map(([id]) => id)) + 1;
  parts.push(
    latin1(
      `${table}trailer\n<</Size ${size}/Root 1 0 R/Prev ${base.xrefOffset}>>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return new Uint8Array(Buffer.concat(parts));
}

const CLEAN_ACTION = "<</Type/Action/S/GoTo/D[3 0 R/Fit]>>";
const JS_ACTION = "<</Type/Action/S/JavaScript/JS(app.alert(1))>>";

/** Objects 1-3 (catalog, pages, page). The catalog's OpenAction is object 4
 * (supplied by the caller); `catalogExtra` adds more catalog entries. */
const skeleton = (catalogExtra = ""): RawItem[] => [
  {
    id: 1,
    body: `<</Type/Catalog/Pages 2 0 R/OpenAction 4 0 R${catalogExtra}>>`,
  },
  { id: 2, body: "<</Type/Pages/Kids[3 0 R]/Count 1>>" },
  { id: 3, body: "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>" },
];

/** Objects 1-3 and 5 where object 4 (supplied by the caller) is the action of a
 * link annotation on the page. Unlike an OpenAction, a link action may be any
 * type, so this isolates the "forbidden name" check from the OpenAction rule. */
const linkSkeleton = (): RawItem[] => [
  { id: 1, body: "<</Type/Catalog/Pages 2 0 R>>" },
  { id: 2, body: "<</Type/Pages/Kids[3 0 R]/Count 1>>" },
  {
    id: 3,
    body: "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Annots[5 0 R]>>",
  },
];
const linkAnnotation: RawItem = {
  id: 5,
  body: "<</Type/Annot/Subtype/Link/Rect[0 0 50 20]/A 4 0 R>>",
};

const streamObject = (dictBody: string, data: string | Uint8Array) => {
  const payload = latin1(data);
  return Buffer.concat([
    latin1(`<<${dictBody}/Length ${payload.length}>>\nstream\n`),
    payload,
    latin1("\nendstream"),
  ]);
};

describe("assertSafePdf hand-written PDFs: sanity", () => {
  it("accepts the clean hand-written skeleton (guards the fixtures)", async () => {
    const { bytes } = rawPdf([...skeleton(), { id: 4, body: CLEAN_ACTION }]);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });
});

describe("assertSafePdf name normalisation", () => {
  it("rejects a /JS key written with lower-case hex (/#4aS)", async () => {
    const { bytes } = rawPdf([
      ...skeleton(),
      {
        id: 4,
        body: "<</Type/Action/S/GoTo/D[3 0 R/Fit]/#4aS(app.alert(1))>>",
      },
    ]);
    await expectRejected(bytes);
  });

  it("rejects an action name written with lower-case hex (/#4aavaScript)", async () => {
    const { bytes } = rawPdf([
      ...linkSkeleton(),
      { id: 4, body: "<</Type/Action/S/#4aavaScript>>" },
      linkAnnotation,
    ]);
    await expectRejected(bytes);
  });

  it("rejects a lower-case hex action name (/GoT#6fR)", async () => {
    const { bytes } = rawPdf([
      ...linkSkeleton(),
      { id: 4, body: "<</Type/Action/S/GoT#6fR>>" },
      linkAnnotation,
    ]);
    await expectRejected(bytes);
  });
});

describe("assertSafePdf duplicate object numbers", () => {
  it.each(["first", "last"] as const)(
    "rejects a JS copy hidden behind a clean copy of object 4 (xref points at the %s copy)",
    async (xref) => {
      // pdf-lib keeps the last copy; a reader that trusts the xref table may
      // see the first. Either way the file carries active content.
      const { bytes } = rawPdf(
        [
          ...skeleton(),
          { id: 4, body: JS_ACTION },
          { id: 4, body: CLEAN_ACTION },
        ],
        { xref },
      );
      await expectRejected(bytes);
    },
  );

  it("accepts a clean incremental update that rewrites an object without active content", async () => {
    const base = rawPdf([...skeleton(), { id: 4, body: CLEAN_ACTION }]);
    const bytes = appendUpdate(base, [
      [4, "<</Type/Action/S/GoTo/D[3 0 R/XYZ 0 0 0]>>"],
    ]);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });

  it("rejects an incremental update that rewrites an object with JavaScript", async () => {
    const base = rawPdf([...skeleton(), { id: 4, body: CLEAN_ACTION }]);
    await expectRejected(appendUpdate(base, [[4, JS_ACTION]]));
  });

  it("rejects an incremental update that hides JavaScript in the superseded copy", async () => {
    const base = rawPdf([...skeleton(), { id: 4, body: JS_ACTION }]);
    await expectRejected(appendUpdate(base, [[4, CLEAN_ACTION]]));
  });
});

describe("assertSafePdf object headers pdf-lib never parsed", () => {
  it("rejects an object header (with JavaScript) hidden in a % comment", async () => {
    const { bytes } = rawPdf([
      ...skeleton(),
      { id: 4, body: CLEAN_ACTION },
      { raw: "% 6 0 obj <</S/JavaScript/JS(app.alert(1))>> endobj\n" },
    ]);
    await expectRejected(bytes);
  });

  it("rejects an object header (with JavaScript) inside stream data", async () => {
    const { bytes } = rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      {
        id: 5,
        body: streamObject(
          "",
          "6 0 obj\n<</S/JavaScript/JS(app.alert(1))>>\nendobj\n",
        ),
      },
    ]);
    await expectRejected(bytes);
  });
});

describe("assertSafePdf object streams", () => {
  const objStmData = "9 0 <</S/JavaScript/JS(app.alert(1))>>";

  it("rejects a stream with /N and /First but no /Type /ObjStm", async () => {
    const { bytes } = rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      { id: 5, body: streamObject("/N 1/First 4", objStmData) },
    ]);
    await expectRejected(bytes);
  });

  it("rejects a stream with /N and /First and a different /Type", async () => {
    const { bytes } = rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      {
        id: 5,
        body: streamObject("/Type/XObject/N 1/First 4", objStmData),
      },
    ]);
    await expectRejected(bytes);
  });
});

describe("assertSafePdf indirect names", () => {
  it.each(["Launch", "JavaScript", "GoToR"])(
    "rejects /S given as a reference to /%s",
    async (name) => {
      const { bytes } = rawPdf([
        ...linkSkeleton(),
        { id: 4, body: "<</Type/Action/S 6 0 R>>" },
        linkAnnotation,
        { id: 6, body: `/${name}` },
      ]);
      await expectRejected(bytes);
    },
  );

  it("rejects /Type given as a reference to /EmbeddedFile", async () => {
    const { bytes } = rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      { id: 5, body: streamObject("/Type 6 0 R", "hello") },
      { id: 6, body: "/EmbeddedFile" },
    ]);
    await expectRejected(bytes);
  });

  it("rejects /Subtype given as a reference to /RichMedia", async () => {
    const { bytes } = rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      { id: 5, body: "<</Type/Annot/Subtype 6 0 R/Rect[0 0 10 10]>>" },
      { id: 6, body: "/RichMedia" },
    ]);
    await expectRejected(bytes);
  });

  // Round 2: a name object that exists twice. pdf-lib keeps the last copy,
  // a reader trusting the xref table sees the first, so any dangerous copy
  // makes the file unsafe.
  it.each(["Launch", "SubmitForm"])(
    "rejects /S referencing object 6 that has a /%s copy first and a /GoTo copy last (xref at the first)",
    async (name) => {
      const { bytes } = rawPdf(
        [
          ...linkSkeleton(),
          { id: 4, body: "<</Type/Action/S 6 0 R/D[3 0 R/Fit]>>" },
          linkAnnotation,
          { id: 6, body: `/${name}` },
          { id: 6, body: "/GoTo" },
        ],
        { xref: "first" },
      );
      await expectRejected(bytes);
    },
  );

  it("rejects /Subtype referencing object 6 that has a /FileAttachment copy first and a /Link copy last (xref at the first)", async () => {
    const { bytes } = rawPdf(
      [
        ...linkSkeleton(),
        { id: 4, body: CLEAN_ACTION },
        {
          id: 5,
          body: "<</Type/Annot/Subtype 6 0 R/Rect[0 0 50 20]/A 4 0 R>>",
        },
        { id: 6, body: "/FileAttachment" },
        { id: 6, body: "/Link" },
      ],
      { xref: "first" },
    );
    await expectRejected(bytes);
  });

  it("rejects an OpenAction object with a /URI action copy first and a destination array copy last (xref at the first)", async () => {
    const { bytes } = rawPdf(
      [
        ...skeleton(),
        { id: 4, body: "<</Type/Action/S/URI/URI(https://example.com/)>>" },
        { id: 4, body: "[3 0 R/Fit]" },
      ],
      { xref: "first" },
    );
    await expectRejected(bytes);
  });

  it("accepts /S given as a reference to /GoTo", async () => {
    const { bytes } = rawPdf([
      ...skeleton(),
      { id: 4, body: "<</Type/Action/S 5 0 R/D[3 0 R/Fit]>>" },
      { id: 5, body: "/GoTo" },
    ]);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });
});

describe("assertSafePdf additional forbidden names", () => {
  it.each([
    "GoToR",
    "Rendition",
    "Movie",
    "Sound",
    "Screen",
    "3D",
    "OnInstantiate",
    "EF",
    "Win",
    "Mac",
    "Unix",
  ])("rejects an action of type /%s", async (name) => {
    const { bytes } = rawPdf([
      ...linkSkeleton(),
      { id: 4, body: `<</Type/Action/S/${name}>>` },
      linkAnnotation,
    ]);
    await expectRejected(bytes);
  });

  it.each(["EF", "OnInstantiate", "Win", "Mac", "Unix"])(
    "rejects a /%s key",
    async (key) => {
      const { bytes } = rawPdf([
        ...skeleton(),
        { id: 4, body: `<</Type/Action/S/GoTo/D[3 0 R/Fit]/${key}<<>>>>` },
      ]);
      await expectRejected(bytes);
    },
  );
});

describe("assertSafePdf decompression bombs", () => {
  const MIB = 1024 * 1024;

  /** An object stream that is valid and clean, but inflates to `size` bytes
   * of trailing spaces. */
  const objStmOfSize = (size: number) => {
    const inflated = Buffer.concat([
      latin1("9 0 <</A 1>>"),
      Buffer.alloc(size, 0x20),
    ]);
    return rawPdf([
      ...skeleton("/Legend 5 0 R"),
      { id: 4, body: CLEAN_ACTION },
      {
        id: 5,
        body: streamObject(
          "/Type/ObjStm/N 1/First 4/Filter/FlateDecode",
          deflateSync(inflated, { level: 1 }),
        ),
      },
    ]).bytes;
  };

  it("accepts a modest object stream (guards the bomb fixture)", async () => {
    const bytes = objStmOfSize(1 * MIB);
    expect(bytes.length).toBeLessThan(MAX_BYTES);
    await expect(assertSafePdf(bytes, OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  });

  it("rejects 200 MB of deflated spaces in an object stream within a sensible time, then keeps serving", async () => {
    const bytes = objStmOfSize(200 * MIB);
    // The upload itself is small: that is the point of a bomb.
    expect(bytes.length).toBeLessThan(MAX_BYTES);
    const started = Date.now();
    // A long timeout makes sure the 422 comes from the decoded-size cap
    // (64 MiB) and not from the wall-clock limit.
    await expectRejected(bytes, { maxBytes: MAX_BYTES, timeoutMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(assertSafePdf(await build(), OPTIONS)).resolves.toEqual({
      pageCount: 1,
    });
  }, 60_000);
});

describe("assertSafePdf concurrency", () => {
  it("answers 503 SERVICE_UNAVAILABLE beyond 2 running + 16 queued, and finishes the admitted ones", async () => {
    const bytes = await build();
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => assertSafePdf(bytes, OPTIONS)),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(2);
    expect(fulfilled.length).toBeLessThanOrEqual(18);
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(HttpError);
      expect(r.reason).toMatchObject({
        status: 503,
        code: "SERVICE_UNAVAILABLE",
      });
    }
    for (const r of fulfilled) expect(r.value).toEqual({ pageCount: 1 });
  }, 60_000);
});
