import { PDFDocument } from 'pdf-lib';
import { copyState, isPdf, stampLines, stampPdf } from './controlled-copy';

const twoPages = async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  pdf.addPage([842, 595]);
  return pdf.save();
};

describe('controlled copies', () => {
  it('knows a PDF by type or name', () => {
    expect(isPdf('a.PDF', null)).toBe(true);
    expect(isPdf('a.bin', 'application/pdf')).toBe(true);
    expect(isPdf('a.docx', 'application/msword')).toBe(false);
  });

  it('stamps by the revision\'s status', () => {
    expect(copyState('effective')).toBe('controlled');
    expect(copyState('superseded')).toBe('superseded');
    expect(copyState('withdrawn')).toBe('withdrawn');
    expect(copyState('approved')).toBe('not_issued');
    const [head, detail] = stampLines({ state: 'controlled', number: 'SOP-001', letter: 'B', effectiveFrom: '11 Nov 2026', printedAt: '12 Nov 2026 09:30', printedBy: 'Ann Owner' });
    expect(head).toBe('CONTROLLED COPY - SOP-001 rev B');
    expect(detail).toBe('Effective 11 Nov 2026. Printed 12 Nov 2026 09:30 by Ann Owner. Check it is still the current revision before use.');
    expect(stampLines({ state: 'superseded', number: 'SOP-001', letter: 'A', effectiveFrom: null, printedAt: 'x', printedBy: 'y' })[0]).toBe('SUPERSEDED - NOT FOR USE - SOP-001 rev A');
  });

  it('stamps every page and records the headline as the subject', async () => {
    const out = await stampPdf(await twoPages(), ['CONTROLLED COPY - SOP-001 rev B', 'Printed by Zoë Ångström'], 'controlled');
    const read = await PDFDocument.load(out);
    expect(read.getPageCount()).toBe(2);
    expect(read.getSubject()).toBe('CONTROLLED COPY - SOP-001 rev B');
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(stampPdf(new TextEncoder().encode('not a pdf'), ['a', 'b'], 'controlled')).rejects.toThrow();
  });
});
