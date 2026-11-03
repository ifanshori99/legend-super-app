// Display serialisation only: the recap rows already on screen are written to a
// CSV the user can open. No amount is converted or recomputed; the official
// Coretax XML is produced by the API (see export-artifact-dialog.tsx).
// Kept out of lib.ts so the pure helpers stay DOM-free and Node-loadable.
export function downloadTextFile(
  fileName: string,
  content: string,
  mime = "text/csv;charset=utf-8",
): boolean {
  if (typeof document === "undefined") return false;
  // UTF-8 BOM so Excel reads the Indonesian characters.
  const blob = new Blob([`\ufeff${content}`], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
