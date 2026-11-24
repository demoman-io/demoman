// The agents' CLIs as setup drives them (DEM-218), for a packed install's
// setup to run against: `node fake-agent.mjs <agent> ...args`, through a
// wrapper named after the agent. Each call is logged, one JSON array a
// line, to $HOME/.fake-agents.log, and what setup added is kept in
// $HOME/.fake-agents.json, so a second setup sees the first's work and
// takes the update path. Anything setup asks that a real agent would not
// answer this way exits 97 and is written to $HOME/.fake-agents.unexpected:
// setup captures an agent's stderr and may forgive the failure (a skipped
// warm start, an `agent` that did not answer), so the test reads that file
// rather than setup's output.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [agent, ...args] = process.argv.slice(2);
const home = process.env.HOME ?? "";
const version = process.env.FAKE_DEMOMAN_VERSION ?? "";
const stateFile = join(home, ".fake-agents.json");
appendFileSync(
  join(home, ".fake-agents.log"),
  `${JSON.stringify([agent, ...args])}\n`,
);

/** A file's text, or `fallback` when it is not there yet; any other read
 *  error stops the fake, so a lost state is never taken for a fresh one. */
const readOr = (file, fallback) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
};

const state = JSON.parse(readOr(stateFile, "{}"));
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const out = (v) =>
  process.stdout.write(typeof v === "string" ? `${v}\n` : JSON.stringify(v));
const line = args.join(" ");
const plugin = { id: "demoman@demoman", version, enabled: true, scope: "user" };

// What each real CLI writes when it installs the plugin, which is how a
// later setup knows Demoman is connected there (configs.ts claudeConnected,
// codexConnected): without it a second setup takes the agent for new.
const claudeEnables = () => {
  const dir = join(home, ".claude");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  const settings = JSON.parse(readOr(file, "{}"));
  settings.enabledPlugins = {
    ...settings.enabledPlugins,
    "demoman@demoman": true,
  };
  writeFileSync(file, JSON.stringify(settings, null, 2));
};
const codexEnables = () => {
  const dir = join(home, ".codex");
  const file = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true });
  const text = readOr(file, "");
  if (!text.includes('[plugins."demoman@demoman"]\n'))
    writeFileSync(
      file,
      `${text}\n[plugins."demoman@demoman"]\nenabled = true\n`,
    );
};

const answers = {
  claude: {
    "--version": () => out("2.1.0 (Claude Code)"),
    "plugin marketplace list --json": () =>
      out(state.claudeMarket ? [{ name: "demoman" }] : []),
    "plugin marketplace add demoman-io/plugins": () => {
      state.claudeMarket = true;
      save();
    },
    "plugin marketplace update demoman": () => {},
    "plugin list --json": () => out(state.claudePlugin ? [plugin] : []),
    "plugin install demoman@demoman": () => {
      state.claudePlugin = true;
      save();
      claudeEnables();
    },
    "plugin update demoman@demoman": () => {},
  },
  codex: {
    "--version": () => out("codex-cli 0.163.0"),
    "plugin marketplace add demoman-io/plugins --json": () => {
      out({
        marketplaceName: "demoman",
        alreadyAdded: state.codexMarket === true,
      });
      state.codexMarket = true;
      save();
    },
    "plugin marketplace upgrade demoman --json": () => out({}),
    "plugin add demoman@demoman --json": () => {
      codexEnables();
      out({});
    },
    "plugin list --json": () =>
      out({
        installed: [{ pluginId: "demoman@demoman", version, enabled: true }],
      }),
  },
  // Cursor's agent CLI answers with a dated version (setup.ts cursorClis).
  agent: {
    "--version": () => out("2026.11.20-0a1b2c3"),
    "mcp enable demoman": () => {},
  },
  opencode: { "--version": () => out("2.1.0") },
  npx: {
    [`--prefix ~/ -y demoman@${version} --version`]: () => out(version),
    "--prefix ~/ -y demoman@latest --version": () => out(version),
  },
};

const answer = answers[agent]?.[line];
if (answer === undefined) {
  const said = `\`${agent} ${line}\``;
  appendFileSync(join(home, ".fake-agents.unexpected"), `${said}\n`);
  process.stderr.write(`fake agent: unexpected ${said}\n`);
  process.exit(97);
}
answer();
