// A scripted `gh` for the tests. FAKE_GH_SCRIPT is a JSON file mapping an
// argument prefix (the argv joined by spaces) to { code, stdout, stderr },
// or to { hang: true } for a gh that never answers; the longest matching
// prefix answers. A list of answers is used in order, one per call to that
// prefix (counted in FAKE_GH_STATE, which must then be set), and its last
// answer repeats. Every call's argv is appended to FAKE_GH_LOG as one JSON
// line. A call nothing in the script covers exits 127 and says so, so a test
// never passes on a call it did not script.
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const argv = process.argv.slice(2);
if (process.env.FAKE_GH_LOG) {
  appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify(argv)}\n`);
}
const script = JSON.parse(readFileSync(process.env.FAKE_GH_SCRIPT, "utf8"));
const line = argv.join(" ");
const key = Object.keys(script)
  .filter((k) => line === k || line.startsWith(`${k} `))
  .sort((a, b) => b.length - a.length)[0];
if (key === undefined) {
  process.stderr.write(`fake-gh: nothing scripted for: ${line}\n`);
  process.exit(127);
}
let answer = script[key];
if (Array.isArray(answer)) {
  const statePath = process.env.FAKE_GH_STATE;
  if (!statePath) {
    process.stderr.write(`fake-gh: a list of answers needs FAKE_GH_STATE\n`);
    process.exit(127);
  }
  const state = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : {};
  const n = state[key] ?? 0;
  state[key] = n + 1;
  writeFileSync(statePath, JSON.stringify(state));
  answer = answer[Math.min(n, answer.length - 1)];
}
if (answer.hang) {
  // Held open until the caller stops it.
  setInterval(() => undefined, 60_000);
} else {
  process.stdout.write(answer.stdout ?? "");
  process.stderr.write(answer.stderr ?? "");
  // Not process.exit: a pipe on macOS is written asynchronously, and exiting
  // at once could cut a long answer short.
  process.exitCode = answer.code ?? 0;
}
