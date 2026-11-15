// Parses an uploaded PDF off the main thread (legend-851ef, design D-5). The
// parent (`pdf-safety.ts`) caps this thread's heap and terminates it on a
// timeout, so a PDF bomb cannot freeze the API.
//
// Kept self-contained: only `node:*` and `pdf-lib` imports, no relative or
// `@starter/shared` imports. Vitest starts this file with Node's own type
// stripping (a Worker bypasses Vite), and production runs the bundled
// `dist/pdf-safety.worker.js` (tsup entry). Never logs file content.
import { parentPort, workerData } from "node:worker_threads";
// Both imports name the CommonJS build explicitly, so the DecodeStream patched
// below is the very class `PDFDocument.load` decodes with: in Node (dev,
// vitest) and in the tsup bundle alike, where a bare "pdf-lib" might resolve
// to the separate `es/` copy instead.
import {
  decodePDFRawStream,
  ParseSpeeds,
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFParser,
  PDFRef,
  PDFStream,
  type PDFObject,
} from "pdf-lib/cjs/index.js";
import * as decodeStreamModule from "pdf-lib/cjs/core/streams/DecodeStream.js";

export type PdfSafetyRequest = { bytes: Uint8Array };
export type PdfSafetyVerdict =
  | { ok: true; pageCount: number }
  | { ok: false; reason: "encrypted" | "invalid" | "pages" | "active" };

export const MAX_PDF_PAGES = 50;
/** Decoded stream bytes allowed per file. Typed arrays live outside the V8
 * heap, so `maxOldGenerationSizeMb` alone does not stop a Flate bomb. */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** Dict keys, or `/S` action types, that carry active or embedded content. */
const BLOCKED_NAMES = new Set([
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "RichMedia",
  "XFA",
  "SubmitForm",
  "ImportData",
  "GoToE",
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
]);
/** Keys whose name value is also checked: the action type (`/S`), and the
 * object type (`/Type /EmbeddedFile` stream, `/Subtype /RichMedia` annot). */
const TYPED_KEYS = new Set(["S", "Type", "Subtype"]);
/** Annotation subtypes refused on top of BLOCKED_NAMES (file attachments). */
const BLOCKED_SUBTYPES = new Set(["FileAttachment"]);

/** An indirect object header (`12 0 obj`), comments allowed between parts as
 * readers allow them. Anchored at the first digit of a number. */
const OBJECT_HEADER =
  /(?<!\d)\d+(?:[\s\0]|%[^\r\n]*[\r\n])+\d+(?:[\s\0]|%[^\r\n]*[\r\n])*obj\b/g;

/** pdf-lib 1.17.1 decodes only upper-case `#XX` escapes; readers decode both. */
const normalizeName = (text: string) =>
  text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );

const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

/** What the parse saw, filled by the prototype patches in `installHooks`. */
const seen = {
  /** Every object ever assigned, overwritten copies and object 0 included. */
  assigned: [] as PDFObject[],
  /** The same, grouped by `objectNumber generationNumber`. */
  copies: new Map<string, PDFObject[]>(),
  /** Byte offset of every indirect object header pdf-lib parsed. */
  headerOffsets: new Set<number>(),
  decodedBytes: 0,
  decodeCapHit: false,
};

type DecodeStreamClass = {
  prototype: {
    ensureBuffer(this: DecodedBuffer, requested: number): Uint8Array;
  };
};
type DecodedBuffer = { buffer: Uint8Array };

/** Node hands the CommonJS `module.exports` as the default export; esbuild may
 * hand its `default` property instead. Accept either, then prove the class is
 * the one the parser decodes with. */
