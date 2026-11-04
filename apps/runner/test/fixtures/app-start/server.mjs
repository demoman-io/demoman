// A stand-in app for app-start.test.ts. MODE:
//   normal (default) listens on PORT and answers 200
//   never  prints a line, listens on nothing, stays alive
//   exit   prints a line and exits 1 at once
//   slow   listens on PORT after SLOW_MS (default 600)
//   fork   starts a detached `normal` child that listens, writes its pid to
//          PIDFILE, and exits 0 (a daemonizing start command)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const {
  MODE = "normal",
  PORT,
  GREETING = "",
  PIDFILE,
  SLOW_MS = "600",
} = process.env;
const listen = () =>
  createServer((_req, res) => res.end("ok")).listen(Number(PORT), () =>
    console.log(`listening on ${PORT} ${GREETING}`),
  );

if (MODE === "normal") listen();
else if (MODE === "slow") setTimeout(listen, Number(SLOW_MS));
else if (MODE === "never") {
  console.log(`never listening ${GREETING}`);
  setInterval(() => {}, 1000);
} else if (MODE === "exit") {
  console.log("exiting at once");
  process.exit(1);
} else if (MODE === "fork") {
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MODE: "normal" },
  });
  if (PIDFILE) writeFileSync(PIDFILE, String(child.pid));
  child.unref();
  console.log("forked; parent exits");
}
