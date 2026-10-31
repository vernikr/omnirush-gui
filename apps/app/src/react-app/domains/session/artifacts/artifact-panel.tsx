/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Download, Ellipsis, ExternalLink, FolderOpen, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";

import type { OmniRushServerClient, OmniRushWorkspaceCatalogEntry } from "@/app/lib/omnirush-server";
import { openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePlatform } from "@/react-app/kernel/platform";
import { type ArtifactPanelTab, usePanelTabStore } from "../panel/panel-tab-store";
import { captureArtifactFindShortcut, clearArtifactFindHighlights, findTextRanges, setArtifactFindHighlights } from "./artifact-find";
import "./artifact-panel.css";
import { isCollectibleArtifactTarget, openTargetFromWorkspaceFile, type BinaryData, type Data, type OpenTarget, type TextData } from "./open-target";
import { HTMLPreview, ImagePreview, MarkdownPreview, PdfPreview, PlainText, PreviewError, PreviewLoading, PreviewUnavailable } from "./preview";

const ArtifactTextEditor = lazy(() =>
  import("./artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })),
);
const ArtifactSpreadsheetEditor = lazy(() =>
  import("./artifact-spreadsheet-editor").then((module) => ({ default: module.ArtifactSpreadsheetEditor })),
);
const ArtifactCodeView = lazy(() =>
  import("./artifact-code-view").then((module) => ({ default: module.ArtifactCodeView })),
);
const WorkspaceFileTree = lazy(() =>
  import("./workspace-file-tree").then((module) => ({ default: module.WorkspaceFileTree })),
);

const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];
type ArtifactPanelProps = {
  sessionId: string;
  tab: ArtifactPanelTab;
  client: OmniRushServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
};

type ArtifactPanelViewProps = {
  sessionId: string;
  client: OmniRushServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  onClose: () => void;
};

type ArtifactQueryState =
  | (TextData & { updatedAt: number | null })
  | (BinaryData & { contentType: string | null; updatedAt: number | null });

type SaveArtifactInput = Data & { baseUpdatedAt: number | null };

function absoluteWorkspacePath(root: string, path: string) {
  const cleanRoot = root.trim().replace(/[/\\]+$/, "");
  const cleanPath = path.trim().replace(/^\.\//, "");
  
  return cleanRoot ? `${cleanRoot}/${cleanPath}` : cleanPath;
}

/**
 * The address shown next to the file name in the panel header.
 *
 * A name alone hides where the file lives, so the workspace path is shown in
 * full (and in a tooltip, since the row truncates). A file directly at the
 * workspace root has nothing to add: showing its own name twice reads as a
 * rendering bug.
 */
export function artifactHeaderPath(target: OpenTarget): string {
  const path = target.value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (target.kind !== "file") return path;
  return path === target.name ? "" : path;
}

function isTextContent(target: OpenTarget): boolean {
  return ["markdown", "code", "text", "sheet", "html"].includes(target.preview) && !/\.(xlsx|xls|ods)$/i.test(target.value);
}

export function ArtifactPanel({ sessionId, tab, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, onClose }: ArtifactPanelProps) {
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId] ?? EMPTY_TRANSCRIPT_TARGETS);
  const artifactTargets = useMemo(() => transcriptTargets.filter(isCollectibleArtifactTarget), [transcriptTargets]);
  const target = tab.target ?? artifactTargets.find((item) => item.id === tab.id) ?? null;

  if (!target || !client || !workspaceId) {
    return null;
  }

  return (
    <ArtifactPanelView
      sessionId={sessionId}
      client={client}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      isRemoteWorkspace={isRemoteWorkspace}
      target={target}
      onClose={onClose}
    />
  );
}

