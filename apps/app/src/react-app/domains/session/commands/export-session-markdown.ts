import { useCallback } from "react";

import { toast } from "@/components/ui/sonner";
import { revealDesktopItemInDir, saveFile } from "@/app/lib/desktop";
import { downloadTextAsFile } from "@/app/lib/download";
import { unwrap } from "@/app/lib/opencode";
import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import type { OmniRushServerClient, OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import {
  buildCanonicalTranscriptIR,
  buildSessionExportFilename,
  collectReferencedSubagentSessionIds,
  renderTranscriptFromIR,
  validateRelativeExportPath,
  type CanonicalTranscriptIR,
  type ExportableSessionTree,
  type ExportMarkdownOptions,
} from "@/app/lib/session-markdown-export";
import { t } from "@/i18n";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { snapshotKey } from "@/react-app/domains/session/sync/session-sync";
import {
  openExportMarkdownModal,
  useExportSessionMarkdownStore,
} from "./export-session-markdown-store";

export type ExportSessionMarkdownTarget = {
  workspaceId: string;
  serverWorkspaceId?: string;
  sessionId: string;
  opencodeBaseUrl: string;
  token: string;
  workspaceRoot?: string;
  serverClient?: OmniRushServerClient | null;
  /** Optional relative workspace path passed via `/export <filename>`. */
  relativeFilename?: string | null;
};

export type ExportSessionMarkdownOutcome =
  | { outcome: "saved"; path: string }
  | { outcome: "canceled" }
  | { outcome: "failed"; error: string };

export type LoadedExportSessionData = {
  ir: CanonicalTranscriptIR;
  defaultFilename: string;
};

const MAX_SUBAGENT_DEPTH = 4;

export function formatExportByteSize(bytes: number): string {
  const safe = Math.max(0, Math.round(bytes));
  if (safe < 1024) {
    return `${safe} B`;
  }
  if (safe < 1024 * 1024) {
    return `${(safe / 1024).toFixed(1)} KB`;
  }
  return `${(safe / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format an estimated token count strictly in thousands (`k`) so users can
 * directly compare session size against LLM context windows (`128k`, `200k`, `1,000k`).
 */
export function formatEstimatedTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.round(tokens));
  if (safe === 0) {
    return "0k";
  }
  if (safe < 100) {
    return "0.1k";
  }
  if (safe < 99_950) {
    return `${(safe / 1000).toFixed(1)}k`;
  }
  return `${Math.round(safe / 1000).toLocaleString("en-US")}k`;
}

function shortenSavedPathForToast(savedPath: string, workspaceRoot?: string): string {
  const root = workspaceRoot?.trim().replace(/[\\/]+$/, "") ?? "";
  if (root && savedPath.startsWith(`${root}/`)) {
    return savedPath.slice(root.length + 1);
  }
  if (root && savedPath.startsWith(`${root}\\`)) {
    return savedPath.slice(root.length + 1);
  }
  const parts = savedPath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : savedPath;
}

async function loadSessionTreeRecursive(params: {
  client: ReturnType<typeof createClientV2>;
  workspaceId: string;
  sessionId: string;
  depth: number;
  visited: Set<string>;
}): Promise<ExportableSessionTree> {
  const { client, workspaceId, sessionId, depth, visited } = params;
  visited.add(sessionId);

  let tree: ExportableSessionTree;
  try {
    const [sessionResult, messagesResult, todoResult] = await Promise.all([
      client.session.get({ sessionID: sessionId }),
      client.session.messages({ sessionID: sessionId }),
      client.session.todo({ sessionID: sessionId }).catch(() => null),
    ]);
    const session = unwrap(sessionResult);
    const messages = unwrap(messagesResult);
    const todos = todoResult && todoResult.data ? todoResult.data : [];
    tree = { session, messages, todos };
  } catch (liveError) {
    const cached = getReactQueryClient().getQueryData<OmniRushSessionSnapshot>(
      snapshotKey(workspaceId, sessionId),
    );
    if (!cached) {
      throw liveError;
    }
    tree = {
      session: cached.session,
      messages: cached.messages,
      todos: cached.todos,
    };
  }

  if (depth >= MAX_SUBAGENT_DEPTH) {
    return tree;
  }

  const childIds = collectReferencedSubagentSessionIds(tree.session, tree.messages).filter(
    (childId) => !visited.has(childId),
  );
  if (childIds.length === 0) {
    return tree;
  }

  const subagentSessions = new Map<string, ExportableSessionTree>();
  for (const childId of childIds) {
    if (visited.has(childId)) continue;
    try {
      const childTree = await loadSessionTreeRecursive({
        client,
        workspaceId,
        sessionId: childId,
        depth: depth + 1,
        visited,
      });
      subagentSessions.set(childId, childTree);
    } catch {
      // Sub-agent child session may have been cleaned up; keep parent export intact.
    }
  }

  return subagentSessions.size > 0 ? { ...tree, subagentSessions } : tree;
}

/**
 * Fetch the full unwindowed session transcript + nested subagent transcripts and
 * construct the reusable `CanonicalTranscriptIR` for instant live size previews.
 */
export async function loadExportableSessionIR(
  target: ExportSessionMarkdownTarget,
): Promise<LoadedExportSessionData> {
  const sessionId = target.sessionId.trim();
  const baseUrl = target.opencodeBaseUrl.trim();
  if (!sessionId || !baseUrl) {
    throw new Error(t("session.export_markdown_failed"));
  }

  const relativeArg = target.relativeFilename?.trim() ?? "";
  const validatedRelative = relativeArg ? validateRelativeExportPath(relativeArg) : null;
  if (validatedRelative && !validatedRelative.ok) {
    throw new Error(validatedRelative.reason);
  }

  const client = createClientV2(baseUrl, target.workspaceRoot?.trim() || undefined, {
    token: target.token,
  });
  const tree = await loadSessionTreeRecursive({
    client,
    workspaceId: target.workspaceId,
    sessionId,
    depth: 0,
    visited: new Set<string>(),
  });

  const ir = buildCanonicalTranscriptIR(tree);
  const defaultFilename = buildSessionExportFilename(tree.session);
  return { ir, defaultFilename };
}

/**
 * Persist an already-rendered Markdown string to `Downloads` (or an explicit
 * nested workspace subpath when `/export dir/file.md` was passed) and display
 * completion toast feedback.
 */
export async function savePreparedSessionMarkdown(params: {
  target: ExportSessionMarkdownTarget;
  markdown: string;
  defaultFilename: string;
}): Promise<ExportSessionMarkdownOutcome> {
  const { target, markdown, defaultFilename } = params;
  try {
    const relativeArg = target.relativeFilename?.trim() ?? "";
    const validatedRelative = relativeArg ? validateRelativeExportPath(relativeArg) : null;
    if (validatedRelative && !validatedRelative.ok) {
      throw new Error(validatedRelative.reason);
    }

    const desktop = isDesktopRuntime();
    const localWorkspaceRoot = target.workspaceRoot?.trim() ?? "";

    if (validatedRelative && validatedRelative.ok) {
      const relPath = validatedRelative.relativePath;
      const isNestedSubpath = relPath.includes("/");
      if (desktop && !isNestedSubpath) {
        const savedPath = await saveFile({
          saveToDownloads: true,
          defaultPath: relPath,
          content: markdown,
        });
        if (!savedPath) {
          return { outcome: "canceled" };
        }
        const displayPath = shortenSavedPathForToast(savedPath, localWorkspaceRoot);
        toast.success(t("session.export_markdown_saved", { path: displayPath }), {
          action: {
            label: t("session.export_markdown_reveal"),
            onClick: () => {
              void revealDesktopItemInDir(savedPath);
            },
          },
        });
        return { outcome: "saved", path: savedPath };
      }

      if (desktop && localWorkspaceRoot && isNestedSubpath) {
        const savedPath = await saveFile({
          workspaceRoot: localWorkspaceRoot,
          relativePath: relPath,
          content: markdown,
        });
        if (!savedPath) {
          return { outcome: "canceled" };
        }
        toast.success(t("session.export_markdown_saved", { path: relPath }), {
          action: {
            label: t("session.export_markdown_reveal"),
            onClick: () => {
              void revealDesktopItemInDir(savedPath);
            },
          },
        });
        return { outcome: "saved", path: savedPath };
      }

      const remoteWorkspaceId = (target.serverWorkspaceId ?? target.workspaceId).trim();
      if (isNestedSubpath && target.serverClient && remoteWorkspaceId) {
        const stat = await target.serverClient.statWorkspaceFile(remoteWorkspaceId, relPath);
        if (stat.exists) {
          throw new Error(`${relPath} already exists — pass a new filename`);
        }
        await target.serverClient.writeWorkspaceFile(remoteWorkspaceId, {
          path: relPath,
          content: markdown,
        });
        toast.success(t("session.export_markdown_saved", { path: relPath }));
        return { outcome: "saved", path: relPath };
      }

      const fallbackLeaf = relPath.split("/").pop() || defaultFilename;
      downloadTextAsFile(fallbackLeaf, markdown, "text/markdown;charset=utf-8");
      toast.success(t("session.export_markdown_saved", { path: `Downloads/${fallbackLeaf}` }));
      return { outcome: "saved", path: fallbackLeaf };
    }

    if (desktop) {
      const savedPath = await saveFile({
        saveToDownloads: true,
        defaultPath: defaultFilename,
        content: markdown,
      });
      if (!savedPath) {
        return { outcome: "canceled" };
      }
      const displayPath = shortenSavedPathForToast(savedPath, localWorkspaceRoot);
      toast.success(t("session.export_markdown_saved", { path: displayPath }), {
        action: {
          label: t("session.export_markdown_reveal"),
          onClick: () => {
            void revealDesktopItemInDir(savedPath);
          },
        },
      });
      return { outcome: "saved", path: savedPath };
    }

    downloadTextAsFile(defaultFilename, markdown, "text/markdown;charset=utf-8");
    toast.success(t("session.export_markdown_saved", { path: `Downloads/${defaultFilename}` }));
    return { outcome: "saved", path: defaultFilename };
  } catch (error) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
    const message = detail ? `${t("session.export_markdown_failed")}: ${detail}` : t("session.export_markdown_failed");
    toast.error(message);
    return { outcome: "failed", error: message };
  }
}

/**
 * Fetch the full unwindowed session transcript (including reasoning, tool
 * calls, and any nested sub-agent sessions), serialize it to Markdown under
 * `options`, and write/download the `.md` file with toast feedback.
 */
export async function exportSessionMarkdown(
  target: ExportSessionMarkdownTarget,
  options?: Partial<ExportMarkdownOptions>,
): Promise<ExportSessionMarkdownOutcome> {
  const sessionId = target.sessionId.trim();
  const baseUrl = target.opencodeBaseUrl.trim();
  if (!sessionId || !baseUrl) {
    const message = t("session.export_markdown_failed");
    toast.error(message);
    return { outcome: "failed", error: message };
  }

  try {
    const { ir, defaultFilename } = await loadExportableSessionIR(target);
    const rendered = renderTranscriptFromIR(ir, options);
    return await savePreparedSessionMarkdown({
      target,
      markdown: rendered.markdown,
      defaultFilename,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
    const message = detail ? `${t("session.export_markdown_failed")}: ${detail}` : t("session.export_markdown_failed");
    toast.error(message);
    return { outcome: "failed", error: message };
  }
}

export function useExportSessionMarkdown(target: Omit<ExportSessionMarkdownTarget, "relativeFilename">) {
  const activeSessionId = useExportSessionMarkdownStore((state) => state.activeTarget?.sessionId ?? null);
  const exporting = Boolean(activeSessionId && activeSessionId === target.sessionId);

  const runExport = useCallback(
    (relativeFilename?: string | null) => {
      openExportMarkdownModal({
        ...target,
        relativeFilename,
      });
    },
    [
      target.opencodeBaseUrl,
      target.serverClient,
      target.serverWorkspaceId,
      target.sessionId,
      target.token,
      target.workspaceId,
      target.workspaceRoot,
    ],
  );

  return { exporting, exportMarkdown: runExport };
}
