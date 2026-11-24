// Merges the tunnels of the file with the tunnels that the ngrok agents run now.
import { parseAddr } from "./config.js";

/** Each ngrok agent takes the first free port from 4040 up for its local API. */
export const API_PORTS = Array.from({ length: 10 }, (_, i) => 4040 + i);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** True when the addr host is on this computer, so that the panel can check the port. */
export const isLocalHost = (host) => LOCAL_HOSTS.has(host);

/**
 * @typedef {{ apiPort: number, name: string, host: string, port: number | null, count: number | null, local: boolean }} LiveTunnel
 *   `count` is the number of requests (HTTP) or connections (other protocols). `local` is true when the addr is on this computer.
 * @typedef {{ program: string | null, pid: number | null }} Listener
 * @typedef {{ port: number, listening: boolean, program: string | null, pid: number | null }} Local
 * @typedef {{ key: string, name: string | null, host: string, port: number | null,
 *   state: "live" | "off" | "down" | "drift" | "outside", off: boolean, liveHost: string | null, livePort: number | null,
 *   nested: boolean, count: number | null, local: Local | null }} Row  `off` is the state in the file, so that the
 *   on/off switch follows the file. `local` is null when the panel shows no local light.
 */

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url ?? "");
  }
}

/** The tunnels in the answer of GET /api/tunnels. */
export function parseLive(json, apiPort) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  return (data?.tunnels ?? []).map((t) => {
    const url = String(t.public_url ?? "");
    const metrics = t.metrics?.[url.startsWith("http") ? "http" : "conns"];
    const addr = parseAddr(t.config?.addr ?? "");
    return {
      apiPort,
      name: String(t.name),
      host: hostOf(url),
      port: addr.port,
      count: typeof metrics?.count === "number" ? metrics.count : null,
      local: isLocalHost(addr.host),
    };
  });
}

function stateOf(tunnel, live) {
  if (!live) return tunnel.off ? "off" : "down";
  if (tunnel.off) return "drift";
  // A tunnel with no host in the file gets a random host, so only the port can differ.
  const sameHost = tunnel.host === null || tunnel.host === live.host;
  return sameHost && tunnel.port === live.port ? "live" : "drift";
}

function localOf(port, listeners) {
  const listener = listeners.get(port);
  return { port, listening: Boolean(listener), program: listener?.program ?? null, pid: listener?.pid ?? null };
}

/**
 * @param {Map<number, Listener> | null} listeners  The listening ports, or null when the panel cannot know them.
 * @returns {Row[]}
 */
export function mergeRows(tunnels, live, listeners = null) {
  const liveByName = new Map();
  for (const l of live) if (!liveByName.has(l.name)) liveByName.set(l.name, l);
  const rows = tunnels.map((t) => {
    const l = liveByName.get(t.name);
    const port = l?.port ?? t.port;
    const local = !t.off && listeners && port && isLocalHost(parseAddr(t.addr).host) ? localOf(port, listeners) : null;
    return {
      key: t.name, name: t.name, host: t.host ?? "", port: t.port, state: stateOf(t, l), off: t.off,
      liveHost: l?.host ?? null, livePort: l?.port ?? null, nested: t.nested, count: l?.count ?? null, local,
    };
  });
  const names = new Set(tunnels.map((t) => t.name));
  for (const l of live) {
    if (names.has(l.name)) continue;
    rows.push({
      key: `outside:${l.apiPort}:${l.name}`, name: null, host: l.host, port: l.port, state: "outside", off: false,
      liveHost: l.host, livePort: l.port, nested: false, count: l.count ?? null,
      local: listeners && l.local && l.port ? localOf(l.port, listeners) : null,
    });
  }
  return rows;
}

/** The API port of the agent that must run the tunnel, or null if no agent runs tunnels from the file. */
export function chooseAgent(name, tunnels, live) {
  const own = live.find((l) => l.name === name);
  if (own) return own.apiPort;
  const names = new Set(tunnels.map((t) => t.name));
  const counts = new Map();
  for (const l of live) if (names.has(l.name)) counts.set(l.apiPort, (counts.get(l.apiPort) ?? 0) + 1);
  let best = null;
  for (const [apiPort, count] of counts) if (best === null || count > counts.get(best)) best = apiPort;
  return best;
}

