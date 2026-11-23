// Changes the lines of one tunnel in the text of an ngrok.yml. Each edit keeps all other lines, the
// line endings, the indent, and the quote style of a value as they were.
import { OFF_MARKER, indentOf, mapRange, parseConfig, plainLine } from "./config.js";

const DEFAULT_TUNNEL_INDENT = 4;
const DEFAULT_FIELD_INDENT = 8;

function find(text, name) {
  const lines = text.split("\n");
  const tunnel = parseConfig(text).tunnels.find((t) => t.name === name);
  if (!tunnel) throw new Error(`No tunnel with the name ${name}.`);
  return { lines, tunnel };
}

/** Put a new value in a "key: value" line, and keep the marker, the indent, the quotes, a comment, and a "\r". */
function replaceValue(line, value) {
  const m = /^((?:#herdr-off#)?\s*[A-Za-z_][\w-]*:\s*)(.*?)(\r?)$/.exec(line);
  const old = m[2];
  const quote = old.length >= 2 && (old[0] === '"' || old[0] === "'") && old.at(-1) === old[0] ? old[0] : "";
  const comment = quote ? "" : (/\s+#.*$/.exec(old)?.[0] ?? "");
  return m[1] + quote + value + quote + comment + m[3];
}

function setField(lines, tunnel, key, value) {
  for (let i = tunnel.start + 1; i < tunnel.end; i++) {
    if (new RegExp(`^${key}:`).test(plainLine(lines[i]).trim())) {
      lines[i] = replaceValue(lines[i], value);
      return;
    }
  }
  throw new Error(`The tunnel ${tunnel.name} has no field ${key}.`);
}

export function setPort(text, name, port) {
  const { lines, tunnel } = find(text, name);
  const addr = /^\d+$/.test(tunnel.addr) ? String(port)
    : /:\d+(?=\/|$)/.test(tunnel.addr) ? tunnel.addr.replace(/:\d+(?=\/|$)/, `:${port}`)
    : `${tunnel.addr}:${port}`;
  setField(lines, tunnel, "addr", addr);
  return lines.join("\n");
}

export function setHost(text, name, host) {
  const { lines, tunnel } = find(text, name);
  const key = "hostname" in tunnel.scalars ? "hostname" : "domain" in tunnel.scalars ? "domain" : null;
  if (!key) throw new Error(`The tunnel ${name} has no host field.`);
  setField(lines, tunnel, key, host);
  if (tunnel.scalars.host_header === tunnel.host) setField(lines, tunnel, "host_header", host);
  return lines.join("\n");
}

export function setOff(text, name, off) {
  const { lines, tunnel } = find(text, name);
  if (tunnel.off === off) return text;
  for (let i = tunnel.start; i < tunnel.end; i++) {
    lines[i] = off ? OFF_MARKER + lines[i] : lines[i].startsWith(OFF_MARKER) ? lines[i].slice(OFF_MARKER.length) : lines[i];
  }
  return lines.join("\n");
}

export function removeTunnel(text, name) {
  const { lines, tunnel } = find(text, name);
  lines.splice(tunnel.start, tunnel.end - tunnel.start);
  return lines.join("\n");
}

/**
 * @param {string[]} taken  More names that the new tunnel must not get, such as the names of live tunnels.
 * @returns {{ text: string, name: string }}
 */
export function addTunnel(text, host, port, taken = []) {
  const lines = text.split("\n");
  const cr = text.includes("\r\n") ? "\r" : "";
  const { tunnels } = parseConfig(text);
  const names = new Set([...tunnels.map((t) => t.name), ...taken]);
  const base = host.split(".")[0];
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}${n}`;

  const first = tunnels[0];
  const tunnelIndent = first ? indentOf(plainLine(lines[first.start])) : DEFAULT_TUNNEL_INDENT;
  const fieldLine = first ? lines.slice(first.start + 1, first.end).map(plainLine).find((l) => l.trim() && !l.trim().startsWith("#")) : null;
  const fieldIndent = fieldLine ? indentOf(fieldLine) : DEFAULT_FIELD_INDENT;
  const t = " ".repeat(tunnelIndent);
  const f = " ".repeat(fieldIndent);
  const block = [`${t}${name}:`, `${f}addr: ${port}`, `${f}proto: http`, `${f}hostname: ${host}`, `${f}host_header: ${host}`].map((l) => l + cr);

  const range = mapRange(lines);
  if (range) {
    const at = tunnels.length ? Math.max(...tunnels.map((x) => x.end)) : range.first + 1;
    lines.splice(at, 0, ...block);
  } else {
    // Keep the newline at the end of the file: put the map before the empty last element.
    const at = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    lines.splice(at, 0, "tunnels:" + cr, ...block);
  }
  return { text: lines.join("\n"), name };
}

/** An integer port from 1 to 65535, or null. */
export function parsePort(input) {
  const text = String(input).trim();
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** A lower-case host with two labels or more, or null. */
export function parseHost(input) {
  const text = String(input).trim();
  const label = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
  return new RegExp(`^${label}(?:\\.${label})+$`).test(text) ? text : null;
}
