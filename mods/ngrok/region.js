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

/** The start of each line in the text, and the end of the text last. */
function offsetsOf(lines) {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1) + line.length);
  return offsets;
}

/**
 * The smallest run of whole lines that holds the change, occurs exactly one time in `oldText`, and
 * holds no secret in its old or its new text. The line endings stay as they are. Between two runs
 * with the same number of lines, the run with more lines before the change wins.
 * @param {string} oldText
 * @param {string} newText
 * @param {string[]} secrets  Values that must not go into the region.
 * @returns {{ old: string, new: string }}
 */
export function editRegion(oldText, newText, secrets) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  // The equal lines at the start, and the equal lines at the end, which must not overlap them.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let tail = 0;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const aAt = offsetsOf(a);
  const bAt = offsetsOf(b);
  // The region with `before` equal lines before the change and `after` equal lines after it.
  const region = (before, after) => ({
    old: oldText.slice(aAt[start - before], aAt[a.length - tail + after]),
    new: newText.slice(bAt[start - before], bAt[b.length - tail + after]),
  });
  const unique = (before, after) => {
    const old = region(before, after).old;
    return old !== "" && once(oldText, old);
  };
  const secret = ({ old, new: next }) => secrets.some((s) => s && (old.includes(s) || next.includes(s)));

  // The fewest lines after the change that make the region unique, if `hi` lines after do.
  const fewestAfter = (before, hi) => {
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (unique(before, mid)) hi = mid;
      else lo = mid + 1;
    }
    return hi;
  };

  // A region that grows stays unique, and a region with a secret keeps it. So for each number of
  // lines before, only the fewest lines after that make the region unique can win. That number
  // never grows when the lines before grow. A region with more lines before than the best size
  // cannot win, so the search stops there.
  let best = null;
  let blocked = false;
  let after = tail + 1; // tail + 1: no unique region with these lines before.
  for (let before = 0; before <= start && (!best || before <= best.size); before++) {
    if (after > tail) {
      if (!unique(before, tail)) continue;
      after = fewestAfter(before, tail);
    } else if (after > 0 && unique(before, after - 1)) {
      after = fewestAfter(before, after - 1);
    }
    const found = region(before, after);
    if (secret(found)) blocked = true;
    // A later region has more lines before, so it wins a tie.
    else if (!best || before + after <= best.size) best = { size: before + after, found };
  }
  if (best) return best.found;
  throw new Error(blocked ? REGION_SECRET : REGION_NONE);
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
