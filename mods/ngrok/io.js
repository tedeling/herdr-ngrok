// The real Io: reads and writes ngrok.yml, runs `ngrok config check`, and talks to the local API of
// each ngrok agent with curl. Only 127.0.0.1 is used.
import { join } from "path";
import { platform } from "os";
import { checking, exec, home, readTextFile, writeTextFile } from "herdr";
import { API_PORTS, agentError, parseLive, parseLsof, parseSs } from "./state.js";

const VALID_PREFIX = "Valid configuration file at ";
const NO_AGENT_ANSWER = "The ngrok agent did not answer.";

/** The path of ngrok.yml, as ngrok itself finds it. */
export async function configPath() {
  const fallback = join(home(), ".config/ngrok/ngrok.yml");
  if (checking()) return fallback;
  const result = await exec("ngrok", ["config", "check"], { timeout: 10000 }).catch(() => null);
  const line = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`.split("\n").find((l) => l.startsWith(VALID_PREFIX));
  return line ? line.slice(VALID_PREFIX.length).trim() : fallback;
}

/** One HTTP call to an agent. Null when nothing answers on the port. */
async function request(method, url, body) {
  const args = ["-s", "-m", method === "GET" ? "1" : "15", "-X", method, "-w", "\n%{http_code}"];
  if (body) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  args.push(url);
  const result = await exec("curl", args, { timeout: 20000 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const cut = result.stdout.lastIndexOf("\n");
  return { status: Number(result.stdout.slice(cut + 1)), body: result.stdout.slice(0, cut) };
}

const ok = (status) => status >= 200 && status < 300;
const tunnelsUrl = (apiPort) => `http://127.0.0.1:${apiPort}/api/tunnels`;

/** @returns {import("./apply.js").Io} */
export function makeIo(path) {
  return {
    async read() {
      if (checking()) return "";
      return (await readTextFile(path)) ?? "";
    },
    async write(text, expected) {
      if (checking()) return;
      await writeTextFile(path, text, expected);
      // The write replaces the file, and the file holds the authtoken.
      await exec("chmod", ["600", path]);
    },
    async check() {
      if (checking()) return null;
      const result = await exec("ngrok", ["config", "check", "--config", path], { timeout: 10000 }).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      if (result.code === 0) return null;
      return (result.stderr || result.stdout).split("\n").map((l) => l.replace(/^ERROR:\s*/, "").trim()).filter(Boolean).join(" ");
    },
    async live() {
      if (checking()) return [];
      const answers = await Promise.all(API_PORTS.map(async (apiPort) => {
        const answer = await request("GET", tunnelsUrl(apiPort));
        return answer && ok(answer.status) ? parseLive(answer.body, apiPort) : [];
      }));
      return answers.flat();
    },
    /** The listening TCP ports of this computer, or null when the panel cannot read them. */
    async listeners() {
      if (checking()) return null;
      const mac = platform() === "darwin";
      const result = await (mac
        ? exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeout: 5000 })
        : exec("ss", ["-ltnpH"], { timeout: 5000 })).catch(() => null);
      if (!result || result.code !== 0) return null;
      return mac ? parseLsof(result.stdout) : parseSs(result.stdout);
    },
    async start(apiPort, body) {
      if (checking()) return null;
      const answer = await request("POST", tunnelsUrl(apiPort), body);
      if (!answer) return NO_AGENT_ANSWER;
      return ok(answer.status) ? null : agentError(answer.body);
    },
    async stop(apiPort, name) {
      if (checking()) return null;
      const answer = await request("DELETE", `${tunnelsUrl(apiPort)}/${encodeURIComponent(name)}`);
      if (!answer) return NO_AGENT_ANSWER;
      return ok(answer.status) || answer.status === 404 ? null : agentError(answer.body);
    },
  };
}
