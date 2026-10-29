import { useCallback, useRef, useState } from "react";

import { toast } from "@/components/ui/sonner";
import { revealDesktopItemInDir, saveFile } from "@/app/lib/desktop";
import { downloadTextAsFile } from "@/app/lib/download";
import { unwrap } from "@/app/lib/opencode";
import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import type { OmniRushServerClient, OmniRushSessionSnapshot } from "@/app/lib/omnirush-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import {
  buildSessionExportFilename,
  collectReferencedSubagentSessionIds,
  formatSessionAsMarkdown,
  validateRelativeExportPath,
  type ExportableSessionTree,
} from "@/app/lib/session-markdown-export";
import { t } from "@/i18n";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { snapshotKey } from "@/react-app/domains/session/sync/session-sync";

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

const MAX_SUBAGENT_DEPTH = 4;

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
 * Fetch the full unwindowed session transcript (including reasoning, tool
 * calls, and any nested sub-agent sessions), serialize it to Markdown, and
 * write/download the `.md` file with toast feedback.
 */
export async function exportSessionMarkdown(
  target: ExportSessionMarkdownTarget,
): Promise<ExportSessionMarkdownOutcome> {
  const sessionId = target.sessionId.trim();
  const baseUrl = target.opencodeBaseUrl.trim();
  if (!sessionId || !baseUrl) {
    const message = t("session.export_markdown_failed");
    toast.error(message);
    return { outcome: "failed", error: message };
  }

  try {
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

    const markdown = formatSessionAsMarkdown(tree);
    const defaultFilename = buildSessionExportFilename(tree.session);
    const desktop = isDesktopRuntime();
    const localWorkspaceRoot = target.workspaceRoot?.trim() ?? "";

    if (validatedRelative && validatedRelative.ok) {
      const relPath = validatedRelative.relativePath;
      if (desktop && localWorkspaceRoot) {
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
      if (target.serverClient && remoteWorkspaceId) {
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
      toast.success(t("session.export_markdown_saved", { path: fallbackLeaf }));
      return { outcome: "saved", path: fallbackLeaf };
    }

    if (desktop) {
      const savedPath = await saveFile({
        title: t("session.cmd_export_markdown_title"),
        defaultPath: defaultFilename,
        workspaceRoot: localWorkspaceRoot || undefined,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
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
    toast.success(t("session.export_markdown_saved", { path: defaultFilename }));
    return { outcome: "saved", path: defaultFilename };
  } catch (error) {
    const detail = error instanceof Error && error.message.trim() ? error.message.trim() : "";
    const message = detail ? `${t("session.export_markdown_failed")}: ${detail}` : t("session.export_markdown_failed");
    toast.error(message);
    return { outcome: "failed", error: message };
  }
}

export function useExportSessionMarkdown(target: Omit<ExportSessionMarkdownTarget, "relativeFilename">) {
  const [exporting, setExporting] = useState(false);
  const inFlightRef = useRef(false);

  const runExport = useCallback(
    async (relativeFilename?: string | null) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setExporting(true);
      try {
        await exportSessionMarkdown({
          ...target,
          relativeFilename,
        });
      } finally {
        inFlightRef.current = false;
        setExporting(false);
      }
    },
    [
      target.opencodeBaseUrl,
      target.serverClient,
      target.sessionId,
      target.token,
      target.workspaceId,
      target.workspaceRoot,
    ],
  );

  return { exporting, exportMarkdown: runExport };
}
