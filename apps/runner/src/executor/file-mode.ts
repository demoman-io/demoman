// apps/runner/src/executor/file-mode.ts
//
// Whether a private file is open to other users, and its mode as `ls` says
// it: sessions refuse such a file, secrets.env warns (DEM-104).

/** Group or other can read it; Windows modes say nothing of the kind. */
export const exposed = (mode: number): boolean =>
  process.platform !== "win32" && (mode & 0o077) !== 0;

export const octal = (mode: number): string =>
  (mode & 0o777).toString(8).padStart(4, "0");
