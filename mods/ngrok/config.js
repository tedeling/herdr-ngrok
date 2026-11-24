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

// A key is secret if its name is api_key, or if its name holds one of these words.
const SECRET_KEY = /^api_key$|auth|token|secret|password/i;
// These bare values are not secrets, for example `inspect: true`. A quoted value always counts.
const NOT_SECRET = /^(true|false|null|~|[-+]?\d+(\.\d+)?)$/i;
// The indicator of a block scalar, such as `|`, `>-`, or `|2+`, with an optional comment.
const BLOCK_SCALAR = /^[|>][-+0-9]*(\s+#.*)?$/;
const FIELD = /^["']?([A-Za-z_][\w.-]*)["']?\s*:(?:\s+(.*))?$/;

/**
 * The values of the secret fields, so that a message can hide them and an edit can stay away from
 * them. A secret field is a key that SECRET_KEY matches. These parts of its value count:
 * - a value on the line of the key, and each item of an inline list (`["user:pass"]`);
 * - each item of a block list under it, also at the indent of the key (`- "user:pass"`);
 * - a value on the lines under it;
 * - each line of a block scalar (`|` or `>`), but not the indicator.
 */
export function secretsOf(text) {
  const secrets = [];
  const add = (raw) => {
    const value = unquote(raw);
    const bare = !/^["']/.test(raw.trim());
    if (value && !(bare && NOT_SECRET.test(value))) secrets.push(value);
  };
  /** The secret keys whose value block the loop reads now, the innermost last. @type {{ indent: number, scalar: boolean }[]} */
  const open = [];
  for (const raw of text.split("\n")) {
    const line = plainLine(raw);
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    const body = line.trim();
    const item = /^-(?:\s+(.*))?$/.exec(body);
    // A block ends at a line with no more indent than its key. A list item at the indent of the key
    // still belongs to the key (YAML allows an indentless list).
    while (open.length && !(indent > open.at(-1).indent || (indent === open.at(-1).indent && item && !open.at(-1).scalar))) open.pop();
    const inside = open.at(-1);
    if (inside?.scalar) {
      // Each line of a block scalar is text, also a line that looks like a comment.
      secrets.push(body);
      continue;
    }
    if (isComment(line)) continue;
    if (inside && item) {
      if (item[1]) add(item[1]);
      continue;
    }
    const field = FIELD.exec(body);
    if (!field) {
      // A value on the lines under a secret key.
      if (inside) add(body);
      continue;
    }
    if (!SECRET_KEY.test(field[1])) continue;
    const value = (field[2] ?? "").trim();
    if (value === "" || value.startsWith("#")) open.push({ indent, scalar: false });
    else if (BLOCK_SCALAR.test(value)) open.push({ indent, scalar: true });
    else if (value.startsWith("[")) value.replace(/\]\s+#.*$/, "]").replace(/^\[|\]$/g, "").split(",").forEach(add);
    else add(value);
  }
  return secrets;
}

export function redact(message, secrets) {
  let text = String(message);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "<secret>");
  return text;
}
