/**
 * Files a human attached to an agent (the UI / create form / message box) reach
 * the agent in TWO steps, both needed: the worker writes them to /work/uploads
 * before the turn starts, and the turn's prompt says they're there. Writing them
 * alone isn't enough — an agent never looks in a directory it wasn't told about.
 */
export const UPLOADS_DIR = "/work/uploads";

/** Of the files on disk, the ones this pod hasn't told the agent about yet. */
export function unannounced(written: string[], announced: Set<string>): string[] {
  return written.filter((n) => !announced.has(n));
}

/** The note appended to a turn's prompt for newly attached files ("" if none). */
export function attachmentNote(names: string[], dir = UPLOADS_DIR): string {
  if (!names.length) return "";
  const list = names.map((n) => `- ${dir}/${n}`).join("\n");
  return (
    `\n\n[da_boss] The human attached ${names.length === 1 ? "a file" : `${names.length} files`} for this task:\n${list}\n` +
    `Read ${names.length === 1 ? "it" : "them"} (the Read tool shows images) before you continue.`
  );
}
