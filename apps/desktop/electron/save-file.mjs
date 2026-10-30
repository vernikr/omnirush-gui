import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Find the deepest ancestor of `targetPath` that already exists on disk so we
 * can resolve symlinks before creating any missing parent directories.
 *
 * @param {string} targetPath
 * @returns {string}
 */
function deepestExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * True when `childPath` is strictly inside `rootPath` (not equal to root, not
 * traversing above root, and not crossing Windows drive letters).
 *
 * @param {string} rootPath
 * @param {string} childPath
 * @returns {boolean}
 */
function isStrictlyInsideDirectory(rootPath, childPath) {
  const rel = path.relative(rootPath, childPath);
  return Boolean(rel) && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a collision-free file path inside `directory` by appending ` (1)`,
 * ` (2)`, etc. before the file extension when a file with the same name
 * already exists (matching standard browser / macOS Downloads behavior).
 *
 * @param {string} directory
 * @param {string} fileName
 * @returns {string}
 */
export function resolveUniqueDownloadPath(directory, fileName) {
  const cleanLeaf = path.basename(String(fileName || "").trim()) || "omnirush-chat.md";
  const ext = path.extname(cleanLeaf);
  const stem = ext ? cleanLeaf.slice(0, -ext.length) : cleanLeaf;
  const resolvedDir = path.resolve(directory);

  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidateLeaf = suffix === 0 ? cleanLeaf : `${stem} (${suffix})${ext}`;
    const candidatePath = path.join(resolvedDir, candidateLeaf);
    try {
      lstatSync(candidatePath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return candidatePath;
      }
      throw error;
    }
  }
  return path.join(resolvedDir, `${stem}-${Date.now()}${ext}`);
}

/**
 * Resolve a relative export target inside `workspaceRoot`, refusing path
 * traversal, symlink escapes, and overwriting existing files (matching
 * FreeBuff's `/export <filename>` safety guarantees).
 *
 * @param {{ workspaceRoot: string; relativePath: string }} input
 * @returns {string}
 */
export function resolveDirectExportPath({ workspaceRoot, relativePath }) {
  const rootTrimmed = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  const relTrimmed = typeof relativePath === "string" ? relativePath.trim() : "";
  if (!rootTrimmed) {
    throw new Error("Project folder is not available for relative export paths");
  }
  if (!relTrimmed || relTrimmed.includes("\0")) {
    throw new Error("Invalid export filename");
  }
  if (path.isAbsolute(relTrimmed) || /^[a-zA-Z]:[\\/]/.test(relTrimmed)) {
    throw new Error("Refusing to write outside the project folder");
  }

  const resolvedRoot = path.resolve(rootTrimmed);
  let rootReal;
  try {
    const rootStat = statSync(resolvedRoot);
    if (!rootStat.isDirectory()) {
      throw new Error("Project folder is not a local directory");
    }
    rootReal = realpathSync(resolvedRoot);
  } catch (error) {
    if (error instanceof Error && error.message === "Project folder is not a local directory") {
      throw error;
    }
    throw new Error("Project folder is not accessible on disk");
  }

  const candidate = path.resolve(resolvedRoot, relTrimmed);
  if (!isStrictlyInsideDirectory(resolvedRoot, candidate)) {
    throw new Error("Refusing to write outside the project folder");
  }

  const existingAncestor = deepestExistingAncestor(path.dirname(candidate));
  const existingAncestorReal = realpathSync(existingAncestor);
  if (existingAncestorReal !== rootReal && !isStrictlyInsideDirectory(rootReal, existingAncestorReal)) {
    throw new Error("Refusing to write outside the project folder");
  }

  try {
    lstatSync(candidate);
    throw new Error(`${relTrimmed} already exists — pass a new filename`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return candidate;
    }
    throw error;
  }
}

/**
 * Write UTF-8 text atomically via a sibling temporary file + rename.
 *
 * @param {string} filePath
 * @param {string} content
 */
export async function writeTextFileAtomically(filePath, content) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await mkdir(dir, { recursive: true });
  const nonce = randomBytes(6).toString("hex");
  const tempPath = path.join(dir, `.${path.basename(resolved)}.${process.pid}.${nonce}.tmp`);
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, resolved);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

/**
 * Resolve a sensible initial path for Electron's native Save dialog when a
 * bare filename is supplied.
 *
 * @param {{ defaultPath?: string; workspaceRoot?: string; downloadsDir?: string | null }} input
 * @returns {string | undefined}
 */
export function resolveDialogDefaultPath({ defaultPath, workspaceRoot, downloadsDir }) {
  const trimmed = typeof defaultPath === "string" ? defaultPath.trim() : "";
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) return trimmed;

  if (typeof downloadsDir === "string" && downloadsDir.trim()) {
    return path.join(downloadsDir.trim(), trimmed);
  }
  const rootTrimmed = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (rootTrimmed) {
    try {
      if (statSync(rootTrimmed).isDirectory()) {
        return path.join(rootTrimmed, trimmed);
      }
    } catch {
      // Ignore missing workspaceRoot.
    }
  }
  return trimmed;
}

/**
 * Handle the renderer `saveFile` IPC request:
 * - Direct save into `Downloads` when `saveToDownloads: true` is passed
 * - Direct relative workspace write when `relativePath` is provided
 * - Interactive native Save dialog otherwise (writing `content` atomically when supplied)
 *
 * @param {{
 *   dialog: { showSaveDialog: (win: any, options: any) => Promise<{ canceled: boolean; filePath?: string }> };
 *   parentWindow?: any;
 *   downloadsDir?: string | null;
 *   options?: {
 *     title?: string;
 *     defaultPath?: string;
 *     filters?: { name: string; extensions: string[] }[];
 *     content?: string;
 *     workspaceRoot?: string;
 *     relativePath?: string;
 *     saveToDownloads?: boolean;
 *   };
 * }} params
 * @returns {Promise<string | null>}
 */
export async function handleSaveFileDialog({ dialog, parentWindow, downloadsDir, options = {} }) {
  if (options.saveToDownloads === true) {
    if (typeof options.content !== "string") {
      throw new Error("content is required when saveToDownloads is true");
    }
    const targetDir =
      (typeof downloadsDir === "string" && downloadsDir.trim()) ||
      path.join(os.homedir(), "Downloads");
    await mkdir(targetDir, { recursive: true });
    const targetPath = resolveUniqueDownloadPath(targetDir, options.defaultPath ?? "omnirush-chat.md");
    await writeTextFileAtomically(targetPath, options.content);
    return targetPath;
  }

  if (typeof options.relativePath === "string" && options.relativePath.trim()) {
    if (typeof options.content !== "string") {
      throw new Error("content is required when saving to relativePath");
    }
    const targetPath = resolveDirectExportPath({
      workspaceRoot: options.workspaceRoot ?? "",
      relativePath: options.relativePath,
    });
    await writeTextFileAtomically(targetPath, options.content);
    return targetPath;
  }

  const resolvedDefaultPath = resolveDialogDefaultPath({
    defaultPath: options.defaultPath,
    workspaceRoot: options.workspaceRoot,
    downloadsDir,
  });

  const dialogOptions = {
    title: options.title,
    defaultPath: resolvedDefaultPath,
    filters: options.filters,
  };
  const result = await dialog.showSaveDialog(parentWindow, dialogOptions);
  if (result.canceled || !result.filePath) {
    return null;
  }
  if (typeof options.content === "string") {
    await writeTextFileAtomically(result.filePath, options.content);
  }
  return result.filePath;
}
