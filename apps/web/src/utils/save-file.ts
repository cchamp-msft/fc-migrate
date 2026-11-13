/** How long the object URL outlives the click, so the browser can start the download. */
const REVOKE_AFTER_MS = 30_000;

/** Hands the user a file to save. */
export function saveFile(name: string, data: BlobPart, type = "text/plain"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
