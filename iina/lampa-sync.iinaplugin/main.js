// IINA только плеер: время просмотра отдаётся в TorrServer, через который идёт видео.
// Лампа забирает его оттуда и сама синхронизирует дальше.
const { core, event, http, console } = iina;

let timer = null;
let snap = null;   // последняя позиция: при закрытии окна плеер уже сброшен
let lastSent = -1;

// http://127.0.0.1:8090/stream/...?link=<hash>&index=<n>&play
function parse(url) {
  const m = String(url || "").match(/^(https?:\/\/[^/]+)\/stream\/[^?]*\?(.*)$/);
  if (!m) return null;
  const q = {};
  m[2].split("&").forEach(kv => { const p = kv.split("="); q[p[0]] = decodeURIComponent(p[1] || ""); });
  if (!q.link || !q.index) return null;
  return { server: m[1], hash: q.link, index: Number(q.index) };
}

function remember() {
  const t = parse(core.status.url);
  const position = core.status.position;
  if (t && position && position >= 5) snap = { t, position: Math.round(position) };
}

async function report(reason) {
  remember();
  if (!snap || snap.position === lastSent) return;
  lastSent = snap.position;
  try {
    await http.post(snap.t.server + "/viewed", {
      headers: { "Content-Type": "application/json" },
      data: { action: "set", hash: snap.t.hash, file_index: snap.t.index, timecode: snap.position }
    });
    console.log(`GSync ${reason}: ${snap.position}`);
  } catch (e) {
    console.log("GSync error: " + e);
  }
}

event.on("iina.file-loaded", () => {
  snap = null;
  lastSent = -1;
  const m = String(core.status.url || "").match(/[?&]gsync_t=(\d+)/);
  if (m && Number(m[1]) > 5) {
    setTimeout(() => { core.seekTo(Number(m[1])); core.osd("Продолжение с " + Math.floor(m[1] / 60) + " мин"); }, 300);
  }
  if (timer) clearInterval(timer);
  let tick = 0;
  timer = setInterval(() => {
    remember();
    if (++tick % 2 === 0 && !core.status.paused) report("interval"); // каждые 10 с
  }, 5000);
});
event.on("mpv.pause.changed", () => { if (core.status.paused) report("pause"); });
event.on("iina.window-will-close", () => { report("close"); });
event.on("mpv.end-file", () => { report("end"); });
