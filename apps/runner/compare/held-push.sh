#!/bin/sh
# Push channels on a held clock, one page each, recorded by held-clock.sh
# like a house app: twice held and once in real time. For the author's
# ruling on how a connection that stays open counts (2026-11-16).
#
#   held-push.sh <out dir> [flow…]
#
# Flows: none (no channel: the baseline), sse (an EventSource, a message
# every 3 s), sse-idle (an EventSource that sends once and then nothing),
# long-poll (a fetch answered after 5 s, asked again at once), stream (a
# fetch whose body sends a chunk every 2 s and never ends). Every page shows
# what arrives; every flow is three clicks a second apart. Served on
# 127.0.0.1:${PORT:-4391}.
set -eu
[ $# -ge 1 ] || { echo "usage: held-push.sh <out dir> [flow…]" >&2; exit 2; }
out=$1; shift
port=${PORT:-4391}
here=$(cd "$(dirname "$0")" && pwd)
app=$(mktemp -d "${TMPDIR:-/tmp}/held-push-XXXXXX")
server=
trap '[ -n "$server" ] && kill "$server"; rm -rf "$app"' EXIT
mkdir -p "$app/.demoman/flows"
echo "{\"appVersion\":1,\"url\":\"http://127.0.0.1:$port\"}" >"$app/.demoman/app.json"

cat >"$app/server.mjs" <<'EOF'
import { createServer } from "node:http";
const head = `<!doctype html><meta charset=utf-8><link rel=icon href="data:,"><style>body{margin:0;font:16px monospace}#go{position:absolute;left:40px;top:40px;width:160px;height:40px}p{position:absolute;left:40px;margin:0}#n{top:100px}#log{top:140px}</style><button id=go>Go</button><p id=n>0</p><p id=log>-</p><script>let n=0;go.onclick=()=>{document.getElementById("n").textContent=++n};const say=(t)=>{document.getElementById("log").textContent=t};`;
const pages = {
  none: "",
  sse: `new EventSource("/events?every=3000").onmessage=(e)=>say(e.data);`,
  "sse-idle": `new EventSource("/events?every=0").onmessage=(e)=>say(e.data);`,
  "long-poll": `(async()=>{for(;;)say(await(await fetch("/poll")).text())})();`,
  stream: `(async()=>{const r=(await fetch("/chunks")).body.getReader();const d=new TextDecoder();for(;;){const c=await r.read();if(c.done)break;say(d.decode(c.value))}})();`,
};
let sent = 0;
createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const page = pages[url.pathname.slice(1).replace(/\.html$/, "")];
  if (page !== undefined) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`${head}${page}</script>`);
  } else if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    const send = () => res.write(`data: message ${++sent}\n\n`);
    send();
    const every = Number(url.searchParams.get("every"));
    const timer = every > 0 ? setInterval(send, every) : null;
    req.on("close", () => timer && clearInterval(timer));
  } else if (url.pathname === "/poll") {
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(`poll ${++sent}`);
    }, 5000);
    req.on("close", () => clearTimeout(timer));
  } else if (url.pathname === "/chunks") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    const send = () => res.write(`chunk ${++sent}`);
    send();
    const timer = setInterval(send, 2000);
    req.on("close", () => clearInterval(timer));
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(Number(process.argv[2]), "127.0.0.1");
EOF

for name in none sse sse-idle long-poll stream; do
  echo "{\"keptVersion\":2,\"flow\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"name\":\"$name\",\"scale\":1,\"logo\":null,\"deliver\":\"commit\",\"report\":null,\"script\":{\"scriptVersion\":8,\"name\":\"$name\",\"target\":\"http://127.0.0.1:$port/$name.html\",\"viewport\":{\"width\":1280,\"height\":800},\"steps\":[{\"do\":\"click\",\"on\":{\"stableId\":\"go\"},\"zoom\":false},{\"do\":\"pause\",\"ms\":1000},{\"do\":\"click\",\"on\":{\"stableId\":\"go\"},\"zoom\":false},{\"do\":\"pause\",\"ms\":1000},{\"do\":\"click\",\"on\":{\"stableId\":\"go\"},\"zoom\":false}]},\"outputs\":[{\"path\":\"$name.mp4\",\"fileType\":\"mp4\",\"aspect\":\"auto\",\"quality\":\"share\"}]}" >"$app/.demoman/flows/$name.json"
done

node "$app/server.mjs" "$port" &
server=$!
until curl -sf -o /dev/null "http://127.0.0.1:$port/none.html"; do sleep 0.2; done
"$here/held-clock.sh" "$app" "$out" "$@"