function ArtifactPanelView({ sessionId, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, target, onClose }: ArtifactPanelViewProps) {
  const platform = usePlatform();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const treeWidthRef = useRef(160);
  const [draft, setDraft] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findMatchIndex, setFindMatchIndex] = useState(0);
  const previewContentRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const lastSyncedRef = useRef<string | null>(null);
  const failedDraftRef = useRef<string | null>(null);
  const isMermaidArtifact = target.kind === "file" && /\.mmd$/i.test(target.value);
  const panelPath = artifactHeaderPath(target);
  // Plain text opens directly in CodeMirror. Markdown and HTML default to
  // their rendered previews and retain the existing Edit toggle.
  const isDirectTextEdit = isTextContent(target) && target.preview === "text";
  const isDirectCodeEdit = target.kind === "file" && target.preview === "code";
  const canUseDesktopWorkspaceActions = !isRemoteWorkspace && platform.capabilities.revealInFileManager;
  const canUseDesktopFileActions = target.kind === "file" && canUseDesktopWorkspaceActions;
  const workspaceName = workspaceRoot.split(/[/\\]/).filter(Boolean).pop() ?? "Workspace";

  const omniRushspaceFile = (entry: { path: string; size: number; mtimeMs: number }) => {
    const nextTarget = openTargetFromWorkspaceFile(entry.path, { size: entry.size, updatedAt: entry.mtimeMs });
    if (!nextTarget) return;
    usePanelTabStore.getState().openTab(sessionId, {
      id: nextTarget.id,
      type: "artifact",
      label: nextTarget.name,
      preview: nextTarget.preview,
      target: nextTarget,
    });
  };

  const { data, error, isError, isLoading } = useQuery<ArtifactQueryState>({
    queryKey: ["artifact-panel", workspaceId, target.id, target.updatedAt ?? null] as const,
    queryFn: async () => {
      if (target.kind === "url") {
        throw new Error("URLs open in browser tabs.");
      }
      else if (target.exists === false) {
        throw new Error("File not found in this workspace.");
      }

      if (isTextContent(target)) {
        const result = await client.readWorkspaceFile(workspaceId, target.value);

        return { kind: "text", data: result.content, updatedAt: result.updatedAt ?? null };
      }

      const result = await client.downloadWorkspaceFile(workspaceId, target.value);

      return { kind: "binary", data: result.data, contentType: result.contentType, updatedAt: target.updatedAt ?? null };
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const [binaryObjectUrl, setBinaryObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.kind !== "binary") {
      setBinaryObjectUrl(null);

      return;
    }

    const fallbackType = target.preview === "pdf" ? "application/pdf" : "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.data], { type: data.contentType ?? fallbackType }));

    setBinaryObjectUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [data, target.preview]);

  useEffect(() => {
    setEditing(false);
    setDraft("");
    setFindOpen(false);
    setFindQuery("");
    setFindMatchIndex(0);
    setFindMatchCount(0);
    clearArtifactFindHighlights();
    lastSyncedRef.current = null;
    failedDraftRef.current = null;
  }, [target.id, workspaceId]);

  useEffect(() => {
    if (data?.kind === "text" && data.data !== lastSyncedRef.current) {
      lastSyncedRef.current = data.data;
      setDraft(data.data);
    }
  }, [data]);

  const { mutate, mutateAsync, isPending: isSaving } = useMutation({
    mutationFn: async (input: SaveArtifactInput) => {
      if (target.kind !== "file") {
        throw new Error("Cannot save non-file artifact.");
      }

      if (input.kind === "text") {
        return client.writeWorkspaceFile(workspaceId, { path: target.value, content: input.data, baseUpdatedAt: input.baseUpdatedAt });
      }

      return client.writeWorkspaceBinaryFile(workspaceId, { path: target.value, data: input.data, baseUpdatedAt: input.baseUpdatedAt });
    },
    onSuccess: (result, input) => {
      queryClient.setQueryData<ArtifactQueryState>(
        ["artifact-panel", workspaceId, target.id, target.updatedAt ?? null] as const,
        input.kind === "text"
          ? { kind: "text", data: input.data, updatedAt: result.updatedAt ?? null }
          : { kind: "binary", data: input.data, contentType: data?.kind === "binary" ? data.contentType : null, updatedAt: result.updatedAt ?? null },
      );

      if (input.kind === "text") {
        lastSyncedRef.current = input.data;
        failedDraftRef.current = null;
      }
    },
    onError: (cause, input) => {
      if (input.kind === "text") {
        failedDraftRef.current = input.data;
      }

      toast.error(cause instanceof Error ? cause.message : "Could not save changes.");
    },
  });

  const downloadFile = async (path: string, name: string) => {
    const result = await client.downloadWorkspaceFile(workspaceId, path);
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = name;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openFileExternally = async (path: string) => {
    if (isRemoteWorkspace) {
      await downloadFile(path, path.split(/[/\\]/).pop() ?? path);

      return;
    }

    try {
      await openDesktopPath(absoluteWorkspacePath(workspaceRoot, path));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not open this file.");
    }
  };

  const revealFile = async (path: string) => {
    if (isRemoteWorkspace) return;
    try {
      await revealDesktopItemInDir(absoluteWorkspacePath(workspaceRoot, path));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not show this file in your file manager.");
    }
  };

  const download = async () => {
    if (target.kind === "url") {
      return;
    }

    await downloadFile(target.value, target.name);
  };

  const openExternal = async () => {
    if (target.kind === "url") {
      window.open(target.value, "_blank", "noopener,noreferrer");

      return;
    }

    await openFileExternally(target.value);
  };

  const revealExternal = async () => {
    if (target.kind !== "file") return;
    await revealFile(target.value);
  };

  const isTextEditing = data?.kind === "text" && (editing || isDirectTextEdit);
  const isEditingSurface = data?.kind === "text" && (editing || isDirectTextEdit || isDirectCodeEdit);
  const isDirty = data?.kind === "text" && draft !== data.data;
  const canFind = data?.kind === "text" && target.preview === "markdown" && !isEditingSurface;

  useEffect(() => {
    if (!canFind) {
      setFindOpen(false);
      clearArtifactFindHighlights();
      return;
    }

    const handleFindShortcut = (event: KeyboardEvent) => {
      const panel = previewContentRef.current?.closest<HTMLElement>("[data-artifact-panel]");
      if (!panel) return;
      captureArtifactFindShortcut(event, panel, platform.os === "macos", () => setFindOpen(true));
    };

    window.addEventListener("keydown", handleFindShortcut, true);
    return () => window.removeEventListener("keydown", handleFindShortcut, true);
  }, [canFind, platform.os]);

  useEffect(() => {
    if (!canFind || !findOpen || !findQuery.trim() || !previewContentRef.current) {
      clearArtifactFindHighlights();
      setFindMatchCount(0);
      return;
    }

    const ranges = findTextRanges(previewContentRef.current, findQuery);
    setFindMatchCount(ranges.length);
    setFindMatchIndex((current) => (ranges.length ? Math.min(current, ranges.length - 1) : 0));
    setArtifactFindHighlights(ranges, findMatchIndex);
    const activeIndex = ranges.length ? ((findMatchIndex % ranges.length) + ranges.length) % ranges.length : -1;
    ranges[activeIndex]?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });

    return () => clearArtifactFindHighlights();
  }, [canFind, findOpen, findQuery, findMatchIndex, data?.data]);

  useEffect(() => {
    if (findOpen) {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }
  }, [findOpen]);

  useEffect(() => {
    if (
      target.kind !== "file" ||
      data?.kind !== "text" ||
      !(editing || isDirectTextEdit || isDirectCodeEdit) ||
      isSaving ||
      draft === data.data ||
      draft === failedDraftRef.current
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      mutate({ kind: "text", data: draft, baseUpdatedAt: data.updatedAt });
    }, 600);

    return () => window.clearTimeout(timer);
  }, [draft, data, editing, isDirectTextEdit, isDirectCodeEdit, isSaving, target.kind, mutate]);

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
    setFindMatchIndex(0);
    window.requestAnimationFrame(() => findButtonRef.current?.focus());
  };
  const stepFindMatch = (direction: number) => {
    if (!findMatchCount) return;
    setFindMatchIndex((current) => (current + direction + findMatchCount) % findMatchCount);
  };

  const saveSpreadsheetContent = async (payload: Data) => {
    if (target.kind !== "file") {
      return;
    }

    await mutateAsync({
      ...payload,
      baseUpdatedAt: data?.kind === payload.kind ? data.updatedAt : target.updatedAt ?? null,
    });
  };

  return (
    <div data-artifact-panel="" className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        <div className="flex h-10 items-center gap-2 pe-2 ps-2">
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={() => setTreeOpen((value) => !value)} aria-label={treeOpen ? "Hide workspace files" : "Show workspace files"}>
                  {treeOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
                </Button>
              )}
            />
            <TooltipContent>{treeOpen ? "Hide workspace files" : "Show workspace files"}</TooltipContent>
          </Tooltip>
          <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
            <h3 className="max-w-[55%] shrink-0 truncate text-sm font-medium text-foreground">
              {target.name}
            </h3>
            {/* The tab only has room for the basename; the address keeps the
                workspace path so a file read from a nested folder is identifiable. */}
            {panelPath ? (
              <span
                data-artifact-path=""
                className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                title={panelPath}
              >
                {panelPath}
              </span>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground">
              {target.exists === false ? "missing" : isEditingSurface ? (isSaving || isDirty ? "Saving\u2026" : "Saved") : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {isTextContent(target) && data?.kind === "text" && !isDirectTextEdit && !isDirectCodeEdit ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button variant="ghost" size="sm" onClick={() => setEditing((value) => !value)}>{editing ? "Done" : "Edit"}</Button>
                  )}
                />
                <TooltipContent>{editing ? "Stop editing" : "Edit artifact"}</TooltipContent>
              </Tooltip>
            ) : null}
            {canFind ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button ref={findButtonRef} variant="ghost" size="icon-sm" onClick={() => setFindOpen(true)} aria-label="Find in document">
                      <Search />
                    </Button>
                  )}
                />
                <TooltipContent>Find in document (⌘F / Ctrl+F)</TooltipContent>
              </Tooltip>
            ) : null}
            {target.kind === "file" || target.kind === "url" ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={(
                    <Button variant="ghost" size="icon-sm" aria-label="Artifact actions">
                      <Ellipsis />
                    </Button>
                  )}
                />
                <DropdownMenuContent align="end">
                  {target.kind === "file" ? (
                    <DropdownMenuItem onClick={() => void download()}>
                      <Download /> Download
                    </DropdownMenuItem>
                  ) : null}
                  {canUseDesktopFileActions ? (
                    <DropdownMenuItem onClick={() => void revealExternal()}>
                      <FolderOpen /> Show in folder
                    </DropdownMenuItem>
                  ) : null}
                  {target.kind === "url" || canUseDesktopFileActions ? (
                    <DropdownMenuItem onClick={() => void openExternal()}>
                      <ExternalLink /> Open externally
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close artifact">
                    <X />
                  </Button>
                )}
              />
              <TooltipContent>Close artifact</TooltipContent>
            </Tooltip>
          </div>
        </div>
        {findOpen ? (
          <div className="flex h-9 items-center gap-1 border-t border-border/70 px-2" data-artifact-find-ui="">
            <Search className="ms-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={findInputRef}
              type="search"
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.currentTarget.value);
                setFindMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeFind();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  stepFindMatch(event.shiftKey ? -1 : 1);
                }
              }}
              placeholder="Find in document"
              aria-label="Find in document"
              className="h-7 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground" aria-live="polite">
              {findMatchCount ? `${findMatchIndex + 1} / ${findMatchCount}` : findQuery ? "No matches" : "0 / 0"}
            </span>
            <Button variant="ghost" size="icon-sm" onClick={() => stepFindMatch(-1)} disabled={!findMatchCount} aria-label="Previous match">
              <ChevronUp />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => stepFindMatch(1)} disabled={!findMatchCount} aria-label="Next match">
              <ChevronDown />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={closeFind} aria-label="Close find">
              <X />
            </Button>
          </div>
        ) : null}
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 overflow-hidden">
        {treeOpen ? (
          <>
          <ResizablePanel id="artifact-file-tree" defaultSize={`${treeWidthRef.current}px`} minSize="100px" maxSize="65%" groupResizeBehavior="preserve-pixel-size" onResize={(size) => { if (size.inPixels >= 100) treeWidthRef.current = size.inPixels; }} className="min-h-0 min-w-0">
          <Suspense fallback={<div className="h-full w-full bg-muted/20" />}>
            <WorkspaceFileTree
              client={client}
              workspaceId={workspaceId}
              workspaceName={workspaceName}
              selectedPath={target.value}
              onOpenFile={omniRushspaceFile}
              fileActions={[
                { id: "download", label: "Download", run: (entry) => void downloadFile(entry.path, entry.path.split(/[/\\]/).pop() ?? entry.path) },
                ...(canUseDesktopWorkspaceActions
                  ? [
                    { id: "reveal", label: "Show in folder", run: (entry: OmniRushWorkspaceCatalogEntry) => void revealFile(entry.path) },
                    { id: "open-external", label: "Open externally", run: (entry: OmniRushWorkspaceCatalogEntry) => void openFileExternally(entry.path) },
                  ]
                  : []),
              ]}
            />
          </Suspense>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize workspace file tree" />
          </>
        ) : null}
        <ResizablePanel id="artifact-preview" minSize="120px" className="min-w-0">
        <div ref={previewContentRef} className="h-full min-w-0 overflow-hidden">
          {isLoading || (data?.kind === "binary" && !binaryObjectUrl) ? (
          <PreviewLoading />
        ) : isError ? (
          <PreviewError message={error instanceof Error ? error.message : "Failed to load artifact" } />
        ) : data?.kind === "text" && (editing || isDirectTextEdit) ? (
          <TextEditor value={draft} language={target.preview === "markdown" ? "markdown" : "text"} onChange={setDraft} />
        ) : target.preview === "markdown" && data?.kind === "text" ? (
          <MarkdownPreview content={data.data} mermaidSource={isMermaidArtifact} />
        ) : target.preview === "code" && data?.kind === "text" ? (
          <Suspense fallback={<PreviewLoading />}>
            <ArtifactCodeView
              name={target.name}
              path={target.value}
              content={data.data}
              editable={isDirectCodeEdit}
              onChange={setDraft}
            />
          </Suspense>
        ) : target.preview === "sheet" ? (
          <SheetEditor
            name={target.name}
            content={data ?? { kind: "binary", data: new ArrayBuffer(0) }}
            saving={isSaving}
            onSave={saveSpreadsheetContent}
          />
        ) : target.preview === "html" && data?.kind === "text" ? (
          <HTMLPreview type="text" title={target.name} content={data.data} />
        ) : target.preview === "image" && data?.kind === "binary" && binaryObjectUrl ? (
          <ImagePreview src={binaryObjectUrl} alt={target.name} />
        ) : target.preview === "pdf" && data?.kind === "binary" && binaryObjectUrl ? (
          <PdfPreview url={binaryObjectUrl} title={target.name} />
        ) : data?.kind === "binary" && binaryObjectUrl && target.preview === "html" ? (
          <HTMLPreview type="binary" title={target.name} url={binaryObjectUrl} />
        ) : data?.kind === "text" ? (
          <PlainText content={data.data} />
        ) : (
          <PreviewUnavailable />
          )}
        </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

interface TextEditorProps extends React.ComponentProps<typeof ArtifactTextEditor> {
  value: string;
  language: "markdown" | "text";
  onChange: (value: string) => void;
}

function TextEditor({ value, language, onChange, ...props }: TextEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactTextEditor value={value} language={language} onChange={onChange} {...props} />
    </Suspense>
  );
}

interface SheetEditorProps extends React.ComponentProps<typeof ArtifactSpreadsheetEditor> {
  
}

function SheetEditor({ className, ...props }: SheetEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactSpreadsheetEditor
        className={className}
        {...props}
      />
    </Suspense>
  );
}
