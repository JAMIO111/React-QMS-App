import { Inject, Injectable } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { ENV, type Env } from '../config/env';

/** Reads stored document files (the private document-files bucket). Tests substitute a fake. */
export abstract class DocumentFileStore {
  abstract get enabled(): boolean;
  /** The bytes of the object at `path` in the document-files bucket, or null when there is no such object. */
  abstract download(path: string): Promise<Uint8Array | null>;
}

/** Reads from Supabase Storage with the service key, after the API has checked the caller may read the revision (server side only). */
@Injectable()
export class SupabaseDocumentFileStore extends DocumentFileStore {
  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  get enabled(): boolean {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  async download(path: string): Promise<Uint8Array | null> {
    const url = `${this.env.SUPABASE_URL!.replace(/\/$/, '')}/storage/v1/object/document-files/${path.split('/').map(encodeURIComponent).join('/')}`;
    const res = await fetch(url, { headers: { apikey: this.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (res.status === 400 || res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage answered ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export type CopyState = 'controlled' | 'superseded' | 'withdrawn' | 'not_issued';

/** Whether a file is a PDF we can stamp: by type, else by name. */
export const isPdf = (fileName: string, contentType: string | null) => (contentType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(fileName);

/** The state a copy is stamped with, from the revision's status. */
export function copyState(revisionStatus: string): CopyState {
  if (revisionStatus === 'effective') return 'controlled';
  if (revisionStatus === 'superseded') return 'superseded';
  if (revisionStatus === 'withdrawn') return 'withdrawn';
  return 'not_issued';
}

/** The words on every page: a headline and a detail line. */
export function stampLines(input: {
  state: CopyState;
  number: string;
  letter: string | null;
  effectiveFrom: string | null;
  printedAt: string;
  printedBy: string;
}): [string, string] {
  const rev = input.letter ? `rev ${input.letter}` : 'draft';
  const who = `${input.number} ${rev}`;
  const printed = `Printed ${input.printedAt} by ${input.printedBy}`;
  switch (input.state) {
    case 'controlled':
      return [`CONTROLLED COPY - ${who}`, `Effective ${input.effectiveFrom ?? '-'}. ${printed}. Check it is still the current revision before use.`];
    case 'superseded':
      return [`SUPERSEDED - NOT FOR USE - ${who}`, `${printed}. A later revision is in force.`];
    case 'withdrawn':
      return [`WITHDRAWN - NOT FOR USE - ${who}`, `${printed}. This document is no longer in force.`];
    default:
      return [`NOT ISSUED - NOT FOR USE - ${who}`, `${printed}. This revision has not been approved.`];
  }
}

/** The standard PDF fonts only draw Windows-1252 text; anything else becomes "?". */
const winAnsi = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, '?');

/**
 * Stamps every page of a PDF with two lines at the top (red for "not for use"), and puts the headline in the file's subject so it can be
 * checked without reading the page. Throws when the bytes are not a PDF pdf-lib can open (an encrypted PDF, for example).
 */
export async function stampPdf(bytes: Uint8Array, lines: [string, string], state: CopyState): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  const colour = state === 'controlled' ? rgb(0.1, 0.3, 0.6) : rgb(0.75, 0.1, 0.1);
  const [head, detail] = lines.map(winAnsi);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const headSize = Math.min(10, Math.max(6, width / 70));
    const detailSize = headSize * 0.8;
    page.drawRectangle({ x: 0, y: height - headSize * 3.4, width, height: headSize * 3.4, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(head, { x: 12, y: height - headSize * 1.5, size: headSize, font, color: colour, maxWidth: width - 24 });
    page.drawText(detail, { x: 12, y: height - headSize * 2.8, size: detailSize, font: small, color: rgb(0.2, 0.2, 0.2), maxWidth: width - 24 });
  }
  pdf.setSubject(head);
  pdf.setProducer('Fortress QMS');
  return pdf.save();
}
