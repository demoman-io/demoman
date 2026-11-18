#!/bin/sh
# The held-clock spec's risks, one page each, recorded by held-clock.sh like
# a house app: twice held and once in real time.
#
#   held-risks.sh <out dir> [flow…]
#
# Flows: video (a playing <video>), smooth-scroll (the app's own smooth
# scroll), iframe (a frame from another site with a CSS animation and a
# timer), webgl (a WebGL canvas drawn by requestAnimationFrame), phone (the
# WebGL page as a device recording). The pages are served from a temporary
# folder on 127.0.0.1:${PORT:-4390}; the frame's page from localhost, another
# site. A visible window (`--headed`) is not here: held-clock records headless.
set -eu
[ $# -ge 1 ] || { echo "usage: held-risks.sh <out dir> [flow…]" >&2; exit 2; }
out=$1; shift
port=${PORT:-4390}
here=$(cd "$(dirname "$0")" && pwd)
app=$(mktemp -d "${TMPDIR:-/tmp}/held-risks-XXXXXX")
server=
trap '[ -n "$server" ] && kill "$server"; rm -rf "$app"' EXIT
mkdir -p "$app/.demoman/flows"
echo "{\"appVersion\":1,\"url\":\"http://127.0.0.1:$port\"}" >"$app/.demoman/app.json"
ffmpeg -v error -f lavfi -i "testsrc2=size=640x360:rate=30:duration=6" -c:v libvpx -b:v 1M "$app/clip.webm"

head='<!doctype html><meta charset=utf-8><link rel=icon href="data:,"><style>body{margin:0;font:16px monospace}#go{position:absolute;left:40px;top:40px;width:160px;height:40px}</style><button id=go>Go</button>'
echo "$head<video src=clip.webm autoplay muted loop playsinline style=\"position:absolute;left:40px;top:120px;width:640px;height:360px\"></video>" >"$app/video.html"
echo "$head<style>html{scroll-behavior:smooth}body{height:4000px;background:repeating-linear-gradient(#000 0 20px,#fff 20px 37px)}</style><script>go.onclick=()=>scrollTo({top:2400,behavior:'smooth'})</script>" >"$app/smooth-scroll.html"
echo "$head<iframe src=\"http://localhost:$port/spin.html\" style=\"position:absolute;left:40px;top:120px;width:400px;height:300px;border:0\"></iframe>" >"$app/iframe.html"
echo '<!doctype html><link rel=icon href="data:,"><style>@keyframes s{to{transform:rotate(360deg)}}#b{width:80px;height:80px;margin:40px;background:linear-gradient(90deg,#c00,#00c);animation:s 1s linear infinite}</style><div id=b></div><p id=t>0</p><script>let n=0;setInterval(()=>t.textContent=++n,100)</script>' >"$app/spin.html"
echo "$head<canvas id=c width=640 height=360 style=\"position:absolute;left:40px;top:120px\"></canvas><script>
const gl=c.getContext('webgl');gl.enable(gl.SCISSOR_TEST);let t0=null;
function f(t){if(t0===null)t0=t;const ms=t-t0;
gl.scissor(0,0,640,360);gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT);
gl.scissor(Math.floor((ms/4)%600),140,40,80);gl.clearColor(.5,0,.5,1);gl.clear(gl.COLOR_BUFFER_BIT);
requestAnimationFrame(f)}requestAnimationFrame(f)</script>" >"$app/webgl.html"

# flow <name> <page> <extra script fields, ending in a comma, or nothing>
flow() {
  echo "{\"keptVersion\":2,\"flow\":\"$(uuidgen | tr 'A-Z' 'a-z')\",\"name\":\"$1\",\"scale\":1,\"logo\":null,\"deliver\":\"commit\",\"report\":null,\"script\":{\"scriptVersion\":8,\"name\":\"$1\",\"target\":\"http://127.0.0.1:$port/$2.html\",$3\"steps\":[{\"do\":\"click\",\"on\":{\"stableId\":\"go\"},\"zoom\":false},{\"do\":\"pause\",\"ms\":2000}]},\"outputs\":[{\"path\":\"$1.mp4\",\"fileType\":\"mp4\",\"aspect\":\"auto\",\"quality\":\"share\"}]}" >"$app/.demoman/flows/$1.json"
}
vp='"viewport":{"width":1280,"height":800},'
flow video video "$vp"
flow smooth-scroll smooth-scroll "$vp"
flow iframe iframe "$vp"
flow webgl webgl "$vp"
flow phone webgl '"device":"phone",'

python3 -m http.server "$port" --directory "$app" >/dev/null 2>&1 &
server=$!
until curl -sf -o /dev/null "http://127.0.0.1:$port/video.html"; do sleep 0.2; done
"$here/held-clock.sh" "$app" "$out" "$@"
