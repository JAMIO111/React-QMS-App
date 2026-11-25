/** The data given to an analysis cannot be analysed (wrong shape, a missing or non-numeric reading, too small a design). */
export class MsaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MsaInputError';
  }
}

export type WarningLevel = 'info' | 'warning';

/** Something the person should know about a result: it never stops the analysis. */
export interface MsaWarning {
  code: string;
  level: WarningLevel;
  text: string;
}
