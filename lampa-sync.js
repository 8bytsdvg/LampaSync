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
  if (window.__lampa_gsync) return;
  window.__lampa_gsync = true;
  var VERSION = '1.1.0';

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
  var MAPS = { timeline: 'timeline.json', pins: 'pins.json', last: 'last.json' };
  function emptyDirty() { return { timeline: {}, pins: {}, last: {}, settings: false }; }
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
          applied += applySettings(fileJson(fresh, 'settings.json') || {});
          reconcile(fresh);
        }
        if (!hasDirty()) return applied;
        var onlyTimeline = !Object.keys(dirty.pins).length && !Object.keys(dirty.last).length && !dirty.settings;
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
  var REPO_RAW = 'https://raw.githubusercontent.com/8bytsdvg/LampaSync/main/lampa-sync.js';
  var CDN_PURGE = 'https://purge.jsdelivr.net/gh/8bytsdvg/LampaSync@main/lampa-sync.js';

  function newerVersion(a, b) {
    var x = String(a).split('.'), y = String(b).split('.');
    for (var i = 0; i < 3; i++) {
      var d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
      if (d) return d > 0;
    }
    return false;
  }

  function checkPluginUpdate() {
    return fetch(REPO_RAW + '?t=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.text() : '';
    }).then(function (code) {
      var m = code.match(/var VERSION = '([0-9.]+)'/);
      if (!m || !newerVersion(m[1], VERSION)) return null;
      // сбросить кэш CDN, чтобы при перезагрузке скачалась новая версия
      return fetch(CDN_PURGE, { mode: 'no-cors' }).catch(function () {}).then(function () { return m[1]; });
    }).catch(function () { return null; });
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
  function allPins() {
    var p = Lampa.Storage.get(PINS, '{}');
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    return normPins(p);
  }

  function pins() {
    var all = allPins(), out = {};
    Object.keys(all).forEach(function (k) { if (!all[k].deleted) out[k] = all[k]; });
    return out;
  }

  function savePins(p, key) {
    Lampa.Storage.set(PINS, p);
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
    if (changed) { Lampa.Storage.set(PINS, local); log('pins applied', changed); refreshOpenCards(); }
    return changed;
  }

  // ---- Последняя запущенная раздача у карточки (для «Продолжить» без «Моей раздачи») ----
  var LAST = 'gsync_last';

  function allLast() {
    var p = Lampa.Storage.get(LAST, '{}');
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    return normPins(p);
  }

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
    Lampa.Storage.set(LAST, prune(all));
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
    if (changed) { Lampa.Storage.set(LAST, local); refreshOpenCards(); }
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
    var label = play.find('span');
    label.text('Выбрать источник');
    if (!play.data('gsync-icon')) {
      play.find('svg').replaceWith(SEARCH_ICON);
      play.data('gsync-icon', true);
    }
    main.find('.gsync-continue').remove();
    var target = pin || allLast()[cardKey(card.movie)];
    if (!target) return;
    var cont = $('<div class="full-start__button selector gsync-continue">' +
      '<svg><use xlink:href="#sprite-play"></use></svg><span>Продолжить</span></div>');
    cont.on('hover:enter', function () {
      var t = pins()[cardKey(card.movie)] || allLast()[cardKey(card.movie)];
      if (t) playPinned(t, card.movie);
    });
    main.prepend(cont);
  }

  function refreshCard(card) {
    if (!card.body || !document.body.contains(card.body[0])) return;
    var pin = pins()[cardKey(card.movie)];
    card.body.find('.view--gsync-pin').remove();
    updateMainButtons(card, pin);
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
    $('head').append('<style>.gsync-pinned{box-shadow:inset 0 0 0 0.2em #e6b422;border-radius:0.6em}' +
      '.gsync-pin-badge{display:inline-flex;align-items:center;gap:0.3em;color:#e6b422;font-weight:600;margin-right:0.4em}' +
      '.gsync-pin-badge svg{width:1em;height:1em}</style>');
  }

  function start() {
    addStyles();
    setupSettingsSync();
    setupPins();
    addSettings();
    addHeadButton();
    offerSetup();
    Lampa.Timeline.listener.follow('update', onUpdate);
    setupIina();
    connect(false);
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
