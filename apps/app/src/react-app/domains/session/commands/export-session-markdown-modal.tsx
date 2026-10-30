/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { DEFAULT_EXPORT_MARKDOWN_OPTIONS, renderTranscriptFromIR, type CompressionMode } from "@/app/lib/session-markdown-export";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  formatEstimatedTokenCount,
  formatExportByteSize,
  loadExportableSessionIR,
  savePreparedSessionMarkdown,
  type LoadedExportSessionData,
} from "./export-session-markdown";
import { useExportSessionMarkdownStore } from "./export-session-markdown-store";

type ActiveCompressionVariant = Exclude<CompressionMode, "off">;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: LoadedExportSessionData }
  | { kind: "error"; message: string };

export function ExportSessionMarkdownModal() {
  const activeTarget = useExportSessionMarkdownStore((state) => state.activeTarget);
  const requestId = useExportSessionMarkdownStore((state) => state.requestId);
  const closeExportModal = useExportSessionMarkdownStore((state) => state.closeExportModal);

  const [includeToolCalls, setIncludeToolCalls] = useState<boolean>(
    DEFAULT_EXPORT_MARKDOWN_OPTIONS.includeToolCalls,
  );
  const [includeReasoning, setIncludeReasoning] = useState<boolean>(
    DEFAULT_EXPORT_MARKDOWN_OPTIONS.includeReasoning,
  );
  const [compressOutput, setCompressOutput] = useState<boolean>(
    DEFAULT_EXPORT_MARKDOWN_OPTIONS.compression !== "off",
  );
  const [compressionVariant, setCompressionVariant] = useState<ActiveCompressionVariant>("lossless");
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);

  // Reset all 3 checkboxes to enabled defaults whenever a new export modal session opens.
  useEffect(() => {
    if (!activeTarget) return;
    setIncludeToolCalls(true);
    setIncludeReasoning(true);
    setCompressOutput(true);
    setCompressionVariant("lossless");
    setSaving(false);
  }, [activeTarget, requestId]);

  useEffect(() => {
    if (!activeTarget) return;
    let cancelled = false;
    setLoadState({ kind: "loading" });

    loadExportableSessionIR(activeTarget)
      .then((data) => {
        if (!cancelled) {
          setLoadState({ kind: "ready", data });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const detail =
            error instanceof Error && error.message.trim()
              ? error.message.trim()
              : t("session.export_markdown_failed");
          setLoadState({ kind: "error", message: detail });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeTarget, requestId, retryCount]);

  const effectiveCompression: CompressionMode = compressOutput ? compressionVariant : "off";

  const preview = useMemo(() => {
    if (loadState.kind !== "ready") return null;
    return renderTranscriptFromIR(loadState.data.ir, {
      includeToolCalls,
      includeReasoning,
      compression: effectiveCompression,
    });
  }, [effectiveCompression, includeReasoning, includeToolCalls, loadState]);

  const open = activeTarget !== null;

  const handleConfirm = async () => {
    if (!activeTarget || loadState.kind !== "ready" || !preview || saving) return;
    setSaving(true);
    try {
      const outcome = await savePreparedSessionMarkdown({
        target: activeTarget,
        markdown: preview.markdown,
        defaultFilename: loadState.data.defaultFilename,
      });
      if (outcome.outcome === "saved") {
        closeExportModal();
      }
    } finally {
      setSaving(false);
    }
  };

  const variantDescription =
    compressionVariant === "lossless"
      ? t("session.export_mode_lossless_desc")
      : compressionVariant === "smart"
        ? t("session.export_mode_smart_desc")
        : t("session.export_mode_stubs_desc");

  const savedPercent =
    preview && preview.savedBytes > 0
      ? Math.max(1, Math.round(preview.savedRatio * 100))
      : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) {
          closeExportModal();
        }
      }}
    >
      <DialogContent className="max-w-md gap-5" data-testid="export-markdown-modal">
        <DialogHeader>
          <DialogTitle>{t("session.cmd_export_markdown_title")}</DialogTitle>
          <DialogDescription>{t("session.export_modal_description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2.5">
          <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/20 p-3 transition-colors hover:bg-muted/35">
            <Checkbox
              id="export-opt-tool-calls-input"
              checked={includeToolCalls}
              onCheckedChange={(checked) => setIncludeToolCalls(checked === true)}
              nativeButton
              render={<button type="button" />}
              className="mt-0.5"
              data-testid="export-opt-tool-calls"
            />
            <label htmlFor="export-opt-tool-calls-input" className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-[13px] font-medium text-foreground">
                {t("session.export_opt_tool_calls")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("session.export_opt_tool_calls_hint")}
              </span>
            </label>
          </div>

          <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/20 p-3 transition-colors hover:bg-muted/35">
            <Checkbox
              id="export-opt-reasoning-input"
              checked={includeReasoning}
              onCheckedChange={(checked) => setIncludeReasoning(checked === true)}
              nativeButton
              render={<button type="button" />}
              className="mt-0.5"
              data-testid="export-opt-reasoning"
            />
            <label htmlFor="export-opt-reasoning-input" className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-[13px] font-medium text-foreground">
                {t("session.export_opt_reasoning")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("session.export_opt_reasoning_hint")}
              </span>
            </label>
          </div>

          <div className="rounded-2xl border border-border/70 bg-muted/20 p-3 transition-colors">
            <div className="flex items-start gap-3">
              <Checkbox
                id="export-opt-compress-input"
                checked={compressOutput}
                onCheckedChange={(checked) => setCompressOutput(checked === true)}
                nativeButton
                render={<button type="button" />}
                className="mt-0.5"
                data-testid="export-opt-compress"
              />
              <label htmlFor="export-opt-compress-input" className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-[13px] font-medium text-foreground">
                  {t("session.export_opt_compress")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t("session.export_opt_compress_hint")}
                </span>
              </label>
            </div>

            {compressOutput ? (
              <div
                className={cn(
                  "mt-3 flex flex-col gap-2 border-t border-border/60 pt-3",
                  !includeToolCalls && "pointer-events-none opacity-50",
                )}
              >
                <div
                  role="radiogroup"
                  aria-label={t("session.export_opt_compress")}
                  className="grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1"
                >
                  {(
                    [
                      { value: "lossless", label: t("session.export_mode_lossless") },
                      { value: "smart", label: t("session.export_mode_smart") },
                      { value: "stubs", label: t("session.export_mode_stubs") },
                    ] as const
                  ).map((item) => {
                    const selected = compressionVariant === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={!includeToolCalls}
                        data-testid={`export-mode-${item.value}`}
                        onClick={() => setCompressionVariant(item.value)}
                        className={cn(
                          "rounded-lg px-2 py-1.5 text-center text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          selected
                            ? "bg-background text-foreground shadow-xs"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11.5px] leading-snug text-muted-foreground">
                  {variantDescription}
                </p>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-secondary/40 px-3.5 py-2.5"
          data-testid="export-markdown-size-card"
        >
          {loadState.kind === "loading" ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span>{t("session.export_size_loading")}</span>
            </div>
          ) : loadState.kind === "error" ? (
            <div className="flex w-full items-center justify-between gap-2">
              <span className="min-w-0 flex-1 truncate text-xs text-destructive">
                {loadState.message}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRetryCount((n) => n + 1)}
                data-testid="export-markdown-retry"
              >
                {t("session.export_retry")}
              </Button>
            </div>
          ) : preview ? (
            <>
              <div className="min-w-0">
                <div className="text-xs font-medium text-foreground">
                  {t("session.export_size_label")}
                </div>
                <div
                  className="text-[11.5px] text-muted-foreground tabular-nums"
                  data-testid="export-markdown-live-tokens"
                >
                  {t("session.export_size_tokens", {
                    tokens: formatEstimatedTokenCount(preview.estimatedTokens),
                  })}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div
                  className="text-sm font-semibold text-foreground"
                  data-testid="export-markdown-live-size"
                >
                  {formatExportByteSize(preview.utf8Bytes)}
                </div>
                {savedPercent > 0 ? (
                  <div
                    className="text-[11.5px] font-medium text-emerald-600 dark:text-emerald-400"
                    data-testid="export-markdown-live-savings"
                  >
                    {t("session.export_size_saved", {
                      percent: String(savedPercent),
                      baseline: formatExportByteSize(preview.baselineBytes),
                    })}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => closeExportModal()}
            data-testid="export-markdown-cancel"
          >
            {t("session.export_cancel")}
          </Button>
          <Button
            disabled={loadState.kind !== "ready" || !preview || saving}
            onClick={() => void handleConfirm()}
            data-testid="export-markdown-confirm"
          >
            {saving ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 size-4" />
            )}
            {t("session.export_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