function decodeStreamClass(): DecodeStreamClass {
  const exported = (decodeStreamModule as unknown as { default: unknown })
    .default;
  const candidate =
    typeof exported === "function"
      ? exported
      : (exported as { default?: unknown } | undefined)?.default;
  if (
    typeof candidate !== "function" ||
    typeof (candidate as DecodeStreamClass).prototype.ensureBuffer !==
      "function"
  )
    throw new Error("pdf-lib DecodeStream not found");
  const probe = PDFContext.create().flateStream(new Uint8Array([1, 2, 3]));
  if (!(decodePDFRawStream(probe) instanceof candidate))
    throw new Error("pdf-lib DecodeStream is a different module instance");
  return candidate as DecodeStreamClass;
}

/** Patches pdf-lib prototypes. Worker thread only: the main thread never
 * loads this module at runtime (`pdf-safety.ts` imports its types only). */
function installHooks() {
  const decodeStream = decodeStreamClass().prototype;
  const ensureBuffer = decodeStream.ensureBuffer;
  decodeStream.ensureBuffer = function (requested) {
    const before = this.buffer.byteLength;
    const refuse = () => {
      seen.decodeCapHit = true;
      throw new Error("decoded stream bytes over the cap");
    };
    if (
      requested > before &&
      seen.decodedBytes + requested - before > MAX_DECODED_BYTES
    )
      refuse();
    const buffer = ensureBuffer.call(this, requested);
    seen.decodedBytes += buffer.byteLength - before;
    if (seen.decodedBytes > MAX_DECODED_BYTES) refuse();
    return buffer;
  };

  const assign = PDFContext.prototype.assign;
  PDFContext.prototype.assign = function (ref, object) {
    seen.assigned.push(object);
    const key = refKey(ref);
    const copies = seen.copies.get(key);
    if (copies) copies.push(object);
    else seen.copies.set(key, [object]);
    assign.call(this, ref, object);
  };

  const parser = PDFParser.prototype as unknown as {
    parseIndirectObject(this: { bytes: { offset(): number } }): Promise<PDFRef>;
  };
  const parseIndirectObject = parser.parseIndirectObject;
  parser.parseIndirectObject = function () {
    seen.headerOffsets.add(this.bytes.offset());
    return parseIndirectObject.call(this);
  };
}

/** True when the raw bytes hold an object header pdf-lib never parsed: one
 * hidden in a comment, a string, or stream data, that another reader's
 * xref or repair pass could still pick up. */
function hasHiddenObject(bytes: Uint8Array): boolean {
  const text = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("latin1");
  for (const match of text.matchAll(OBJECT_HEADER))
    if (!seen.headerOffsets.has(match.index)) return true;
  return false;
}

const resolve = (doc: PDFDocument, value: PDFObject | undefined) =>
  value instanceof PDFRef ? doc.context.lookup(value) : value;

const nameOf = (doc: PDFDocument, value: PDFObject | undefined) => {
  const resolved = resolve(doc, value);
  return resolved instanceof PDFName
    ? normalizeName(resolved.decodeText())
    : null;
};

const dictOf = (object: PDFObject) =>
  object instanceof PDFStream
    ? object.dict
    : object instanceof PDFDict
      ? object
      : null;

/** Every copy a reference may resolve to: pdf-lib keeps the last one, a
 * reader following the xref may pick an earlier one. */
function copiesOf(doc: PDFDocument, value: PDFObject | undefined) {
  if (!(value instanceof PDFRef)) return value ? [value] : [];
  const copies = seen.copies.get(refKey(value)) ?? [];
  const current = doc.context.lookup(value);
  return current && !copies.includes(current) ? [...copies, current] : copies;
}

/** A destination array, or a `/S /GoTo` action dict, is a harmless OpenAction.
 * Every copy of the action, and of its `/S`, must be one of those. */
function isSafeOpenAction(doc: PDFDocument, raw: PDFObject): boolean {
  const actions = copiesOf(doc, raw);
  return (
    actions.length > 0 &&
    actions.every((value) => {
      if (value instanceof PDFArray) return true;
      if (!(value instanceof PDFDict)) return false;
      const types = copiesOf(doc, value.get(PDFName.of("S")));
      return (
        types.length > 0 &&
        types.every(
          (type) =>
            type instanceof PDFName &&
            normalizeName(type.decodeText()) === "GoTo",
        )
      );
    })
  );
}

