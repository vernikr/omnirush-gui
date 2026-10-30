import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handleSaveFileDialog,
  resolveDialogDefaultPath,
  resolveDirectExportPath,
  resolveUniqueDownloadPath,
} from "./save-file.mjs";

test("saveToDownloads writes directly into Downloads and deduplicates collisions without opening dialog", async () => {
  const downloads = mkdtempSync(path.join(os.tmpdir(), "omnirush-downloads-"));
  try {
    const first = await handleSaveFileDialog({
      dialog: {
        showSaveDialog: async () => {
          throw new Error("dialog must not open when saveToDownloads is true");
        },
      },
      downloadsDir: downloads,
      options: {
        saveToDownloads: true,
        defaultPath: "omnirush-chat.md",
        content: "# First export\n",
      },
    });
    assert.equal(first, path.join(downloads, "omnirush-chat.md"));
    assert.equal(readFileSync(first, "utf8"), "# First export\n");

    const second = await handleSaveFileDialog({
      dialog: {
        showSaveDialog: async () => {
          throw new Error("dialog must not open when saveToDownloads is true");
        },
      },
      downloadsDir: downloads,
      options: {
        saveToDownloads: true,
        defaultPath: "omnirush-chat.md",
        content: "# Second export\n",
      },
    });
    assert.equal(second, path.join(downloads, "omnirush-chat (1).md"));
    assert.equal(readFileSync(second, "utf8"), "# Second export\n");
    assert.equal(resolveUniqueDownloadPath(downloads, "omnirush-chat.md"), path.join(downloads, "omnirush-chat (2).md"));
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
});

test("handleSaveFileDialog writes UTF-8 content atomically when user picks a save path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omnirush-save-file-"));
  const downloads = mkdtempSync(path.join(os.tmpdir(), "omnirush-save-dl-"));
  try {
    const picked = path.join(dir, "exports", "thread.md");
    const saved = await handleSaveFileDialog({
      dialog: {
        showSaveDialog: async (_win, opts) => {
          assert.equal(opts.defaultPath, path.join(downloads, "omnirush-chat.md"));
          return { canceled: false, filePath: picked };
        },
      },
      parentWindow: null,
      downloadsDir: downloads,
      options: {
        title: "Export chat as Markdown",
        defaultPath: "omnirush-chat.md",
        workspaceRoot: dir,
        content: "# Session\n\n> _Reasoning_\n> привет мир\n",
      },
    });

    assert.equal(saved, picked);
    assert.equal(readFileSync(picked, "utf8"), "# Session\n\n> _Reasoning_\n> привет мир\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }
});

test("handleSaveFileDialog returns null without writing when canceled", async () => {
  const saved = await handleSaveFileDialog({
    dialog: {
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    },
    options: {
      defaultPath: "chat.md",
      content: "# Ignored",
    },
  });
  assert.equal(saved, null);
});

test("resolveDirectExportPath refuses traversal, symlink escapes, and overwriting existing files", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "omnirush-direct-export-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "omnirush-outside-"));
  try {
    assert.throws(
      () => resolveDirectExportPath({ workspaceRoot: base, relativePath: "../escape.md" }),
      /outside the project folder/,
    );
    assert.throws(
      () => resolveDirectExportPath({ workspaceRoot: base, relativePath: "/etc/passwd" }),
      /outside the project folder/,
    );

    const escapeLink = path.join(base, "linked-out");
    symlinkSync(outside, escapeLink);
    assert.throws(
      () => resolveDirectExportPath({ workspaceRoot: base, relativePath: "linked-out/secret.md" }),
      /outside the project folder/,
    );

    const existing = path.join(base, "already.md");
    writeFileSync(existing, "keep me", "utf8");
    assert.throws(
      () => resolveDirectExportPath({ workspaceRoot: base, relativePath: "already.md" }),
      /already exists/,
    );

    const nestedSaved = await handleSaveFileDialog({
      dialog: {
        showSaveDialog: async () => {
          throw new Error("dialog must not open for relativePath");
        },
      },
      options: {
        workspaceRoot: base,
        relativePath: "notes/chat-export.md",
        content: "# Direct export\n",
      },
    });
    assert.equal(nestedSaved, path.join(base, "notes", "chat-export.md"));
    assert.equal(readFileSync(nestedSaved, "utf8"), "# Direct export\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolveDialogDefaultPath prefers downloadsDir and falls back to workspaceRoot when downloadsDir is absent", () => {
  const downloads = mkdtempSync(path.join(os.tmpdir(), "omnirush-dl-"));
  try {
    const sub = path.join(downloads, "project");
    mkdirSync(sub);
    assert.equal(
      resolveDialogDefaultPath({ defaultPath: "chat.md", workspaceRoot: sub, downloadsDir: downloads }),
      path.join(downloads, "chat.md"),
    );
    assert.equal(
      resolveDialogDefaultPath({ defaultPath: "chat.md", workspaceRoot: sub, downloadsDir: null }),
      path.join(sub, "chat.md"),
    );
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
});
