// Applies one tunnel edit: first to ngrok.yml, then to the running agent. If the check of the file or
// the agent rejects the change, the panel undoes it, so that the file never keeps a change that fails.
import { parseConfig, redact, secretsOf } from "./config.js";
import { addTunnel, removeTunnel, setHost, setOff, setPort } from "./edit.js";
import { chooseAgent, postBody } from "./state.js";

export const STALE = "The file changed outside the panel. The panel read it again.";
export const DUPLICATE_HOST = "Another tunnel uses this host.";
export const NESTED = "Restart ngrok to apply this change.";
export const NO_AGENT = "No ngrok agent runs the tunnels from the config.";
const UNDO_FAILED = "The panel could not undo the change in the file.";
const DOWN = "The tunnel is down. Restart ngrok to start it again.";
export const PROBE_PREFIX = "herdr-probe-";

/**
 * @typedef {import("./state.js").LiveTunnel} LiveTunnel
 * @typedef {{ read(): Promise<string>, write(text: string, expected: string): Promise<void>, check(): Promise<string | null>,
 *   live(): Promise<LiveTunnel[]>, start(apiPort: number, body: object): Promise<string | null>,
 *   stop(apiPort: number, name: string): Promise<string | null> }} Io
 * @typedef {{ kind: "port", name: string, port: number } | { kind: "host", name: string, host: string }
 *   | { kind: "off" | "on" | "remove" | "sync", name: string } | { kind: "add", host: string, port: number }} Edit
 * @typedef {{ ok: boolean, error: string | null, note: string | null }} Outcome
 */

const messageOf = (e) => String(e?.message ?? e);
const hostTaken = (tunnels, host, name) => tunnels.some((t) => t.host === host && t.name !== name);

/** The new file text and the name of the edited tunnel. */
function edited(text, tunnels, edit, liveNames) {
  switch (edit.kind) {
    case "port": return { text: setPort(text, edit.name, edit.port), name: edit.name };
    case "host":
      if (hostTaken(tunnels, edit.host, edit.name)) throw new Error(DUPLICATE_HOST);
      return { text: setHost(text, edit.name, edit.host), name: edit.name };
    case "off": return { text: setOff(text, edit.name, true), name: edit.name };
    case "on": return { text: setOff(text, edit.name, false), name: edit.name };
    case "remove": return { text: removeTunnel(text, edit.name), name: edit.name };
    case "add":
      if (hostTaken(tunnels, edit.host, null)) throw new Error(DUPLICATE_HOST);
      return addTunnel(text, edit.host, edit.port, liveNames);
    case "sync":
      if (!tunnels.some((t) => t.name === edit.name)) throw new Error(`No tunnel with the name ${edit.name}.`);
      return { text, name: edit.name };
  }
  throw new Error(`Unknown edit ${edit.kind}.`);
}

/** @returns {Promise<Outcome>} */
export async function applyEdit(io, edit) {
  const old = await io.read();
  const secrets = secretsOf(old);
  const fail = (error) => ({ ok: false, error: redact(error, secrets), note: null });
  const before = parseConfig(old);
  if (before.error) return fail(before.error);

  // A new tunnel must not get the name of a live tunnel, which can belong to another agent.
  const liveNames = edit.kind === "add" ? (await io.live()).map((l) => l.name) : [];
  let text, name;
  try {
    ({ text, name } = edited(old, before.tunnels, edit, liveNames));
  } catch (e) {
    return fail(messageOf(e));
  }

  const changed = text !== old;
  // Enter on an unchanged value must not restart a live tunnel.
  if (!changed && edit.kind !== "sync") return { ok: true, error: null, note: null };
  // Write the old text back. Give an extra message if the file changed again in the meantime.
  const undo = async () => {
    if (!changed) return "";
    try {
      await io.write(old, text);
      return "";
    } catch {
      return ` ${UNDO_FAILED}`;
    }
  };

  if (changed) {
    try {
      await io.write(text, old);
    } catch {
      return fail(STALE);
    }
    const checkError = await io.check();
    if (checkError) return fail(checkError + (await undo()));
  }

  const after = parseConfig(text).tunnels;
  const prior = before.tunnels.find((t) => t.name === name) ?? null;
  const next = after.find((t) => t.name === name) ?? null;
  const startable = Boolean(next && !next.off);
  // A POST cannot carry a nested field. So a nested tunnel that must start again gets no live change,
  // but a DELETE (off, remove) is safe.
  if (startable && next.nested) return { ok: true, error: null, note: NESTED };

  // Only a live tunnel with a name from the file belongs to the panel. A tunnel of another agent with
  // the same name as a new tunnel must not stop.
  const known = new Set(before.tunnels.map((t) => t.name));
  const live = (await io.live()).filter((l) => known.has(l.name));
  const apiPort = chooseAgent(name, before.tunnels, live);
  if (apiPort === null) return { ok: true, error: null, note: NO_AGENT };

  const running = live.some((l) => l.name === name && l.apiPort === apiPort);
  // The agent keeps the name of a tunnel whose start failed, and then refuses each later start with
  // that name. So a host that this tunnel does not run now goes through a throwaway name first. The
  // running tunnel stops only after the agent accepted the host.
  const hostIsLive = live.some((l) => l.apiPort === apiPort && l.name === name && l.host === next?.host);
  if (startable && next.host && !hostIsLive) {
    const probe = `${PROBE_PREFIX}${Date.now().toString(36)}`;
    const probeError = await io.start(apiPort, { ...postBody(next), name: probe });
    if (probeError) return fail(probeError + (await undo()));
    const probeStopError = await io.stop(apiPort, probe);
    if (probeStopError) return fail(probeStopError + (await undo()));
  }
  if (running) {
    const stopError = await io.stop(apiPort, name);
    if (stopError) return fail(stopError + (await undo()));
  }
  if (startable) {
    const startError = await io.start(apiPort, postBody(next));
    if (startError) {
      const undoError = await undo();
      if (!running) return fail(startError + undoError);
      // Try to start the tunnel as it was before. The agent keeps the name of the failed start, so
      // this try can fail too, and then the user must know that the host is down.
      const restored = changed && prior && !prior.off && !prior.nested && (await io.start(apiPort, postBody(prior))) === null;
      return fail(startError + undoError + (restored ? "" : ` ${DOWN}`));
    }
  }
  return { ok: true, error: null, note: null };
}
