import { create } from "zustand";

import type { ExportSessionMarkdownTarget } from "./export-session-markdown";

type ExportSessionMarkdownModalState = {
  activeTarget: ExportSessionMarkdownTarget | null;
  requestId: number;
  openExportModal: (target: ExportSessionMarkdownTarget) => void;
  closeExportModal: () => void;
};

export const useExportSessionMarkdownStore = create<ExportSessionMarkdownModalState>((set) => ({
  activeTarget: null,
  requestId: 0,
  openExportModal: (target) =>
    set((state) => ({
      activeTarget: target,
      requestId: state.requestId + 1,
    })),
  closeExportModal: () => set({ activeTarget: null }),
}));

export function openExportMarkdownModal(target: ExportSessionMarkdownTarget): void {
  useExportSessionMarkdownStore.getState().openExportModal(target);
}

export function closeExportMarkdownModal(): void {
  useExportSessionMarkdownStore.getState().closeExportModal();
}
