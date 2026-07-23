/**
 * Human-readable names for downloaded files.
 *
 * Downloads used to be named after the raw database id
 * ("mercato-export-cmrx2geap00ksoao0vaoqf7b3.zip"), which is meaningless in a
 * Downloads folder and impossible to tell apart from another export. Files are now
 * named after what they contain:
 *
 *   mercato-Spring Catalog-mathis-23-07-2026.zip
 *
 * Shared by the client (which sets `a.download`) and the API routes (which set the
 * Content-Disposition header) so a download is named the same either way.
 */

/**
 * Make a string safe for a filename on Windows, macOS and Linux.
 * Strips path separators and the characters Windows reserves, collapses whitespace,
 * and trims the trailing dots/spaces that Windows silently drops.
 */
export function sanitizeFilenamePart(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ") // reserved on Windows / illegal in paths
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 60)
    .trim();
}

/** Local calendar date as DD-MM-YYYY (not UTC — the user's own day is what matters). */
export function localDateStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/**
 * Build a download filename: `mercato-{project}-{marketplace}-{date}.{ext}`.
 * Empty or unusable parts are dropped rather than leaving stray separators, so a
 * project with an emoji-only name still yields "mercato-mathis-23-07-2026.zip".
 */
export function buildDownloadName(opts: {
  projectName?: string | null;
  marketplace?: string | null;
  extension: string;
  prefix?: string;
  date?: Date;
}): string {
  const { projectName, marketplace, extension, prefix = "mercato", date } = opts;
  const parts = [
    prefix,
    sanitizeFilenamePart(projectName ?? ""),
    sanitizeFilenamePart(marketplace ?? ""),
    localDateStamp(date),
  ].filter(Boolean);
  return `${parts.join("-")}.${extension.replace(/^\./, "")}`;
}

/**
 * A complete Content-Disposition value for `filename`.
 *
 * Header values must be Latin-1, but project names can contain any character, so this
 * emits both forms per RFC 6266: a plain ASCII `filename=` that every client understands,
 * and a percent-encoded `filename*=` that modern browsers prefer and which preserves
 * non-ASCII names exactly.
 */
export function contentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
