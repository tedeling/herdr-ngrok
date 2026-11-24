// The real Io: reads and writes ngrok.yml, runs `ngrok config check`, and talks to the local API of
// each ngrok agent with curl. Only 127.0.0.1 is used. Each command runs on the target of hub.js: on
// this computer, or on the hub through herdr-core.
import { join } from "path";
import { checking, exec, hc, home, readTextFile, writeTextFile } from "herdr";
import { execOptions, hubError } from "./hub.js";
import { editOnHub } from "./region.js";
import { API_PORTS, agentError, listenerCommand, parseLive } from "./state.js";

const VALID_PREFIX = "Valid configuration file at ";
const NO_AGENT_ANSWER = "The ngrok agent did not answer.";
const DEFAULT_CONFIG = ".config/ngrok/ngrok.yml";

/** The home folder of the target. On the hub, `printenv HOME` gives it. */
async function homeOf(target) {
  if (target.mode !== "remote") return home();
  const result = await exec("printenv", ["HOME"], { timeout: 10000, ...execOptions(target) });
  const folder = result.code === 0 ? result.stdout.trim() : "";
  if (!folder) throw new Error("the hub gives no HOME");
  return folder;
}

/**
 * The path of ngrok.yml on the target, as ngrok itself finds it.
 * @param {import("./hub.js").Target} target
 */
export async function configPath(target) {
  const options = execOptions(target);
  if (checking()) return join(home(), DEFAULT_CONFIG);
  const result = await exec("ngrok", ["config", "check"], { timeout: 10000, ...options }).catch(() => null);
  const line = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.split("\n").find((l) => l.startsWith(VALID_PREFIX));
  return line ? line.slice(VALID_PREFIX.length).trim() : join(await homeOf(target), DEFAULT_CONFIG);
}

/** One HTTP call to an agent. Null when nothing answers on the port. */
async function request(method, url, body, options) {
  const args = ["-s", "-m", method === "GET" ? "1" : "15", "-X", method, "-w", "\n%{http_code}"];
  if (body) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  args.push(url);
  const result = await exec("curl", args, { timeout: 20000, ...options }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const cut = result.stdout.lastIndexOf("\n");
  return { status: Number(result.stdout.slice(cut + 1)), body: result.stdout.slice(0, cut) };
}

const ok = (status) => status >= 200 && status < 300;
const tunnelsUrl = (apiPort) => `http://127.0.0.1:${apiPort}/api/tunnels`;

/**
 * @param {string} path  The path of ngrok.yml on the target.
 * @param {import("./hub.js").Target} target  Not blocked.
 * @returns {import("./apply.js").Io}
 */
export function makeIo(path, target) {
  const options = execOptions(target);
  const local = target.mode === "local";
  // The output of `uname -s` on the target. The panel asks for it one time.
  let os = null;
  return {
    async read() {
      if (checking()) return "";
      return (await readTextFile(path, options)) ?? "";
    },
    async write(text, expected) {
      if (checking()) return;
      // hc file edit keeps the file mode, so only a local write needs chmod.
      if (!local) return editOnHub(hc, target, path, text, expected);
      await writeTextFile(path, text, expected);
      // The write replaces the file, and the file holds the authtoken.
      await exec("chmod", ["600", path]);
    },
    async check() {
      if (checking()) return null;
      const result = await exec("ngrok", ["config", "check", "--config", path], { timeout: 10000, ...options })
        .catch((e) => ({ code: 1, stdout: "", stderr: hubError(target, String(e?.message ?? e)) }));
      if (result.code === 0) return null;
      return (result.stderr || result.stdout).split("\n").map((l) => l.replace(/^ERROR:\s*/, "").trim()).filter(Boolean).join(" ");
    },
    async live() {
      if (checking()) return [];
      const answers = await Promise.all(API_PORTS.map(async (apiPort) => {
        const answer = await request("GET", tunnelsUrl(apiPort), null, options);
        return answer && ok(answer.status) ? parseLive(answer.body, apiPort) : [];
      }));
      return answers.flat();
    },
    /** The listening TCP ports of the target, or null when the panel cannot read them. */
    async listeners() {
      if (checking()) return null;
      if (os === null) {
        const answer = await exec("uname", ["-s"], { timeout: 5000, ...options }).catch(() => null);
        if (!answer || answer.code !== 0) return null;
        os = answer.stdout.trim();
      }
      const { command, args, parse } = listenerCommand(os);
      const result = await exec(command, args, { timeout: 5000, ...options }).catch(() => null);
      if (!result || result.code !== 0) return null;
      return parse(result.stdout);
    },
    async start(apiPort, body) {
      if (checking()) return null;
      const answer = await request("POST", tunnelsUrl(apiPort), body, options);
      if (!answer) return NO_AGENT_ANSWER;
      return ok(answer.status) ? null : agentError(answer.body);
    },
    async stop(apiPort, name) {
      if (checking()) return null;
      const answer = await request("DELETE", `${tunnelsUrl(apiPort)}/${encodeURIComponent(name)}`, null, options);
      if (!answer) return NO_AGENT_ANSWER;
      return ok(answer.status) || answer.status === 404 ? null : agentError(answer.body);
    },
  };
}
