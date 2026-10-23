/*
 * Lampa Sync — синхронизация Лампы между устройствами через личный секретный GitHub Gist:
 * таймкоды, «Моя раздача», последняя запущенная раздача, основной источник.
 * Плюс кнопки «Продолжить» / «Выбрать источник» на карточке и копирование magnet-ссылки на Маке.
 *
 * Настройка: Настройки → Синхронизация таймкодов → ключ.
 * Ключ — GitHub-токен с правом gist (секретный Gist для данных создастся сам)
 * или "<id gist>:<токен>", если Gist уже есть.
 *
 * timeline.json — таймкоды Лампы {hash: {time, duration, percent, updated, card?, season?, episode?}}
 * На Маке время из IINA приходит через TorrServer (/viewed), см. pollIina.
 */
(function () {
  'use strict';
  var VERSION = '1.4.2';

  function newerVersion(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (d) return d > 0;
    }
    return false;
  }

  // Самообновление: CDN может отдавать старую версию до 12 ч, поэтому новая версия,
  // скачанная напрямую с GitHub, хранится локально и запускается вместо этой
  if (!window.__lampa_gsync_boot) {
    try {
      var cachedVer = localStorage.getItem('gsync_code_version');
      var cachedCode = cachedVer && newerVersion(cachedVer, VERSION) && localStorage.getItem('gsync_code');
      if (cachedCode) {
        window.__lampa_gsync_boot = true;
        (0, eval)(cachedCode);
        return;
      }
    } catch (e) {}
  }
  if (window.__lampa_gsync) return;
  window.__lampa_gsync = true;

  var TAG = 'LampaSync';
  var MAX_ITEMS = 3000;
  var cfg = null;
  var applying = false;

  function log() {
    try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (e) {}
  }

  // Ключ из настроек: "<id gist>:<токен>" или только токен (тогда Gist найдём или создадим)
  function readKey() {
    var key = (Lampa.Storage.get('gsync_key', '') + '').trim();
    if (!key) return null;
    var parts = key.split(':');
    if (parts.length == 2 && parts[0] && parts[1]) return { gist: parts[0].trim(), token: parts[1].trim() };
    if (parts.length == 1) return { gist: '', token: key };
    return null;
  }

  var DATA_DESC = 'Lampa sync data';

  function gh(method, path, token, body) {
    return fetch('https://api.github.com' + path, {
      method: method, cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }

  // По одному токену находим свой секретный Gist с данными или создаём новый
  function ensureGist(c) {
    if (c.gist) return Promise.resolve(c);
    return gh('GET', '/gists?per_page=100', c.token).then(function (list) {
      var found = (list || []).filter(function (g) {
        return !g.public && (g.description || '').indexOf(DATA_DESC) === 0;
      })[0];
      if (found) return found.id;
      return gh('POST', '/gists', c.token, {
        description: DATA_DESC + ' (timecodes)', public: false,
        files: { 'timeline.json': { content: '{}' } }
      }).then(function (g) { return g.id; });
    }).then(function (id) {
      Lampa.Storage.set('gsync_key', id + ':' + c.token);
      return { gist: id, token: c.token };
    });
  }

  function connect(notify) {
    var c = readKey();
    cfg = null;
    if (!c) return;
    ensureGist(c).then(function (full) {
      cfg = full;
      if (notify) Lampa.Noty.show('Синхронизация подключена');
      pull();
    }, function (e) {
      setStatus(e);
      Lampa.Noty.show('Синхронизация: не удалось подключиться — ' + e.message + '. Проверьте токен (нужно право gist)');
    });
  }

  function addSettings() {
    if (!Lampa.SettingsApi) return;
    Lampa.SettingsApi.addComponent({
      component: 'gsync',
      name: 'Синхронизация таймкодов',
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>'
    });
    Lampa.SettingsApi.addParam({
      component: 'gsync',
      param: { name: 'gsync_key', type: 'input', values: '', default: '', placeholder: 'ghp_…' },
      field: { name: 'Ключ синхронизации', description: 'GitHub-токен с правом gist (одинаковый на всех своих устройствах)' },
      onChange: function () { connect(true); }
    });
    Lampa.SettingsApi.addParam({
      component: 'gsync',
      param: { name: 'gsync_apply_recommended', type: 'button' },
      field: { name: 'Применить рекомендуемые настройки', description: 'Парсер jac.red, TorrServer, плеер для этого устройства, плагины online_mod и rating' },
      onChange: function () { applyRecommended(); }
    });
  }

  // Последняя известная версия Gist и её ETag: при проверке без изменений GitHub
  // отвечает 304 (быстро, без тела и без расхода лимита запросов)
  var etag = null;
  var lastGist = null;

  function api(method, body, conditional) {
    var headers = {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };
    if (conditional && etag && lastGist) headers['If-None-Match'] = etag;
    return fetch('https://api.github.com/gists/' + cfg.gist, {
      method: method, cache: 'no-store', headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 304) return null;
      if (!r.ok) {
        var err = new Error('HTTP ' + r.status);
        err.status = r.status;
        err.retryAfter = Number(r.headers.get('Retry-After')) || 0;
        throw err;
      }
      var t = r.headers.get('ETag');
      return r.json().then(loadTruncated).then(function (gist) {
        lastGist = gist;
        if (t) etag = t;
        return gist;
      });
    });
  }

  // Файлы больше ~1 МБ GitHub отдаёт обрезанными — дочитываем их по raw_url,
  // иначе при записи можно затереть данные
  function loadTruncated(gist) {
    var files = (gist && gist.files) || {};
    return Promise.all(Object.keys(files).map(function (name) {
      var f = files[name];
      if (!f || !f.truncated || !f.raw_url) return null;
      return fetch(f.raw_url, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('raw ' + r.status);
        return r.text();
      }).then(function (t) { f.content = t; f.truncated = false; });
    })).then(function () { return gist; });
  }

  // {} — файла нет или он пустой; null — файл есть, но прочитать нельзя (тогда его не перезаписываем)
  function fileJson(gist, name) {
    var f = gist && gist.files && gist.files[name];
    if (!f || !f.content) return {};
    if (f.truncated) return null;
    try { var v = JSON.parse(f.content); return v && typeof v === 'object' ? v : {}; } catch (e) { return null; }
  }

  function prune(obj) {
    var keys = Object.keys(obj);
    if (keys.length <= MAX_ITEMS) return obj;
    keys.sort(function (a, b) { return (obj[b].updated || 0) - (obj[a].updated || 0); });
    var out = {};
    keys.slice(0, MAX_ITEMS).forEach(function (k) { out[k] = obj[k]; });
    return out;
  }

  // ---- Применить чужие таймкоды локально ----
  var lastApplied = 0;

  function applyRemote(remote) {
    var count = 0;
    lastApplied = 0;
    applying = true;
    try {
      Object.keys(remote).forEach(function (hash) {
        var r = remote[hash];
        if (!r || typeof r !== 'object') return;
        var local = Lampa.Timeline.view(hash) || {};
        if ((r.updated || 0) <= (local.updated || 0)) return;
        var params = {
          hash: hash, percent: r.percent || 0, time: r.time || 0, duration: r.duration || 0,
          updated: r.updated, received: true
        };
        if (r.card) { params.card = r.card; params.season = r.season; params.episode = r.episode; }
        Lampa.Timeline.update(params);
        count++;
      });
    } finally {
      applying = false;
    }
    lastApplied = count;
    if (count) log('applied', count);
  }

  // ---- IINA → TorrServer → Лампа (только на macOS) ----
  // Плагин IINA пишет время просмотра в TorrServer (/viewed). Лампа читает его
  // для недавних запусков, сохраняет как свой таймкод и сама отправляет в GitHub.
  function launches() {
    try { return JSON.parse(localStorage.getItem('gsync_launches') || '[]'); } catch (e) { return []; }
  }

  function saveLaunches(list) {
    try { localStorage.setItem('gsync_launches', JSON.stringify(list.slice(0, 30))); } catch (e) {}
  }

  function streamInfo(url) {
    var m = String(url || '').match(/^(https?:\/\/[^/]+)\/stream\/[^?]*\?(.*)$/);
    if (!m) return null;
    var q = {};
    m[2].split('&').forEach(function (kv) { var p = kv.split('='); q[p[0]] = decodeURIComponent(p[1] || ''); });
    return q.link && q.index ? { server: m[1], hash: q.link, index: Number(q.index) } : null;
  }

  function viewed(info, body) {
    return fetch(info.server + '/viewed', { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } });
  }

  function pollIina() {
    var recent = launches().filter(function (l) { return Date.now() - l.at < 3 * 3600 * 1000 && streamInfo(l.url); });
    if (!recent.length) return Promise.resolve();
    var list = launches();
    return Promise.all(recent.map(function (l) {
      var info = streamInfo(l.url);
      return viewed(info, { action: 'list', hash: info.hash }).then(function (rows) {
        var row = (rows || []).filter(function (r) { return r.file_index == info.index; })[0];
        if (!row || !row.timecode || row.timecode === l.tc) return;
        var local = Lampa.Timeline.view(l.hash) || {};
        var dur = local.duration || 0;
        Lampa.Timeline.update({
          hash: l.hash, time: row.timecode, duration: dur,
          percent: dur ? Math.min(100, Math.round(row.timecode / dur * 100)) : (local.percent || 1)
        }); // сработает listener и уйдёт в GitHub
        list.forEach(function (x) { if (x.url === l.url) x.tc = row.timecode; });
        saveLaunches(list);
        log('iina position', l.hash, row.timecode);
      }).catch(function () {});
    }));
  }

  // ---- Единый цикл синхронизации ----
  // Один запрос на чтение (условный) и, если есть что отправить, одна запись сразу всех файлов.
  // Синхронизируемые словари (ключ → запись с полем updated) и их файлы в Gist
  var MAPS = { timeline: 'timeline.json', pins: 'pins.json', last: 'last.json', library: 'library.json' };
  function emptyDirty() { return { timeline: {}, pins: {}, last: {}, library: {}, settings: false }; }
  var dirty = emptyDirty();
  var flushTimer = null;
  var queue = Promise.resolve();
  var lastWrite = 0;
  var urgentUntil = 0;
  var WRITE_GAP = 30000; // таймкоды во время просмотра пишем не чаще раза в 30 с
  var retryTimer = null;

  function hasDirty() {
    return Object.keys(MAPS).some(function (m) { return Object.keys(dirty[m]).length; }) || dirty.settings;
  }

  function scheduleFlush(ms) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { cycle().catch(function () {}); }, ms == null ? 1500 : ms);
  }

  // Статус синхронизации: красная кнопка в шапке и одно уведомление при ошибке ключа
  var headBtn = null;
  var warned = false;

  function setStatus(err) {
    if (headBtn) headBtn.css('color', err ? '#ff6b6b' : '');
    if (!err) { warned = false; return; }
    if (!warned && (err.status === 401 || err.status === 404)) {
      // 404: Gist удалён — при следующем подключении по токену создастся новый
      if (err.status === 404 && cfg) Lampa.Storage.set('gsync_key', cfg.token);
      warned = true;
      Lampa.Noty.show('Синхронизация не работает: проверьте ключ в настройках (' + err.message + ')');
    }
  }

  function scheduleRetry(err) {
    clearTimeout(retryTimer);
    var ms = err && err.retryAfter ? err.retryAfter * 1000 : (err && (err.status === 403 || err.status === 429) ? 120000 : 30000);
    retryTimer = setTimeout(function () { cycle().catch(function () {}); }, ms);
  }

  function mergeFile(remote, batch) {
    Object.keys(batch).forEach(function (k) {
      if ((batch[k].updated || 0) >= ((remote[k] && remote[k].updated) || 0)) remote[k] = batch[k];
    });
    return remote;
  }

  // GitHub — главная копия: при каждом новом чтении дозаливаем туда всё,
  // чего там нет или что у нас новее (таймкоды, раздачи, последние запуски, настройки)
  function reconcile(gist) {
    var remoteTl = fileJson(gist, 'timeline.json') || {};
    var local = Lampa.Storage.get(Lampa.Timeline.filename(), '{}');
    if (typeof local === 'string') { try { local = JSON.parse(local); } catch (e) { local = {}; } }
    Object.keys(local || {}).forEach(function (h) {
      var l = local[h];
      if (!l || typeof l !== 'object' || !(l.time > 0)) return;
      var r = remoteTl[h];
      if (!r || (l.updated || 0) > (r.updated || 0)) {
        var item = { time: l.time, duration: l.duration || 0, percent: l.percent || 0, updated: l.updated || 1 };
        if (l.card) { item.card = l.card; item.season = l.season; item.episode = l.episode; }
        dirty.timeline[h] = item;
      }
    });
    var remoteLast = normPins(fileJson(gist, 'last.json') || {}), localLast = allLast();
    Object.keys(localLast).forEach(function (k) {
      if (!remoteLast[k] || (localLast[k].updated || 0) > (remoteLast[k].updated || 0)) dirty.last[k] = localLast[k];
    });
    var remoteLib = normPins(fileJson(gist, 'library.json') || {}), localLib = allLib();
    Object.keys(localLib).forEach(function (k) {
      if (!remoteLib[k] || (localLib[k].updated || 0) > (remoteLib[k].updated || 0)) dirty.library[k] = localLib[k];
    });
    var remoteSet = fileJson(gist, 'settings.json') || {}, m = settingsMeta();
    SYNC_SETTINGS.forEach(function (name) {
      if (m[name] && m[name] > ((remoteSet[name] && remoteSet[name].updated) || 0)) dirty.settings = true;
    });
    // pins сверяет applyPins
  }

  // opts.force — читать без ETag (кнопка обновления)
  function cycle(opts) {
    opts = opts || {};
    if (!cfg) return Promise.reject(new Error('нет ключа'));
    clearTimeout(flushTimer);
    var run = queue.then(function () {
      var applied = 0;
      return api('GET', null, !opts.force).then(function (fresh) {
        if (fresh) {
          // Каждое новое состояние GitHub: применяем чужое и сверяем своё (самовосстановление
          // после потерянной записи, падения Лампы или работы без интернета)
          applyRemote(fileJson(fresh, 'timeline.json') || {});
          applied = lastApplied;
          applied += applyPins(fileJson(fresh, 'pins.json') || {});
          applied += applyLast(fileJson(fresh, 'last.json') || {});
          applied += applyLibrary(fileJson(fresh, 'library.json') || {});
          applied += applySettings(fileJson(fresh, 'settings.json') || {});
          reconcile(fresh);
          if (!backfillDone) { backfillDone = true; scheduleBackfill(500); }
        }
        if (!hasDirty()) return applied;
        var onlyTimeline = !Object.keys(dirty.pins).length && !Object.keys(dirty.last).length && !Object.keys(dirty.library).length && !dirty.settings;
        var wait = lastWrite + WRITE_GAP - Date.now();
        if (onlyTimeline && wait > 0 && !opts.force && !opts.final && Date.now() > urgentUntil) {
          scheduleFlush(wait + 100);
          return applied;
        }
        var batch = dirty;
        dirty = emptyDirty();
        var files = {};
        var keep = emptyDirty();
        Object.keys(MAPS).forEach(function (m) {
          if (!Object.keys(batch[m]).length) return;
          var base = fileJson(lastGist, MAPS[m]);
          if (base === null) { keep[m] = batch[m]; log('skip unreadable', MAPS[m]); return; }
          var merged = mergeFile(m === 'timeline' ? base : normPins(base), batch[m]);
          files[MAPS[m]] = { content: JSON.stringify(prune(merged)) };
        });
        Object.keys(MAPS).forEach(function (m) {
          Object.keys(keep[m]).forEach(function (k) { if (!dirty[m][k]) dirty[m][k] = keep[m][k]; });
        });
        if (batch.settings) {
          var remote = fileJson(lastGist, 'settings.json') || {}, sm = settingsMeta();
          SYNC_SETTINGS.forEach(function (name) {
            if (sm[name] && sm[name] >= ((remote[name] && remote[name].updated) || 0)) {
              remote[name] = { value: Lampa.Storage.get(name, ''), updated: sm[name] };
            }
          });
          files['settings.json'] = { content: JSON.stringify(remote) };
        }
        if (!Object.keys(files).length) return applied;
        return api('PATCH', { files: files }).then(function () {
          lastWrite = Date.now();
          log('pushed', Object.keys(files).join(','));
          return applied;
        }, function (e) {
          // вернуть неотправленное, повторить позже
          Object.keys(MAPS).forEach(function (m) {
            Object.keys(batch[m]).forEach(function (k) { if (!dirty[m][k]) dirty[m][k] = batch[m][k]; });
          });
          if (batch.settings) dirty.settings = true;
          throw e;
        });
      });
    });
    run.then(function () { setStatus(null); }, function (e) {
      log('sync fail', e.message);
      setStatus(e);
      scheduleRetry(e);
    });
    queue = run.catch(function () {});
    return run;
  }

  function pull(done) {
    if (typeof done !== 'function') done = null;
    if (!cfg) return done && done(new Error('нет ключа'));
    cycle().then(function (n) { if (done) done(null, n); }, function (e) { if (done) done(e); });
  }

  function push() { if (hasDirty()) cycle({ final: true }).catch(function () {}); }

  // ---- Кнопка «Обновить» в шапке ----
  // 1) синхронизировать всё сейчас, 2) проверить новую версию плагина на GitHub,
  // 3) перезагрузить Лампу (заново подтянутся Лампа, этот и остальные плагины)
  // API GitHub отдаёт файл без кэша (raw.githubusercontent и jsDelivr кэшируют)
  var REPO_API = 'https://api.github.com/repos/8bytsdvg/LampaSync/contents/lampa-sync.js?ref=main';
  var CDN_PURGE = 'https://purge.jsdelivr.net/gh/8bytsdvg/LampaSync@main/lampa-sync.js';

  // Новая версия с GitHub: сохраняем её код локально (запустится при следующем старте Лампы)
  // и заодно просим CDN сбросить кэш
  function checkPluginUpdate() {
    try { localStorage.setItem('gsync_update_check', String(Date.now())); } catch (e) {}
    var headers = { 'Accept': 'application/vnd.github.raw' };
    if (cfg) headers['Authorization'] = 'Bearer ' + cfg.token;
    return fetch(REPO_API, { cache: 'no-store', headers: headers }).then(function (r) {
      return r.ok ? r.text() : '';
    }).then(function (code) {
      var m = code.match(/var VERSION = '([0-9.]+)'/);
      if (!m || !newerVersion(m[1], VERSION) || code.indexOf('__lampa_gsync') < 0) return null;
      try {
        localStorage.setItem('gsync_code', code);
        localStorage.setItem('gsync_code_version', m[1]);
      } catch (e) { log('cache code fail', e.message); }
      fetch(CDN_PURGE, { mode: 'no-cors' }).catch(function () {});
      return m[1];
    }).catch(function () { return null; });
  }

  // Тихая проверка обновлений раз в 6 часов
  function autoUpdateCheck() {
    var last = 0;
    try { last = Number(localStorage.getItem('gsync_update_check')) || 0; } catch (e) {}
    if (Date.now() - last > 6 * 3600 * 1000) setTimeout(checkPluginUpdate, 20000);
  }

  function refreshAll() {
    if (!headBtn || headBtn.data('busy')) return;
    headBtn.data('busy', true).css('opacity', 0.4);
    Lampa.Noty.show('Обновление…');
    var isMac = Lampa.Platform.macOS && Lampa.Platform.macOS();
    var sync = (isMac ? pollIina() : Promise.resolve()).then(function () {
      return cfg ? cycle({ force: true, final: true }) : 0;
    });
    Promise.all([
      sync.then(function (n) { return { n: n }; }, function (e) { return { err: e }; }),
      checkPluginUpdate()
    ]).then(function (res) {
      var s = res[0], ver = res[1];
      var msg = s.err ? 'Синхронизация: ошибка — ' + s.err.message
        : (cfg ? (s.n ? 'Синхронизировано: ' + s.n : 'Данные актуальны') : 'Синхронизация не настроена');
      if (ver) msg += '. Новая версия ' + ver;
      Lampa.Noty.show(msg + '. Перезапуск…');
      setTimeout(function () { location.reload(); }, ver ? 3000 : 1500);
    });
  }

  function addHeadButton() {
    if (!Lampa.Head || !Lampa.Head.addIcon) return;
    var icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
    var btn = headBtn = Lampa.Head.addIcon(icon, refreshAll);
    btn.attr('title', 'Обновить');
    // Ставим сразу после поиска; поиск добавляется позже, поэтому ждём его
    var tries = 0;
    (function place() {
      var search = Lampa.Head.render().find('.open--search');
      if (search.length) search.after(btn);
      else if (tries++ < 50) setTimeout(place, 200);
    })();
  }

  function onUpdate(e) {
    if (applying || !e || !e.data || !e.data.road) return;
    var road = e.data.road;
    var item = {
      time: road.time || 0, duration: road.duration || 0, percent: road.percent || 0,
      updated: road.updated || Date.now()
    };
    if (road.card) { item.card = road.card; item.season = road.season; item.episode = road.episode; }
    dirty.timeline[e.data.hash] = item;
    scheduleFlush();
  }

  // ---- IINA: старт с нужной минуты + запоминание запуска ----
  function setupIina() {
    if (!(Lampa.Platform.macOS && Lampa.Platform.macOS())) return;
    var origEncode = window.encodeURIComponent;
    var target = null;

    // IINA 1.5 применяет mpv_start слишком поздно, поэтому к ссылке TorrServer
    // добавляется метка gsync_t — по ней перематывает плагин IINA.
    window.encodeURIComponent = function (s) {
      if (target && s === target.url) {
        var start = Math.floor(target.start);
        target = null;
        if (start > 5 && /\/stream/.test(s)) s = s + (s.indexOf('?') >= 0 ? '&' : '?') + 'gsync_t=' + start;
      }
      return origEncode(s);
    };

    Lampa.Player.listener.follow('create', function (e) {
      var data = e && e.data;
      target = null;
      if (!data || !data.url) return;
      var url;
      try { url = Lampa.Torserver.toPlayUrl(data.url); } catch (err) { url = data.url; }
      var tl = data.timeline || {};
      var finished = tl.percent >= 95;
      target = { url: url, start: finished ? 0 : (tl.time || 0) };
      setTimeout(function () { target = null; }, 2000);
      var info = streamInfo(url);
      if (tl.hash && info) {
        var startTc = Math.floor(target.start);
        var list = launches().filter(function (l) { return l.url !== url; });
        list.unshift({ url: url, hash: tl.hash, at: Date.now(), tc: startTc });
        saveLaunches(list);
        // точка отсчёта: любое другое время в TorrServer значит, что IINA сдвинулась
        viewed(info, { action: 'set', hash: info.hash, file_index: info.index, timecode: startTc }).catch(function () {});
      }
    });
  }

  // ---- Хранилища плагина с кэшем в памяти ----
  var storeCache = {};
  function readStore(key) {
    if (!storeCache[key]) {
      var p = Lampa.Storage.get(key, '{}');
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
      storeCache[key] = normPins(p || {});
    }
    return storeCache[key];
  }
  function writeStore(key, obj) {
    storeCache[key] = obj;
    Lampa.Storage.set(key, obj);
  }

  // ---- «Моя раздача»: закреплённый торрент для карточки ----
  var PINS = 'gsync_pins';
  var pinLaunch = false;

  // Ключ по номеру фильма: TMDB и CUB используют одни и те же номера, а на разных
  // устройствах одна и та же карточка может открываться через разные источники
  function cardKey(movie) {
    return movie && movie.id ? 'id_' + movie.id : '';
  }

  // Старые ключи вида tmdb_123 / cub_123 → id_123, при совпадении побеждает более свежая запись
  function normPins(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) {
      var m = k.match(/^(?:tmdb|cub)_(\d+)$/);
      var nk = m ? 'id_' + m[1] : k;
      if (!out[nk] || (obj[k].updated || 0) > (out[nk].updated || 0)) out[nk] = obj[k];
    });
    return out;
  }

  // Все записи, включая удалённые ({deleted: true}) — они нужны, чтобы удаление дошло до другого устройства
  function allPins() { return readStore(PINS); }

  function pins() {
    var all = allPins(), out = {};
    Object.keys(all).forEach(function (k) { if (!all[k].deleted) out[k] = all[k]; });
    return out;
  }

  function savePins(p, key) {
    writeStore(PINS, p);
    if (key) { dirty.pins[key] = p[key]; scheduleFlush(500); }
  }

  function applyPins(remote) {
    remote = normPins(remote);
    var local = allPins(), changed = 0;
    Object.keys(remote).forEach(function (k) {
      var r = remote[k];
      if (r && (r.updated || 0) > ((local[k] && local[k].updated) || 0)) { local[k] = r; changed++; }
    });
    // локальные записи, которых ещё нет в GitHub (закреплены до появления синхронизации)
    Object.keys(local).forEach(function (k) {
      if (!remote[k] || (local[k].updated || 0) > (remote[k].updated || 0)) dirty.pins[k] = local[k];
    });
    if (changed) { writeStore(PINS, local); log('pins applied', changed); refreshOpenCards(); }
    return changed;
  }

  // ---- Последняя запущенная раздача у карточки (для «Продолжить» без «Моей раздачи») ----
  var LAST = 'gsync_last';

  function allLast() { return readStore(LAST); }

  function rememberLast(movie, el) {
    var key = cardKey(movie);
    if (!key || !el || !(el.MagnetUri || el.Link)) return;
    var all = allLast();
    var prev = all[key];
    if (prev && (prev.MagnetUri || prev.Link) === (el.MagnetUri || el.Link) && Date.now() - (prev.updated || 0) < 60000) return;
    all[key] = {
      Title: el.Title || el.title, title: el.title || el.Title,
      MagnetUri: el.MagnetUri || '', Link: el.Link || '', Tracker: el.Tracker || '', size: el.size || '',
      updated: Date.now()
    };
    writeStore(LAST, prune(all));
    dirty.last[key] = all[key];
    scheduleFlush(500);
    setTimeout(refreshOpenCards, 0);
  }

  function applyLast(remote) {
    remote = normPins(remote);
    var local = allLast(), changed = 0;
    Object.keys(remote).forEach(function (k) {
      var r = remote[k];
      if (r && (r.updated || 0) > ((local[k] && local[k].updated) || 0)) { local[k] = r; changed++; }
    });
    if (changed) { writeStore(LAST, local); refreshOpenCards(); }
    return 0; // не считаем в «Обновлено: N»
  }

  function activeMovie() {
    var a = Lampa.Activity.active();
    return a && (a.movie || a.card);
  }

  function pinIcon(size) {
    size = size || 24;
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/></svg>';
  }

  var openCards = [];

  function pinButton() {
    // Без названия раздачи в атрибутах: тогда разметка кнопки одинакова у всех карточек,
    // и «Моя раздача», выбранная основным источником, работает для любой карточки
    return $('<div class="full-start__button selector view--gsync-pin">' + pinIcon() + '<span>Моя раздача</span></div>');
  }

  // Главная панель карточки: при «Моей раздаче» — кнопка «Продолжить» первой,
  // а «Смотреть» становится «Выбрать источник»
  var SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>';

  // Главная панель карточки: «Смотреть» → «Выбрать источник» с лупой;
  // «Продолжить» — «Моя раздача», а если её нет, последняя запущенная раздача
  function updateMainButtons(card, pin) {
    var main = card.body.find('.full-start-new__buttons');
    var play = main.find('.button--play');
    if (!play.data('gsync-icon')) {
      play.find('span').text('Выбрать источник');
      play.find('svg').replaceWith(SEARCH_ICON);
      play.data('gsync-icon', true);
    }
    var flags = libFlags(libEntry(card.movie));
    var bookBtn = main.find('.button--book');
    function ensure(cls, html, onEnter) {
      var b = main.find('.' + cls);
      if (!b.length) {
        b = $(html);
        b.on('hover:enter', onEnter);
        if (bookBtn.length) bookBtn.before(b); else main.append(b);
      }
      return b;
    }
    var later = ensure('gsync-later', '<div class="full-start__button selector gsync-later">' + LATER_ICON + '<span></span></div>', function () {
      var on = !libFlags(libEntry(card.movie)).later;
      setFlag(card.movie, 'later', on);
      Lampa.Noty.show(on ? 'Добавлено в «Позже»' : 'Убрано из «Позже»');
    });
    later.toggleClass('gsync-on', !!flags.later).find('span').text(flags.later ? 'В «Позже»' : 'Позже');
    var like = ensure('gsync-like', '<div class="full-start__button selector gsync-like">' + LIKE_ICON + '</div>', function () {
      var on = !libFlags(libEntry(card.movie)).like;
      setFlag(card.movie, 'like', on);
      Lampa.Noty.show(on ? 'Нравится ♥' : 'Убрано из «Нравится»');
    });
    like.toggleClass('gsync-on', !!flags.like);
    ensure('gsync-lib', '<div class="full-start__button selector gsync-lib">' + LIB_ICON + '</div>', function () {
      var enabled = Lampa.Controller.enabled().name;
      flagsMenu(card.movie, function () { Lampa.Controller.toggle(enabled); });
    });
    var hasTarget = !!(pin || allLast()[cardKey(card.movie)]);
    var cont = main.find('.gsync-continue');
    if (hasTarget && !cont.length) {
      cont = $('<div class="full-start__button selector gsync-continue"><svg><use xlink:href="#sprite-play"></use></svg><span>Продолжить</span></div>');
      cont.on('hover:enter', function () {
        var t = pins()[cardKey(card.movie)] || allLast()[cardKey(card.movie)];
        if (t) playPinned(t, card.movie);
      });
      main.prepend(cont);
    } else if (!hasTarget && cont.length) cont.remove();
  }

  function refreshCard(card) {
    if (!card.body || !document.body.contains(card.body[0])) return;
    var pin = pins()[cardKey(card.movie)];
    updateMainButtons(card, pin);
    var existing = card.body.find('.buttons--container .view--gsync-pin');
    if (existing.length && pin) { existing.data('subtitle', pin.title || pin.Title || ''); return; }
    existing.remove();
    if (!pin) return;
    var btn = pinButton();
    btn.data('subtitle', pin.title || pin.Title || '');
    btn.on('hover:enter', function () { playPinned(pins()[cardKey(card.movie)] || pin, card.movie); });
    card.body.find('.buttons--container').prepend(btn);
    // Основной источник — «Моя раздача»: ставим её копию на главную панель, как это делает Лампа
    var hash = Lampa.Utils.hash(btn.clone().removeClass('focus').prop('outerHTML'));
    if ((Lampa.Storage.get('full_btn_priority', '') + '') === hash + '') {
      var main = card.body.find('.full-start-new__buttons');
      main.find('.button--priority').remove();
      var clon = btn.clone().addClass('button--priority');
      clon.on('hover:enter', function () { btn.trigger('hover:enter'); });
      main.prepend(clon);
    }
  }

  function refreshOpenCards() {
    openCards = openCards.filter(function (c) { return document.body.contains(c.body[0]); });
    openCards.forEach(refreshCard);
  }

  function playPinned(pin, movie) {
    pinLaunch = true;
    rememberLast(movie, pin);
    var element = {};
    Object.keys(pin).forEach(function (k) { element[k] = pin[k]; });
    element.poster = movie.img || element.poster;
    Lampa.Torrent.start(element, movie);
  }


  // ---- Библиотека: просмотренное + флаги ----
  // Запись: { card: {...}, watched: <мс, когда смотрели> | 0, flags: { later: <мс>, ... }, updated }
  var LIB = 'gsync_library';
  var FLAGS = [
    { id: 'watching', title: 'Смотрю', color: '#3d8bfd' },
    { id: 'later', title: 'Позже', color: '#e6b422' },
    { id: 'planned', title: 'Запланировано', color: '#20c997' },
    { id: 'waiting', title: 'Жду продолжение', short: 'Жду', color: '#a66bff' },
    { id: 'like', title: 'Нравится', color: '#ff6b81' },
    { id: 'done', title: 'Просмотрено', color: '#8bc34a' },
    { id: 'dropped', title: 'Брошено', color: '#9e9e9e' }
  ];
  var LIB_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16.5 4.5l3.8 1-3.6 14.5-3.8-1z"/></svg>';
  var WATCHING_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M10 9l5 2.5-5 2.5z" fill="currentColor"/><path d="M8 21h8" stroke-linecap="round"/></svg>';
  var LIKE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/></svg>';
  var LATER_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  function allLib() { return readStore(LIB); }

  function libEntry(movie) { return allLib()[cardKey(movie)] || null; }

  function slimCard(movie) {
    var c;
    try { c = Lampa.Utils.clearCard(movie); } catch (e) { c = {}; }
    ['id', 'title', 'name', 'original_title', 'original_name', 'poster_path', 'backdrop_path',
      'release_date', 'first_air_date', 'vote_average', 'source', 'img'].forEach(function (f) {
      if (movie[f] !== undefined && c[f] === undefined) c[f] = movie[f];
    });
    if (!c.source) c.source = 'tmdb';
    delete c.overview; // описание не нужно для постера, а Gist раздувает
    return c;
  }

  function saveLib(key, entry) {
    var all = allLib();
    all[key] = entry;
    writeStore(LIB, prune(all));
    dirty.library[key] = entry;
    scheduleFlush(500);
    setTimeout(function () { refreshOpenCards(); decorateAll(); }, 0);
  }

  function libFlags(e) { return (e && !e.deleted && e.flags) || {}; }

  function setFlag(movie, flag, on) {
    var key = cardKey(movie);
    if (!key) return;
    var e = libEntry(movie);
    e = e && !e.deleted ? JSON.parse(JSON.stringify(e)) : { watched: 0, flags: {} };
    e.card = slimCard(movie);
    e.flags = e.flags || {};
    if (on) e.flags[flag] = Date.now(); else delete e.flags[flag];
    e.updated = Date.now();
    if (!e.watched && !Object.keys(e.flags).length) e = { deleted: true, updated: e.updated };
    saveLib(key, e);
  }

  function markWatched(movie) {
    var key = cardKey(movie);
    if (!key || !(movie.title || movie.name)) return;
    var e = libEntry(movie);
    // один запуск даёт несколько событий (история, торрент, плеер) — склеиваем их
    if (e && !e.deleted && Date.now() - (e.watched || 0) < 30 * 1000) return;
    e = e && !e.deleted ? JSON.parse(JSON.stringify(e)) : { flags: {} };
    e.card = slimCard(movie);
    e.watched = Date.now();
    e.updated = Date.now();
    saveLib(key, e);
  }

  // Перенос истории Лампы (локальной или CUB, если вошли в аккаунт) в «Библиотеку», сохраняя порядок.
  // Повторяемый: добавляет только фильмы, которых в библиотеке ещё нет (в т. ч. удалённых —
  // их «надгробия» не перезаписываются). История CUB приходит с сервера с задержкой, поэтому
  // перенос запускается несколько раз и после каждого обновления закладок.
  var backfillTimer = null;
  var backfillDone = false;
  function scheduleBackfill(ms) {
    clearTimeout(backfillTimer);
    backfillTimer = setTimeout(backfillHistory, ms || 3000);
  }

  function backfillHistory() {
    var hist = [];
    try { hist = Lampa.Favorite.get({ type: 'history' }) || []; } catch (e) { return; }
    var all = allLib(), oldest = Date.now();
    Object.keys(all).forEach(function (k) { if (all[k] && all[k].watched && all[k].watched < oldest) oldest = all[k].watched; });
    var added = 0;
    hist.forEach(function (card, i) {
      var key = cardKey(card);
      if (!key || !(card.title || card.name)) return;
      var e = all[key];
      if (e) return; // уже есть (с этого или другого устройства) или удалён пользователем
      var t = oldest - 1000 * (i + 1);
      e = { flags: {} };
      e.card = slimCard(card);
      e.watched = t;
      e.updated = t;
      all[key] = e;
      dirty.library[key] = e;
      added++;
    });
    if (added) {
      writeStore(LIB, prune(all));
      scheduleFlush(500);
      setTimeout(function () { refreshOpenCards(); decorateAll(); }, 0);
      log('history imported', added);
    }
  }

  function removeFromWatched(movie) {
    var key = cardKey(movie), e = libEntry(movie);
    if (!e || e.deleted) return;
    e = JSON.parse(JSON.stringify(e));
    e.watched = 0;
    e.updated = Date.now();
    saveLib(key, Object.keys(e.flags || {}).length ? e : { deleted: true, updated: e.updated });
  }

  function applyLibrary(remote) {
    remote = normPins(remote);
    var local = allLib(), changed = 0;
    Object.keys(remote).forEach(function (k) {
      var r = remote[k];
      if (r && (r.updated || 0) > ((local[k] && local[k].updated) || 0)) { local[k] = r; changed++; }
    });
    if (changed) { writeStore(LIB, local); refreshOpenCards(); decorateAll(); }
    return changed;
  }

  // Списки: 'watched' — то, что смотрели; иначе id флага. От свежего к старому
  function libList(filter) {
    var all = allLib(), out = [];
    Object.keys(all).forEach(function (k) {
      var e = all[k];
      if (!e || e.deleted || !e.card) return;
      var t = filter === 'watched' ? e.watched : (e.flags || {})[filter];
      if (t) out.push({ card: e.card, t: t });
    });
    out.sort(function (a, b) { return b.t - a.t; });
    return out.map(function (x) { return x.card; });
  }

  // Меню флагов фильма (галочки, можно несколько)
  function flagsMenu(movie, back) {
    var e = libEntry(movie), flags = libFlags(e);
    var items = FLAGS.map(function (f) {
      return { title: f.title, flag: f.id, checkbox: true, checked: !!flags[f.id] };
    });
    if (e && !e.deleted && e.watched) items.push({ title: 'Убрать из «Просмотренного»', unwatch: true });
    Lampa.Select.show({
      title: 'Библиотека',
      items: items,
      onCheck: function (a) { setFlag(movie, a.flag, !libFlags(libEntry(movie))[a.flag]); },
      onSelect: function (a) {
        if (a.unwatch) removeFromWatched(movie);
        else if (a.flag) setFlag(movie, a.flag, !libFlags(libEntry(movie))[a.flag]);
        back();
      },
      onBack: back
    });
  }

  // Экран категории библиотеки — стандартная сетка карточек Лампы
  function emptyTexts(filter) {
    return {
      title: 'Здесь пока пусто',
      descr: filter === 'watched'
        ? 'Сюда попадает всё, что вы начали смотреть'
        : 'Отметьте фильм: кнопка с книжками на странице фильма или долгое нажатие на постер'
    };
  }

  // Та же сетка, что у «Истории» Лампы (класс Category через Maker); старые версии Лампы —
  // через устаревший InteractionCategory
  function LibraryComponent(object) {
    var cards = libList(object.filter || 'watched');
    var PAGE = 60;
    function page(n) {
      return { results: cards.slice((n - 1) * PAGE, n * PAGE), total_pages: Math.ceil(cards.length / PAGE), page: n };
    }
    var M = Lampa.Maker;
    if (M && M.get && M.module && Lampa.Utils.createInstance && Lampa.Router) {
      var mod = M.module('Category');
      var comp = Lampa.Utils.createInstance(M.get('Category'), object, {
        module: mod.toggle(mod.MASK.base, 'Pagination'),
        empty: emptyTexts(object.filter)
      });
      comp.use({
        onCreate: function () {
          var self = this;
          if (!cards.length) return this.empty();
          setTimeout(function () { self.build(page(1)); }, 10);
        },
        onNext: function (resolve, reject) {
          var d = page(this.object.page);
          if (d.results.length) resolve.call(this, d); else reject.call(this);
        },
        onInstance: function (item, data) {
          item.use({
            onEnter: Lampa.Router.call.bind(Lampa.Router, 'full', data),
            onFocus: function () { try { Lampa.Background.change(Lampa.Utils.cardImgBackground(data)); } catch (e) {} }
          });
        }
      });
      return comp;
    }
    var old = new Lampa.InteractionCategory(object);
    old.create = function () {
      if (!cards.length) return this.empty();
      this.build(page(1));
    };
    old.nextPageReuest = function (obj, resolve, reject) {
      var d = page(obj.page);
      if (d.results.length) resolve(d); else reject();
    };
    var origEmpty = old.empty;
    old.empty = function () {
      origEmpty.call(this);
      try {
        var r = $(this.render(true)), t = emptyTexts(object.filter);
        r.find('.empty__title').text(t.title);
        r.find('.empty__descr').text(t.descr);
        r.find('.empty__footer').remove();
      } catch (e) {}
    };
    return old;
  }

  function openLibrary(filter) {
    var name = filter === 'watched' ? 'Просмотренное' : (FLAGS.filter(function (f) { return f.id === filter; })[0] || {}).title;
    Lampa.Activity.push({ url: '', title: filter === 'watched' ? 'Библиотека' : name, component: 'gsync_library', filter: filter, page: 1, source: 'tmdb' });
  }

  function chooseLibrary() {
    var enabled = Lampa.Controller.enabled().name;
    var items = [{ title: 'Библиотека (просмотренное)', subtitle: libList('watched').length + ' шт.', filter: 'watched' }]
      .concat(FLAGS.map(function (f) { return { title: f.title, subtitle: libList(f.id).length + ' шт.', filter: f.id }; }));
    Lampa.Select.show({
      title: 'Библиотека',
      items: items,
      onSelect: function (a) { openLibrary(a.filter); },
      onBack: function () { Lampa.Controller.toggle(enabled); }
    });
  }

  // Метки флагов на постерах (перерисовываются только при изменении флагов)
  var decorateQueued = false;
  function decorate(el, lib) {
    var data = el.card_data;
    if (!data || !data.id) return;
    var e = lib[cardKey(data)];
    var flags = libFlags(e);
    var sig = FLAGS.filter(function (f) { return flags[f.id]; }).map(function (f) { return f.id; }).join(',');
    if (el.__gsyncSig === sig) return;
    var view = el.querySelector && el.querySelector('.card__view');
    if (!view) return;
    el.__gsyncSig = sig;
    var old = view.querySelector('.gsync-flags');
    if (old) old.remove();
    if (!sig) return;
    var box = document.createElement('div');
    box.className = 'gsync-flags';
    FLAGS.filter(function (f) { return flags[f.id] && f.id !== 'like'; }).slice(0, 2).forEach(function (f) {
      var s = document.createElement('span');
      s.textContent = f.short || f.title;
      s.style.background = f.color;
      box.appendChild(s);
    });
    if (flags.like) {
      var h = document.createElement('span');
      h.textContent = '♥';
      h.style.background = '#ff6b81';
      box.appendChild(h);
    }
    view.appendChild(box);
  }

  function decorateAll() {
    if (decorateQueued) return;
    decorateQueued = true;
    setTimeout(function () {
      decorateQueued = false;
      var lib = allLib();
      var list = document.querySelectorAll('.card');
      for (var i = 0; i < list.length; i++) decorate(list[i], lib);
    }, 120);
  }

  function setupLibrary() {
    Lampa.Component.add('gsync_library', LibraryComponent);

    // Пункт в боковом меню
    var tries = 0;
    (function addMenu() {
      if (Lampa.Menu && Lampa.Menu.addButton) {
        try {
          var libItem = Lampa.Menu.addButton(LIB_ICON, 'Библиотека', function () { openLibrary('watched'); });
          if (libItem && libItem.on) libItem.on('hover:long', chooseLibrary);
          Lampa.Menu.addButton(WATCHING_ICON, 'Смотрю', function () { openLibrary('watching'); });
          Lampa.Menu.addButton(LATER_ICON, 'Позже', function () { openLibrary('later'); });
          return;
        } catch (e) {}
      }
      if (tries++ < 50) setTimeout(addMenu, 200);
    })();

    // Что начали смотреть — в «Просмотренное»: Лампа сама добавляет фильм в историю при запуске
    // (и со своим, и с внешним плеером); 'added' не берём — это подгрузка старой истории из CUB
    try {
      Lampa.Favorite.listener.follow('add', function (e) {
        if (e && e.where === 'history' && e.card && e.card.id) markWatched(e.card);
      });
    } catch (e) {}
    // История CUB подгружается с сервера с задержкой: повторяем перенос в первую минуту
    // и после каждого обновления закладок
    [15000, 40000, 70000].forEach(function (ms) { setTimeout(function () { scheduleBackfill(100); }, ms); });
    Lampa.Listener.follow('state:changed', function (e) {
      if (e && e.target === 'favorite') scheduleBackfill(3000);
    });
    Lampa.Player.listener.follow('create', function (e) {
      var d = e && e.data;
      // только фильм/серия (у них есть таймкод), а не трейлер
      if (!d || !(d.timeline || d.torrent_hash)) return;
      var movie = d.card || activeMovie();
      if (movie && movie.id) markWatched(movie);
    });
    Lampa.Listener.follow('torrent', function (e) {
      if (e.type === 'onenter') { var m = activeMovie(); if (m) markWatched(m); }
    });

    // Метки на новых постерах
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var n = muts[i].addedNodes;
          for (var j = 0; j < n.length; j++) {
            if (n[j].nodeType === 1 && !(n[j].classList && n[j].classList.contains('gsync-flags'))) { decorateAll(); return; }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}

    // Долгое нажатие на постер: пункт «Библиотека» первым в меню «Действие»
    var lastCard = null, lastAt = 0;
    document.addEventListener('hover:long', function (e) {
      var el = e.target;
      while (el && !el.card_data) el = el.parentNode;
      if (el && el.card_data) { lastCard = el.card_data; lastAt = Date.now(); }
    }, true);
    var origShow = Lampa.Select.show;
    Lampa.Select.show = function (params) {
      try {
        var isCardMenu = params && params.items && params.items.some(function (i) { return i.where === 'book' || i.where === 'like'; });
        if (isCardMenu && lastCard && Date.now() - lastAt < 2000) {
          var movie = lastCard, enabled = Lampa.Controller.enabled().name;
          var current = FLAGS.filter(function (f) { return libFlags(libEntry(movie))[f.id]; }).map(function (f) { return f.title; }).join(', ');
          params.items = [{
            title: 'Библиотека…',
            subtitle: current || 'Позже, Запланировано, Жду продолжение, Нравится…',
            onSelect: function () {
              setTimeout(function () { flagsMenu(movie, function () { Lampa.Controller.toggle(enabled); }); }, 50);
            }
          }].concat(params.items);
          lastCard = null;
        }
      } catch (err) { log('menu hook fail', err.message); }
      return origShow.apply(this, arguments);
    };
  }

  function setupPins() {
    // Запуск раздачи из списка — запоминаем как последнюю для «Продолжить»
    Lampa.Listener.follow('torrent', function (e) {
      if (e.type === 'onenter' && e.element) rememberLast(activeMovie(), e.element);
    });

    // Мак: скопировать magnet-ссылку, чтобы вставить её в qBittorrent (Файл → Добавить ссылку)
    Lampa.Listener.follow('torrent', function (e) {
      if (e.type !== 'onlong' || !e.menu || !e.element) return;
      if (!(Lampa.Platform.macOS && Lampa.Platform.macOS())) return;
      var link = e.element.MagnetUri || e.element.Link;
      if (!link) return;
      e.menu.push({
        title: 'Скачать: скопировать magnet-ссылку',
        subtitle: 'Вставьте в qBittorrent: Файл → Добавить ссылку на торрент',
        onSelect: function () {
          Lampa.Utils.copyTextToClipboard(link, function () {
            Lampa.Noty.show('Magnet-ссылка скопирована — вставьте её в qBittorrent');
          }, function () {
            Lampa.Noty.show('Не удалось скопировать ссылку');
          });
          Lampa.Controller.toggle('content');
        }
      });
    });

    // Меню по долгому нажатию на раздаче
    Lampa.Listener.follow('torrent', function (e) {
      if (e.type !== 'onlong' || !e.menu) return;
      var movie = activeMovie();
      var key = cardKey(movie);
      if (!key) return;
      var el = e.element;
      var current = pins()[key];
      var isThis = current && (current.MagnetUri || current.Link) === (el.MagnetUri || el.Link);
      // «Моя раздача» у карточки только одна: другую можно выбрать, лишь убрав текущую
      if (current && !isThis) {
        e.menu.unshift({
          title: 'Уже выбрана «Моя раздача»',
          subtitle: 'Чтобы выбрать эту, сначала уберите текущую (она стоит первой в списке)',
          onSelect: function () {
            Lampa.Noty.show('Сначала уберите текущую «Мою раздачу»');
            Lampa.Controller.toggle('content');
          }
        });
        return;
      }
      e.menu.unshift({
        title: isThis ? 'Убрать из «Моей раздачи»' : 'Сделать «Моей раздачей»',
        subtitle: isThis ? 'Кнопка на карточке пропадёт' : 'Кнопка на карточке будет сразу запускать эту раздачу',
        onSelect: function () {
          var p = allPins();
          if (isThis) {
            p[key] = { deleted: true, updated: Date.now() };
            Lampa.Noty.show('«Моя раздача» сброшена');
          } else {
            p[key] = {
              Title: el.Title || el.title, title: el.title || el.Title,
              MagnetUri: el.MagnetUri || '', Link: el.Link || '',
              Tracker: el.Tracker || '', size: el.size || '',
              updated: Date.now()
            };
            Lampa.Noty.show('Закреплено: ' + (el.title || el.Title));
          }
          savePins(p, key);
          refreshOpenCards();
          $('.gsync-pinned').removeClass('gsync-pinned').find('.gsync-pin-badge').remove();
          if (!isThis && e.item) {
            e.item.addClass('gsync-pinned');
            e.item.find('.torrent-item__title').prepend('<span class="gsync-pin-badge">' + pinIcon(16) + ' Моя раздача</span> ');
          }
          Lampa.Controller.toggle('content');
        }
      });
    });

    // Кнопка «Моя раздача» на карточке (появляется и в списке «Смотреть»).
    // Открытые карточки запоминаются, чтобы кнопка сразу появлялась/пропадала
    // после закрепления здесь или на другом устройстве.
    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite') return;
      var movie = e.data && e.data.movie;
      if (!cardKey(movie)) return;
      var card = { movie: movie, body: e.body };
      openCards.push(card);
      if (openCards.length > 10) openCards.shift();
      refreshCard(card);
    });

    // В списке раздач: «Моя раздача» подписана и стоит первой
    Lampa.Listener.follow('torrent', function (e) {
      if (e.type !== 'render' || !e.item || !e.element) return;
      var pin = pins()[cardKey(activeMovie())];
      if (!pin || (pin.MagnetUri || pin.Link) !== (e.element.MagnetUri || e.element.Link)) return;
      e.item.addClass('gsync-pinned');
      e.item.find('.torrent-item__title').prepend('<span class="gsync-pin-badge">' + pinIcon(16) + ' Моя раздача</span> ');
      setTimeout(function () {
        var list = e.item.parent();
        var first = list.children('.torrent-item').first();
        if (first.length && first[0] !== e.item[0]) first.before(e.item);
      }, 0);
    });

    // Раздача из одного видеофайла — сразу в плеер, без окна «Файлы» и 10-секундного отсчёта.
    // Если файлов несколько (сериал), список остаётся.
    Lampa.Listener.follow('torrent_file', function (e) {
      if (e.type === 'list_close') pinLaunch = false;
      if (e.type === 'render' && e.items && e.items.length === 1 && e.item) {
        pinLaunch = false;
        setTimeout(function () { e.item.trigger('hover:enter'); }, 50);
      } else if (e.type === 'render') pinLaunch = false;
    });
  }

  // ---- Синхронизация настроек: основной источник на карточке ----
  var SYNC_SETTINGS = ['full_btn_priority'];
  var applyingSettings = false;

  function settingsMeta() {
    try { return JSON.parse(localStorage.getItem('gsync_settings_meta') || '{}'); } catch (e) { return {}; }
  }

  function saveSettingsMeta(m) {
    try { localStorage.setItem('gsync_settings_meta', JSON.stringify(m)); } catch (e) {}
  }

  function setupSettingsSync() {
    Lampa.Storage.listener.follow('change', function (e) {
      if (applyingSettings || SYNC_SETTINGS.indexOf(e.name) < 0) return;
      var m = settingsMeta();
      m[e.name] = Date.now();
      saveSettingsMeta(m);
      dirty.settings = true;
      scheduleFlush(500);
      if (e.name === 'full_btn_priority') refreshOpenCards();
    });
  }

  function applySettings(remote) {
    var m = settingsMeta(), changed = 0;
    SYNC_SETTINGS.forEach(function (name) {
      var r = remote[name];
      if (!r || (r.updated || 0) <= (m[name] || 0)) return;
      applyingSettings = true;
      try { Lampa.Storage.set(name, r.value); } finally { applyingSettings = false; }
      m[name] = r.updated;
      changed++;
    });
    if (changed) { saveSettingsMeta(m); refreshOpenCards(); log('settings applied', changed); }
    return changed;
  }

  // ---- Рекомендуемые настройки (как на нашем ТВ и Маке) ----
  var EXTRA_PLUGINS = [
    { url: 'https://nb557.github.io/plugins/online_mod.js', name: 'online_mod' },
    { url: 'https://nb557.github.io/plugins/rating.js', name: 'rating' }
  ];

  function recommended() {
    var set = {
      parser_use: true, parser_torrent_type: 'jackett', parser_use_link: 'one',
      jackett_url: 'jac.red', jackett_key: '', parse_lang: 'df_year', parse_in_search: true
    };
    // TorrServer на этом же устройстве, если адрес ещё не задан
    if (!(Lampa.Storage.get('torrserver_url', '') + '')) { set.torrserver_use_link = 'one'; set.torrserver_url = '127.0.0.1:8090'; }
    if (Lampa.Platform.macOS && Lampa.Platform.macOS()) {
      set.player = 'iina'; set.player_torrent = 'iina'; set.player_iptv = 'iina';
    } else if (Lampa.Platform.is && Lampa.Platform.is('android')) {
      set.player_torrent = 'android'; // внешний плеер (Just+ Player)
    }
    return set;
  }

  function applyRecommended() {
    var set = recommended();
    Object.keys(set).forEach(function (k) { Lampa.Storage.set(k, set[k]); });
    var list = Lampa.Storage.get('plugins', '[]');
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch (e) { list = []; } }
    list = list || [];
    var added = 0;
    EXTRA_PLUGINS.forEach(function (pl) {
      var has = list.some(function (x) { return ((x && x.url) || x) === pl.url; });
      if (!has) { list.push({ url: pl.url, status: 1, name: pl.name }); added++; }
    });
    Lampa.Storage.set('plugins', list);
    Lampa.Storage.set('gsync_setup_done', true);
    Lampa.Noty.show('Настройки применены' + (added ? ', плагины добавлены. Перезапуск…' : ''));
    if (added) setTimeout(function () { location.reload(); }, 2500);
  }

  function offerSetup() {
    if (Lampa.Storage.get('gsync_setup_done', false)) return;
    Lampa.Storage.set('gsync_setup_done', true);
    setTimeout(function () {
      try {
      var enabled = Lampa.Controller.enabled().name;
      Lampa.Select.show({
        title: 'Lampa Sync: применить рекомендуемые настройки?',
        items: [
          { title: 'Да, применить', subtitle: 'Парсер jac.red, TorrServer 127.0.0.1:8090, плеер, плагины online_mod и rating', ok: true },
          { title: 'Нет, оставить как есть', subtitle: 'Можно применить позже: Настройки → Синхронизация таймкодов' }
        ],
        onSelect: function (a) { Lampa.Controller.toggle(enabled); if (a.ok) applyRecommended(); },
        onBack: function () { Lampa.Controller.toggle(enabled); }
      });
      } catch (e) { log('setup offer fail', e.message); }
    }, 3000);
  }

  function addStyles() {
    $('head').append('<style>.gsync-flags{position:absolute;left:0.4em;bottom:0.4em;display:flex;gap:0.25em;flex-wrap:wrap;z-index:2;pointer-events:none}' +
      '.gsync-flags span{color:#fff;font-size:0.75em;font-weight:600;padding:0.15em 0.45em;border-radius:0.35em;box-shadow:0 0.1em 0.3em rgba(0,0,0,.4)}' +
      '.gsync-later.gsync-on svg{color:#e6b422}.gsync-like.gsync-on svg{color:#ff6b81;fill:#ff6b81}' +
      '.gsync-pinned{box-shadow:inset 0 0 0 0.2em #e6b422;border-radius:0.6em}' +
      '.gsync-pin-badge{display:inline-flex;align-items:center;gap:0.3em;color:#e6b422;font-weight:600;margin-right:0.4em}' +
      '.gsync-pin-badge svg{width:1em;height:1em}</style>');
  }

  // Мак: Лампа отменяет действие браузера у любой клавиши (рассчитана на пульт),
  // из-за этого в приложении Safari «не срабатывают» ⌘Q, ⌘W, ⌘C/⌘V и т. п.
  // Перехватываем сочетания с ⌘ раньше Лампы и пропускаем их к macOS.
  function passMacShortcuts() {
    if (!(Lampa.Platform.macOS && Lampa.Platform.macOS())) return;
    var pass = function (e) { if (e.metaKey) e.stopImmediatePropagation(); };
    window.addEventListener('keydown', pass, true);
    window.addEventListener('keyup', pass, true);
  }

  function start() {
    passMacShortcuts();
    addStyles();
    setupSettingsSync();
    setupPins();
    try { setupLibrary(); } catch (e) { log('library setup fail', e.message); }
    addSettings();
    addHeadButton();
    offerSetup();
    Lampa.Timeline.listener.follow('update', onUpdate);
    setupIina();
    connect(false);
    autoUpdateCheck();
    // Пока Лампа на экране — проверка каждые 20 с (условный запрос: без изменений это почти бесплатно).
    // На Маке время из IINA читается из TorrServer каждые 10 с, даже в фоне.
    var ticks = 0;
    setInterval(function () {
      ticks++;
      if (Lampa.Platform.macOS && Lampa.Platform.macOS()) pollIina();
      if (!document.hidden && ticks % 2 === 0 && cfg) pull();
    }, 10000);
    // После возврата в Лампу (выход из плеера) 15 с пишем таймкоды сразу, без паузы в 30 с
    function back() { urgentUntil = Date.now() + 15000; pollIina(); pull(); }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) back(); else push();
    });
    window.addEventListener('focus', back);
    window.addEventListener('pagehide', push);
    log('ready', VERSION);
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type == 'ready') start(); });
})();
