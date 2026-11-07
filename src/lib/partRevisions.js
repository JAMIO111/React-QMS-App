/** "A" for a revision as first released, "A v2" once it has been corrected (the letter is the drawing's; the version counts corrections of our record). */
export const revisionLabel = (r) => (r.version > 1 ? `${r.revision} v${r.version}` : r.revision);

/** The same for a part summary (current revision and its version). */
export const currentRevisionLabel = (part) => (part.currentRevision ? (part.currentVersion > 1 ? `${part.currentRevision} v${part.currentVersion}` : part.currentRevision) : null);
