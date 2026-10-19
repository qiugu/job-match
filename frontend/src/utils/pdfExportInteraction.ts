import type { PdfExportPhase } from "@/utils/pdfExportServer";

export type PdfExportInteractionPhase = "idle" | PdfExportPhase;

export interface PdfExportInteractionState {
  isOpen: boolean;
  phase: PdfExportInteractionPhase;
}

export type PdfExportInteractionAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "start" }
  | { type: "progress"; phase: PdfExportPhase }
  | { type: "finish"; success: boolean };

export const initialPdfExportState: PdfExportInteractionState = {
  isOpen: false,
  phase: "idle",
};

/**
 * The chooser and progress states intentionally share one body height. The
 * progress state is rendered as an overlay so the dialog never re-centers
 * while the export request is in flight.
 */
export const PDF_EXPORT_LAYOUTS = {
  chooser: { bodyHeight: 304, statusPlacement: "inline" },
  progress: { bodyHeight: 304, statusPlacement: "overlay" },
} as const;

/** The server render duration is unknown, so the UI must not imply a percentage. */
export const PDF_EXPORT_PROGRESS = {
  mode: "indeterminate",
  ariaValueNow: undefined,
} as const;

export const isPdfExporting = (state: PdfExportInteractionState): boolean =>
  state.phase !== "idle";

/**
 * Preparing the print HTML is synchronous in the browser, so it should not
 * appear as a separate user-facing step. Keep the phase for diagnostics while
 * presenting one stable generation state until the response is ready.
 */
export const getPdfExportDisplayPhase = (
  phase: PdfExportInteractionPhase
): "generating" | "downloading" =>
  phase === "downloading" ? "downloading" : "generating";

export const pdfExportInteractionReducer = (
  state: PdfExportInteractionState,
  action: PdfExportInteractionAction
): PdfExportInteractionState => {
  switch (action.type) {
    case "open":
      return { isOpen: true, phase: "idle" };
    case "close":
      return isPdfExporting(state) ? state : { ...state, isOpen: false };
    case "start":
      return isPdfExporting(state)
        ? state
        : { isOpen: true, phase: "preparing" };
    case "progress":
      return isPdfExporting(state) ? { ...state, phase: action.phase } : state;
    case "finish":
      return { isOpen: action.success ? false : state.isOpen, phase: "idle" };
    default:
      return state;
  }
};
