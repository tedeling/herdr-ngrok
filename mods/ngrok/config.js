// Reads the tunnels from the text of an ngrok.yml (config version 2). The reader is line based,
// so that an edit can change only the lines of one tunnel and keep the rest of the file as it is.

export const OFF_MARKER = "#herdr-off#";

const VERSION_ERROR = "This panel reads only ngrok config version 2.";

/**
 * @typedef {object} FileTunnel
 * @property {string} name
 * @property {boolean} off  The block has the OFF_MARKER in front of each line.
 * @property {string | null} host  The value of hostname, or of domain if there is no hostname.
 * @property {number | null} port
 * @property {string} addr
 * @property {string} proto
 * @property {Record<string, string>} scalars  Each scalar field of the block, unquoted.
 * @property {boolean} nested  The block has a field with a map or a list.
 * @property {number} start  The index of the name line.
 * @property {number} end  The index after the last line of the block.
 */

/** The line without the OFF_MARKER and without a carriage return at the end. */
export const plainLine = (line) => (line.startsWith(OFF_MARKER) ? line.slice(OFF_MARKER.length) : line).replace(/\r$/, "");

export const indentOf = (line) => line.length - line.trimStart().length;

const isBlank = (line) => line.trim() === "";
const isComment = (line) => line.trimStart().startsWith("#");

export function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  // An unquoted value can have a comment after it.
  return v.replace(/\s+#.*$/, "");
}

/** The first and the last index of the lines in the tunnels map, or null if the file has no map. */
export function mapRange(lines) {
  const first = lines.findIndex((line) => /^tunnels:\s*$/.test(plainLine(line)));
  if (first < 0) return null;
  let end = first + 1;
  while (end < lines.length) {
    const line = plainLine(lines[end]);
    if (!isBlank(line) && indentOf(line) === 0 && !isComment(line)) break;
    end++;
  }
  return { first, end };
}

export function parseAddr(addr) {
  let rest = String(addr).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/.*$/, "");
  if (/^\d+$/.test(rest)) return { host: "localhost", port: Number(rest) };
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) return { host: rest.slice(0, colon), port: Number(rest.slice(colon + 1)) };
  return { host: rest || "localhost", port: null };
}

function versionError(lines) {
  for (const line of lines) {
    const match = /^version:\s*(.*)$/.exec(plainLine(line));
    if (match && !unquote(match[1]).startsWith("2")) return VERSION_ERROR;
  }
  return null;
}

/** @returns {{ tunnels: FileTunnel[], error: string | null }} */
export function parseConfig(text) {
  const lines = text.split("\n");
  const error = versionError(lines);
  if (error) return { tunnels: [], error };
  const range = mapRange(lines);
  if (!range) return { tunnels: [], error: null };

  /** @type {FileTunnel[]} */
  const tunnels = [];
  let tunnelIndent = -1;
  let current = null;
  let fieldIndent = -1;
  for (let i = range.first + 1; i < range.end; i++) {
    const line = plainLine(lines[i]);
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (tunnelIndent < 0 && !isComment(line)) tunnelIndent = indent;
    if (indent <= tunnelIndent) {
      current = null;
      const name = isComment(line) ? null : /^([^:#]+):\s*$/.exec(line.trim());
      if (!name) continue;
      current = { name: unquote(name[1]), off: lines[i].startsWith(OFF_MARKER), scalars: {}, nested: false, start: i, end: i + 1 };
      fieldIndent = -1;
      tunnels.push(current);
      continue;
    }
    if (!current) continue;
    current.end = i + 1;
    if (isComment(line)) continue;
    if (fieldIndent < 0) fieldIndent = indent;
    const field = indent === fieldIndent ? /^([A-Za-z_][\w-]*):(.*)$/.exec(line.trim()) : null;
    if (!field) {
      current.nested = true;
      continue;
    }
    const value = field[2].trim();
    if (value === "" || value.startsWith("[") || value.startsWith("{")) current.nested = true;
    else current.scalars[field[1]] = unquote(value);
  }

  return {
    tunnels: tunnels.map((t) => {
      const addr = t.scalars.addr ?? "";
      return {
        ...t,
        host: t.scalars.hostname ?? t.scalars.domain ?? null,
        port: addr ? parseAddr(addr).port : null,
        addr,
        proto: t.scalars.proto ?? "",
      };
    }),
    error: null,
  };
}

/** The values of the secret fields, so that a message can hide them. */
export function secretsOf(text) {
  const secrets = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(authtoken|api_key)\s*:\s*(.+)$/.exec(plainLine(line));
    if (match && unquote(match[2])) secrets.push(unquote(match[2]));
  }
  return secrets;
}

export function redact(message, secrets) {
  let text = String(message);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "<secret>");
  return text;
}
