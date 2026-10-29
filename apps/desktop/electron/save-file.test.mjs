import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  handleSaveFileDialog,
  resolveDialogDefaultPath,
  resolveDirectExportPath,
} from "./save-file.mjs";

test("handleSaveFileDialog writes UTF-8 content atomically when user picks a save path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "omnirush-save-file-"));
  try {
    const picked = path.join(dir, "exports", "thread.md");
    const saved = await handleSaveFileDialog({
      dialog: {
        showSaveDialog: async (_win, opts) => {
          assert.equal(opts.defaultPath, path.join(dir, "omnirush-chat.md"));
          return { canceled: false, filePath: picked };
        },
      },
      parentWindow: null,
      downloadsDir: os.tmpdir(),
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

test("resolveDialogDefaultPath falls back to downloadsDir when workspaceRoot is missing", () => {
  const downloads = mkdtempSync(path.join(os.tmpdir(), "omnirush-dl-"));
  try {
    const resolved = resolveDialogDefaultPath({
      defaultPath: "chat.md",
      workspaceRoot: path.join(downloads, "does-not-exist"),
      downloadsDir: downloads,
    });
    assert.equal(resolved, path.join(downloads, "chat.md"));

    const sub = path.join(downloads, "project");
    mkdirSync(sub);
    assert.equal(
      resolveDialogDefaultPath({ defaultPath: "chat.md", workspaceRoot: sub, downloadsDir: downloads }),
      path.join(sub, "chat.md"),
    );
  } finally {
    rmSync(downloads, { recursive: true, force: true });
  }
});
