declare module "html2pdf.js" {
  interface Html2PdfOptions {
    margin?: number | number[];
    filename?: string;
    image?: { type?: string; quality?: number };
    html2canvas?: Record<string, unknown>;
    jsPDF?: Record<string, unknown>;
    pagebreak?: { mode?: string | string[]; before?: string; after?: string; avoid?: string };
  }

  interface Html2Pdf {
    set(opt: Html2PdfOptions): Html2Pdf;
    from(element: HTMLElement | string): Html2Pdf;
    save(): Promise<void>;
    toPdf(): Html2Pdf;
    get(key: string): Promise<unknown>;
    output(type?: string, options?: Record<string, unknown>): Promise<unknown>;
  }

  export default function html2pdf(): Html2Pdf;
}
