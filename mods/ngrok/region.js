// Writes a change to ngrok.yml on the hub. `writeTextFile` works only on this computer, so the panel
// sends the changed lines with `hc file edit`. This file does not import "herdr", so that node can test it.
import { secretsOf } from "./config.js";
import { hubError } from "./hub.js";

export const REGION_SECRET = "The change touches a line with a secret. Edit ngrok.yml on the hub by hand.";
export const REGION_NONE = "The panel cannot find a unique place for this change.";

/** The lines of the text, each with its line ending. */
const linesOf = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** True when `part` occurs exactly one time in `text`, also with overlaps. */
function once(text, part) {
  const first = text.indexOf(part);
  return first >= 0 && text.indexOf(part, first + 1) < 0;
}

/**
 * The smallest run of whole lines that holds the change and occurs exactly one time in `oldText`.
 * It starts from the first and the last line that differ, and it adds one line at a time on each
 * side that has lines left. The line endings stay as they are.
 * @param {string} oldText
 * @param {string} newText
 * @param {string[]} secrets  Values that must not go into the region.
 * @returns {{ old: string, new: string }}
 */
export function editRegion(oldText, newText, secrets) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // The number of equal lines at the end, which must not overlap the equal lines at the start.
  let tail = 0;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const region = () => ({ old: a.slice(start, a.length - tail).join(""), new: b.slice(start, b.length - tail).join("") });
  let found = region();
  while (found.old === "" || !once(oldText, found.old)) {
    if (start === 0 && tail === 0) throw new Error(REGION_NONE);
    if (start > 0) start--;
    if (tail > 0) tail--;
    found = region();
  }
  if (secrets.some((secret) => secret && (found.old.includes(secret) || found.new.includes(secret)))) throw new Error(REGION_SECRET);
  return found;
}

/** An error that the panel shows as it is. */
const shown = (message) => Object.assign(new Error(message), { hub: true });

/** The error message in the output of `hc --json`, or null. */
function hcError(text) {
  try {
    return JSON.parse(text)?.error ?? null;
  } catch {
    return null;
  }
}

/**
 * Replaces `expected` with `text` in the file at `path` on the hub, with `hc file edit`. That call
 * replaces the file atomically and keeps its mode.
 *
 * It rejects with an error with no `hub` field when the old lines are not in the file (a stale
 * file). Each other failure rejects with an error whose `hub` field is true.
 * @param {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} hc
 * @param {{ mode: "remote", machine: string, hub: string }} target
 * @param {string} path
 * @param {string} text
 * @param {string} expected
 */
export async function editOnHub(hc, target, path, text, expected) {
  let region;
  try {
    region = editRegion(expected, text, [...secretsOf(expected), ...secretsOf(text)]);
  } catch (e) {
    throw shown(e.message);
  }
  // The form --old=<text> keeps a text that starts with "-" as one value. As a separate argument,
  // hc reads such a text as a flag and stops with a usage error.
  const args = ["file", "edit", "--json", "--on", target.machine, path, `--old=${region.old}`, `--new=${region.new}`];
  let result;
  try {
    result = await hc(args);
  } catch (e) {
    throw shown(hubError(target, String(e?.message ?? e)));
  }
  if (result.code === 0) return;
  const error = hcError(result.stdout) ?? hcError(result.stderr);
  if (result.code === 1 && error?.kind === "edit_failed") throw new Error(error.message ?? "edit_failed");
  const reason = error?.message ?? (result.stderr.trim() || result.stdout.trim() || `hc exit ${result.code}`);
  throw shown(hubError(target, reason));
}