/** A bare name object (`6 0 obj /Launch endobj`) a `/S`, `/Type`, or
 * `/Subtype` may point at. Checked for every copy, not only the one pdf-lib
 * kept, since a reader may resolve the reference to another. */
const isBlockedNameObject = (object: PDFObject) => {
  if (!(object instanceof PDFName)) return false;
  const name = normalizeName(object.decodeText());
  return BLOCKED_NAMES.has(name) || BLOCKED_SUBTYPES.has(name);
};

/** A stream shaped like an object stream (`/N` and `/First`) that pdf-lib did
 * not unpack as one: its objects were never inspected. pdf-lib unpacks only a
 * direct `/Type /ObjStm`, and an unpacked one is never assigned. */
function isHiddenObjectStream(object: PDFObject): boolean {
  if (!(object instanceof PDFStream)) return false;
  const keys = new Set(
    object.dict.keys().map((key) => normalizeName(key.decodeText())),
  );
  return (
    keys.has("N") &&
    keys.has("First") &&
    object.dict.get(PDFName.of("Type")) !== PDFName.of("ObjStm")
  );
}

/** True when any reachable dict holds a blocked key or action type. Iterative,
 * so a deeply nested direct object cannot overflow the stack. Indirect
 * references are not followed: every assigned object is a root anyway. */
function hasActiveContent(doc: PDFDocument, roots: PDFObject[]): boolean {
  const stack = [...roots];
  const visited = new Set<PDFObject>();
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const dict = dictOf(current);
    if (dict) {
      for (const [key, value] of dict.entries()) {
        const name = normalizeName(key.decodeText());
        if (BLOCKED_NAMES.has(name) || name === "AA") return true;
        if (TYPED_KEYS.has(name)) {
          const type = nameOf(doc, value) ?? "";
          if (BLOCKED_NAMES.has(type)) return true;
          if (name === "Subtype" && BLOCKED_SUBTYPES.has(type)) return true;
        }
        if (name === "OpenAction" && !isSafeOpenAction(doc, value)) return true;
        stack.push(value);
      }
    } else if (current instanceof PDFArray) {
      stack.push(...current.asArray());
    }
  }
  return false;
}

async function inspect(bytes: Uint8Array): Promise<PdfSafetyVerdict> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, {
      throwOnInvalidObject: true,
      updateMetadata: false,
      ignoreEncryption: true,
      // Its own thread with a timeout: no need to yield to an event loop.
      parseSpeed: ParseSpeeds.Fastest,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // A swallowed decode error still leaves the cap flag set.
  if (seen.decodeCapHit) return { ok: false, reason: "invalid" };
  if (doc.isEncrypted) return { ok: false, reason: "encrypted" };
  try {
    const pageCount = doc.getPageCount();
    if (pageCount < 1 || pageCount > MAX_PDF_PAGES)
      return { ok: false, reason: "pages" };
    // pdf-lib keeps the last copy of a repeated object number, but a reader
    // following the xref may pick an earlier one: every copy must pass.
    if (hasHiddenObject(bytes) || seen.assigned.some(isHiddenObjectStream))
      return { ok: false, reason: "invalid" };
    if (seen.assigned.some(isBlockedNameObject))
      return { ok: false, reason: "active" };
    const trailer = doc.context.trailerInfo;
    const roots: PDFObject[] = [doc.catalog, ...seen.assigned];
    for (const entry of [trailer.Root, trailer.Info, trailer.Encrypt]) {
      const value = resolve(doc, entry);
      if (value) roots.push(value);
    }
    for (const [, object] of doc.context.enumerateIndirectObjects())
      roots.push(object);
    if (hasActiveContent(doc, roots)) return { ok: false, reason: "active" };
    return { ok: true, pageCount };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

if (parentPort) {
  installHooks();
  const request: PdfSafetyRequest = workerData;
  const verdict = await inspect(request.bytes);
  parentPort.postMessage(verdict);
}