/**
 * The body for POST /api/tunnels. A nested field cannot go in the body, so a tunnel with one throws.
 * The body goes into the arguments of curl, which other processes can read. So a tunnel with a
 * secret field throws too.
 */
export function postBody(tunnel) {
  if (tunnel.nested) throw new Error(`The tunnel ${tunnel.name} has a nested field.`);
  if (tunnel.secret) throw new Error(`The tunnel ${tunnel.name} has a secret field.`);
  const body = { name: tunnel.name };
  for (const [key, value] of Object.entries(tunnel.scalars)) body[key] = value === "true" ? true : value === "false" ? false : value;
  return body;
}

/** A one-line message from the error answer of an agent. */
export function agentError(body) {
  try {
    const data = JSON.parse(body);
    const err = String(data?.details?.err ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
    const msg = String(data?.msg ?? "").trim();
    // The agent often repeats msg at the start of err.
    if (msg && err) return err.startsWith(msg) ? err : `${msg}: ${err}`;
    return msg || err || String(body).trim();
  } catch {
    return String(body).trim();
  }
}

/** The listening ports in the output of `ss -ltnpH`. */
export function parseSs(text) {
  const listeners = new Map();
  for (const line of text.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4) continue;
    const address = columns[3];
    const port = Number(address.slice(address.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const user = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    const listener = { program: user?.[1] ?? null, pid: user ? Number(user[2]) : null };
    // A port can listen on IPv4 and IPv6. Keep the line that names the program.
    if (!listeners.has(port) || (listeners.get(port).program === null && listener.program !== null)) listeners.set(port, listener);
  }
  return listeners;
}

/** The listening ports in the output of `lsof -nP -iTCP -sTCP:LISTEN -F pcn`. */
export function parseLsof(text) {
  const listeners = new Map();
  let pid = null;
  let program = null;
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") {
      pid = Number(value);
      program = null;
    } else if (line[0] === "c") {
      program = value;
    } else if (line[0] === "n") {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      if (Number.isInteger(port) && port > 0 && !listeners.has(port)) listeners.set(port, { program, pid });
    }
  }
  return listeners;
}

/**
 * The command that lists the listening ports, for the output of `uname -s` on the computer that runs it.
 * @param {string} os
 */
export function listenerCommand(os) {
  return os === "Darwin"
    ? { command: "lsof", args: ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], parse: parseLsof }
    : { command: "ss", args: ["-ltnpH"], parse: parseSs };
}

/** The tooltip of a local light. */
export function localTip(local) {
  if (!local.listening) return `Nothing listens on ${local.port}`;
  if (!local.program) return `A program listens on ${local.port}, but the panel cannot see which one.`;
  return local.pid === null ? `${local.program} listens on ${local.port}` : `${local.program} (pid ${local.pid}) listens on ${local.port}`;
}

/** The host without its first label. */
export function domainOf(host) {
  const dot = host.indexOf(".");
  return dot < 0 ? host : host.slice(dot + 1);
}

/** The first label of the host. */
export function shortName(host) {
  const dot = host.indexOf(".");
  return dot < 0 ? host : host.slice(0, dot);
}

/** The rows in groups by domain. A group comes in the order of its first row. */
export function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const domain = domainOf(row.host);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(row);
  }
  return [...groups].map(([domain, list]) => ({ domain, rows: list }));
}

/** The keys of the rows whose count went up since the last refresh. A lower count (an agent restart) does not count. */
export function rising(previous, rows) {
  const keys = new Set();
  for (const row of rows) {
    if (row.count !== null && previous.has(row.key) && row.count > previous.get(row.key)) keys.add(row.key);
  }
  return keys;
}

/**
 * The controls at the end of a row. The row has no room for the note and the buttons together, so
 * the buttons replace the note on the row under the pointer and on the row that asks "remove?".
 * @returns {{ note: boolean, sync: boolean, remove: "✕" | "remove?" | null }}
 */
export function controlsOf(row, { hovered, confirming, busy }) {
  if (row.state === "outside" || busy || (!hovered && !confirming)) return { note: true, sync: false, remove: null };
  // "remove?" needs the room of the sync button.
  const sync = !confirming && (row.state === "down" || row.state === "drift");
  return { note: false, sync, remove: confirming ? "remove?" : "✕" };
}
