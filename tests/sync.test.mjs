import fs from 'fs';
import vm from 'vm';
const code = fs.readFileSync(process.argv[2] || new URL("../lampa-sync.js", import.meta.url), "utf8");
// shared fake GitHub
const gh = { gist: { files: { 'timeline.json': { content: JSON.stringify({ r1: { time: 5, updated: 100 } }) },
  'pins.json': { content: JSON.stringify({ tmdb_7: { title: 'old-key pin', MagnetUri: 'm7', updated: 50 } }) } } }, ver: 1, failPatch: false, calls: [] };
async function fakeFetch(url, o) {
  o = o || { method: 'GET', headers: {} };
  if (url.endsWith('/gists?per_page=100')) { gh.calls.push('LIST'); return { ok: true, json: async () => gh.list || [] }; }
  if (url.endsWith('/gists') && o.method === 'POST') { gh.calls.push('CREATE'); gh.list = [{ id: 'g', public: false, description: JSON.parse(o.body).description }]; return { ok: true, json: async () => ({ id: 'g' }) }; }
  if (url.startsWith('raw:')) return { ok: true, text: async () => gh.raw[url] };
  if (gh.status) { gh.calls.push(o.method + '!' + gh.status); return { status: gh.status, ok: false, headers: { get: () => null } }; }
  gh.calls.push(o.method + (o.headers['If-None-Match'] ? '(cond)' : ''));
  const tag = () => 'W/"' + gh.ver + '"';
  const hdr = { get: k => k === 'ETag' ? tag() : null };
  if (o.method === 'GET') {
    if (o.headers['If-None-Match'] === tag()) return { status: 304, ok: false, headers: hdr };
    return { status: 200, ok: true, headers: hdr, json: async () => JSON.parse(JSON.stringify(gh.gist)) };
  }
  if (gh.failPatch) return { status: 500, ok: false, headers: hdr };
  const b = JSON.parse(o.body); for (const f in b.files) gh.gist.files[f] = b.files[f]; gh.ver++;
  return { status: 200, ok: true, headers: { get: k => k === 'ETag' ? tag() : null }, json: async () => JSON.parse(JSON.stringify(gh.gist)) };
}
function device(name, localTimeline, key, history) {
  const store = { gsync_setup_done: true, __history: history || [], gsync_key: key || 'g:t', file_view: localTimeline || {} }, L = {};
  const jq = () => ({ removeClass: jq, find: jq, on: jq, after: jq, css: jq, length: 0, append: jq, remove: jq, prepend: jq, removeClass: jq, addClass: jq, data: jq, text: jq, replaceWith: jq });
  const ctx = {
    console, Promise, JSON, Object, Date, Math, setTimeout, clearTimeout, setInterval: () => 0, fetch: fakeFetch,
    $: Object.assign(jq, { _data: () => ({}) }),
    localStorage: { getItem: k => store['ls_' + k] ?? null, setItem: (k, v) => store['ls_' + k] = v },
    document: { hidden: false, addEventListener() {}, querySelectorAll: () => [], body: { contains: () => false } },
    MutationObserver: function () { this.observe = () => {}; },
  };
  ctx.window = { appready: true, addEventListener() {}, encodeURIComponent };
  const view = h => store.file_view[h] || {};
  ctx.Lampa = {
    Storage: { get: (k, d) => store[k] ?? d, set: (k, v) => { store[k] = v; L.store?.({ name: k }); }, listener: { follow: (ev, fn) => L.store = fn } },
    Timeline: { filename: () => 'file_view', view, update: p => { store.file_view[p.hash] = { ...p, updated: p.updated || Date.now() }; L.tl?.({ data: { hash: p.hash, road: store.file_view[p.hash] } }); }, listener: { follow: (ev, fn) => L.tl = fn } },
    Listener: { follow: (n, fn) => { const prev = L['l_' + n]; L['l_' + n] = prev ? (e) => { prev(e); fn(e); } : fn; } }, Platform: { macOS: () => false }, Noty: { show: (m) => (store.noty = m) },
    Player: { listener: { follow() {} } }, Utils: { hash: x => x }, Activity: { active: () => ({ movie: { id: 7, source: 'cub' } }) },
    Torrent: { start: (el) => (store.started = el.MagnetUri) }, Controller: { toggle() {}, enabled: () => ({ name: 'content' }) },
    Component: { add() {} }, Menu: { addButton() {} },
    Favorite: { get: () => store.__history || [], listener: { follow: (ev, fn) => (L.fav = fn) } }, Select: { show() {} }, InteractionCategory: function () {}
  };
  vm.createContext(ctx);
  vm.runInContext(code.replace("  if (window.appready) start();", "  globalThis.__t = { backfillHistory: backfillHistory, removeFromWatched: removeFromWatched, cycle: cycle, pins: pins, allLast: allLast, playPinned: playPinned, setFlag: setFlag, libList: libList, markWatched: markWatched };\n  if (window.appready) start();"), ctx);
  return { name, store, L, t: ctx.__t, Lampa: ctx.Lampa };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const tl = () => JSON.parse(gh.gist.files['timeline.json'].content);
const ok = (n, c) => console.log((c ? 'PASS ' : 'FAIL ') + n);

// TV starts with an old local timecode never uploaded
const tv = device('tv', { local1: { time: 300, duration: 3000, percent: 10, updated: 200 }, junk: 5 });
await wait(2000);
ok('1 reconcile uploads local-only timecode', tl().local1?.time === 300 && tl().r1?.time === 5);
ok('2 remote timecode applied on TV', tv.store.file_view.r1?.time === 5);
ok('3 legacy pin key tmdb_7 visible as id_7', tv.t.pins()['id_7']?.MagnetUri === 'm7');

// Mac device opens same card via CUB
const mac = device('mac', {});
await wait(1500);
ok('4 Mac sees pin for cub card', mac.t.pins()['id_7']?.MagnetUri === 'm7');
ok('5 Mac got TV timecode', mac.store.file_view.local1?.time === 300);

// TV launches torrent from list (no pin for card 9)
tv.Lampa.Activity.active = () => ({ movie: { id: 9, source: 'tmdb' } });
tv.L.l_torrent({ type: 'onenter', element: { title: 'T9', MagnetUri: 'm9' } });
await wait(1500);
gh.calls = [];
await mac.t.cycle();
ok('6 last-launched synced to Mac', mac.t.allLast()['id_9']?.MagnetUri === 'm9');
await mac.t.cycle();
ok('7 idle check = only conditional GET', JSON.stringify(gh.calls.slice(-1)) === '["GET(cond)"]');

// Mac continues -> starts same torrent
mac.t.playPinned(mac.t.allLast()['id_9'], { id: 9 });
ok('8 continue starts last torrent', mac.store.started === 'm9');

// conflict: both update same hash, newer wins
tv.Lampa.Timeline.update({ hash: 'x', time: 10, updated: 1000 });
mac.Lampa.Timeline.update({ hash: 'x', time: 20, updated: 2000 });
await wait(1700); await tv.t.cycle(); await mac.t.cycle(); await tv.t.cycle();
ok('9 newer timecode wins on both', tl().x.time === 20 && tv.store.file_view.x.time === 20);

// failure + retry
gh.failPatch = true; tv.Lampa.Timeline.update({ hash: 'y', time: 7 }); await wait(1700);
gh.failPatch = false; await tv.t.cycle().catch(() => {}); await tv.t.cycle({ final: true });
ok('10 retry after failed upload', tl().y?.time === 7);

// pin removal propagates
tv.Lampa.Activity.active = () => ({ movie: { id: 7, source: 'tmdb' } });
const menu = []; tv.L.l_torrent({ type: 'onlong', menu, element: { MagnetUri: 'm7' } });
menu[0].onSelect(); await wait(700); await tv.t.cycle(); await mac.t.cycle();
ok('11 unpin propagates to Mac', !mac.t.pins()['id_7']);

// 12: lost update — other writer overwrote our entry; self-heal on next fresh read
tv.Lampa.Timeline.update({ hash: 'lost', time: 42 }); await wait(1700); await tv.t.cycle({ final: true });
const cur = tl(); delete cur.lost; gh.gist.files['timeline.json'].content = JSON.stringify(cur); gh.ver++;
await tv.t.cycle({ final: true });
ok('12 lost update re-uploaded (self-heal)', tl().lost?.time === 42);

// 13: unparsable remote file is never overwritten
gh.gist.files['pins.json'].content = '{broken'; gh.ver++;
tv.Lampa.Activity.active = () => ({ movie: { id: 55, source: 'tmdb' } });
const m2 = []; tv.L.l_torrent({ type: 'onlong', menu: m2, element: { MagnetUri: 'm55', title: 'x' } });
m2[0].onSelect(); await wait(700); await tv.t.cycle({ final: true });
ok('13 broken pins.json not overwritten', gh.gist.files['pins.json'].content === '{broken');
gh.gist.files['pins.json'].content = '{}'; gh.ver++; await tv.t.cycle({ final: true });
ok('13b pin pushed once file readable', JSON.parse(gh.gist.files['pins.json'].content).id_55?.MagnetUri === 'm55');

// 14: truncated file loaded from raw_url and merged, not lost
gh.raw = { 'raw:tl': gh.gist.files['timeline.json'].content };
gh.gist.files['timeline.json'] = { truncated: true, raw_url: 'raw:tl', content: '{"r1":{"ti' }; gh.ver++;
tv.Lampa.Timeline.update({ hash: 'trunc', time: 3 }); await wait(100); await tv.t.cycle({ final: true });
ok('14 truncated file merged via raw_url', tl().r1?.time === 5 && tl().trunc?.time === 3);

// 15: throttle — playback updates within 30 s are batched into one write
await tv.t.cycle({ final: true }); gh.calls = [];
for (let i = 0; i < 5; i++) { tv.Lampa.Timeline.update({ hash: 'play', time: 100 + i }); await wait(50); }
await wait(1700);
const patches = gh.calls.filter(c => c === 'PATCH').length;
ok('15 throttled: no write within 30 s of previous (' + patches + ')', patches === 0);
await tv.t.cycle({ final: true });
ok('15b final flush writes latest value', tl().play?.time === 104);

// 16: auth error -> notification, data kept, recovers
gh.status = 401; tv.Lampa.Timeline.update({ hash: 'auth', time: 8 });
await tv.t.cycle({ final: true }).catch(() => {});
ok('16 401 shows key warning', /ключ/.test(tv.store.noty || ''));
gh.status = 0; await tv.t.cycle({ final: true });
ok('16b data delivered after recovery', tl().auth?.time === 8);

// 17: token-only key -> finds existing data gist, stores id:token
gh.list = [{ id: 'g', public: false, description: 'Lampa sync data (timecodes)' }]; gh.calls = [];
const fr = device('friend', {}, 'tok');
await wait(1500);
ok('17 token-only finds data gist, no duplicate', fr.store.gsync_key === 'g:tok' && !gh.calls.includes('CREATE') && fr.store.file_view.r1?.time === 5);
// 18: token-only with no gist -> creates one
gh.list = []; gh.calls = [];
const nf = device('new', {}, 'tok2');
await wait(1500);
ok('18 token-only creates secret gist once', nf.store.gsync_key === 'g:tok2' && gh.calls.filter(c => c === 'CREATE').length === 1);

// 19: flags sync between devices, sorted newest first
tv.t.setFlag({ id: 101, title: 'A' }, 'later', true); await wait(30);
tv.t.setFlag({ id: 102, title: 'B' }, 'later', true); await wait(30);
tv.t.setFlag({ id: 101, title: 'A' }, 'like', true); tv.t.markWatched({ id: 103, title: 'C' });
await wait(700); await tv.t.cycle({ final: true }); await mac.t.cycle({ force: true });
ok('19 flags synced, newest first', JSON.stringify(mac.t.libList('later').map(c => c.id)) === '[102,101]' && mac.t.libList('like')[0]?.id === 101 && mac.t.libList('watched')[0]?.id === 103);
// 20: removing last flag removes entry everywhere
mac.t.setFlag({ id: 102, title: 'B' }, 'later', false); await wait(700); await mac.t.cycle({ final: true }); await tv.t.cycle({ force: true });
ok('20 unflag propagates', JSON.stringify(tv.t.libList('later').map(c => c.id)) === '[101]');

// 21: self-update — newer cached code runs instead of the CDN copy; older is ignored
function boot(ls) {
  const ctx = { console, JSON, Date, Math, Object, Number, String, setTimeout, clearTimeout, setInterval: () => 0,
    localStorage: { getItem: k => ls[k] ?? null, setItem: (k, v) => ls[k] = v } };
  ctx.window = ctx; ctx.window.appready = false;
  ctx.Lampa = { Listener: { follow() {} } };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}
const b1 = boot({ gsync_code_version: '99.0.0', gsync_code: 'window.__ran_new = true;' });
ok('21 newer cached version is started', b1.__ran_new === true && !b1.__lampa_gsync);
const b2 = boot({ gsync_code_version: '0.0.1', gsync_code: 'window.__ran_new = true;' });
ok('21b older cached version ignored', !b2.__ran_new && b2.__lampa_gsync === true);

// 22: existing Lampa history imported once, order kept (newest first), synced to the other device
const h = device('hist', {}, 'g:t', [{ id: 301, title: 'Newest' }, { id: 302, name: 'Middle', original_name: 'M' }, { id: 303, title: 'Oldest' }]);
await wait(1500); await h.t.cycle({ final: true }); await mac.t.cycle({ force: true });
const ids = mac.t.libList('watched').map(c => c.id).filter(id => id >= 300);
ok('22 history imported, order kept, synced', JSON.stringify(ids) === '[301,302,303]');
// 23: new history add puts film on top
await wait(31000); h.L.fav({ where: 'history', card: { id: 303, title: 'Oldest' } }); await wait(700); await h.t.cycle({ final: true });
ok('23 re-watched film moves to top', h.t.libList('watched')[0].id === 303);
// 24: flags survive removal from watched, and stay out of history
h.t.setFlag({ id: 302, name: 'Middle' }, 'later', true); h.t.removeFromWatched({ id: 302, name: 'Middle' });
ok('24 flag kept after removing from history', h.t.libList('later')[0]?.id === 302 && !h.t.libList('watched').some(c => c.id === 302));

// 25: CUB history arrives late (after start) — still imported on favorite update
const late = device('late', {}, 'g:t', []);
await wait(1500);
late.store.__history = [{ id: 401, title: 'FromCub' }];
late.L['l_state:changed']({ target: 'favorite', reason: 'update' });
await wait(3500); await late.t.cycle({ final: true }); await mac.t.cycle({ force: true });
ok('25 late CUB history imported and synced', mac.t.libList('watched').some(c => c.id === 401));
// 26: film removed from library is not re-imported from history
late.t.removeFromWatched({ id: 401, title: 'FromCub' });
late.L['l_state:changed']({ target: 'favorite', reason: 'update' });
await wait(3500);
ok('26 removed film stays removed', !late.t.libList('watched').some(c => c.id === 401));
process.exit(0);
