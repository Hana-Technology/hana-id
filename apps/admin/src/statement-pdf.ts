// A statement's PDF (docs/batch-c-spec.md "Monthly statements"; D92, D93 Q14: `pdf-lib`, exact-pinned): the same view
// as the on-screen statement (console-core statementView over the stored totals), with the CSV's sha256 printed, on
// A4 landscape pages in Helvetica. Text outside the font's WinAnsi set (an app name in another script, say) is shown as
// `?`, never dropped silently into a failure; the names are also in the CSV. Deterministic: no producer or dates of its
// own (the document's dates are the statement's as_of).
import type { StatementView } from '@hana-id/console-core';
import { PDFDocument, type PDFFont, type PDFPage, StandardFonts, rgb } from 'pdf-lib';

const PAGE: [number, number] = [841.89, 595.28];
const MARGIN = 40;
const LINE = 13;

/** Printable ASCII and Latin-1 only (what the standard fonts' WinAnsi encoding takes without exceptions). */
export const pdfText = (s: string): string => s.replace(/[^\x20-\x7e\xa0-\xff]/gu, '?');

export async function statementPdf(view: StatementView, asOf: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle(pdfText(view.title));
  doc.setCreationDate(new Date(asOf));
  doc.setModificationDate(new Date(asOf));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  const need = (lines: number) => {
    if (y - lines * LINE < MARGIN) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN;
    }
  };
  const text = (s: string, x: number, f: PDFFont = font, size = 9) => page.drawText(pdfText(s), { x, y, size, font: f, color: rgb(0, 0, 0) });

  text(view.title, MARGIN, bold, 14);
  y -= LINE * 2;
  for (const [k, v] of view.header) {
    need(1);
    text(`${k}:`, MARGIN, bold);
    text(v, MARGIN + 190, font);
    y -= LINE;
  }
  y -= LINE;

  // One block per app and scope: its label, then every figure as "column: value", three to a line (never cut: the
  // values are the statement's).
  const PER_LINE = 3;
  const cellWidth = (PAGE[0] - 2 * MARGIN) / PER_LINE;
  for (const row of view.table) {
    need(1 + Math.ceil(row.cells.length / PER_LINE));
    text(row.label, MARGIN, bold);
    y -= LINE;
    for (let k = 0; k < row.cells.length; k += PER_LINE) {
      row.cells.slice(k, k + PER_LINE).forEach((c, j) => text(`${view.tableColumns[k + j]}: ${c === '' ? '-' : c}`, MARGIN + 12 + j * cellWidth, font, 8));
      y -= LINE;
    }
    y -= LINE / 2;
  }
  y -= LINE;

  for (const [k, v] of view.summary) {
    need(1);
    text(`${k}:`, MARGIN, k.startsWith('Billed') ? bold : font);
    text(v, MARGIN + 260, k.startsWith('Billed') ? bold : font);
    y -= LINE;
  }
  y -= LINE;
  for (const note of view.notes) {
    need(1);
    text(note, MARGIN, font, 8);
    y -= LINE;
  }
  return doc.save({ useObjectStreams: false });
}
