# AGENTS.md — как устроен Lampa Sync

Документ для разработчиков и ИИ-агентов, которые дорабатывают проект (например, подключают другой плеер на Windows).

## Состав

| Путь | Что это |
|---|---|
| `lampa-sync.js` | Единственный плагин Лампы. Без сборки, ES5, работает в WebView Android TV, Safari и NW.js |
| `iina/lampa-sync.iinaplugin/` | Плагин IINA (macOS): пишет позицию просмотра в TorrServer |
| `torrserver-menubar/` | Фоновый Swift-помощник macOS без значка: LaunchAgent `local.torrserver.menu` (KeepAlive, флаг `--background`); по `NSWorkspace` didLaunch/didTerminate включает TorrServer вместе с `~/Applications/Lampa.app` и выключает при её закрытии; перезапуск упавшего сервера (≤3 раз/мин); по SIGTERM останавливает сервер; при старте без Лампы убивает осиротевший сервер; повторное открытие `.app` — ручное вкл/выкл |
| `tests/sync.test.mjs` | Симуляция двух устройств и GitHub API; `node tests/sync.test.mjs` |

Плагин раздаётся через jsDelivr: `https://cdn.jsdelivr.net/gh/8bytsdvg/LampaSync@main/lampa-sync.js`. jsDelivr кэширует ветку до 12 ч, поэтому плагин обновляет себя сам: раз в 6 ч (и по кнопке «Обновить») берёт `lampa-sync.js` через API GitHub (`/repos/8bytsdvg/LampaSync/contents/lampa-sync.js`, без кэша); если `VERSION` новее — кладёт код в `localStorage` (`gsync_code`, `gsync_code_version`), и при следующем старте загрузчик в начале файла запускает его вместо копии с CDN (`window.__lampa_gsync_boot`). После пуша в `main` всё равно полезно сбросить кэш jsDelivr — для новых установок:
```
curl https://purge.jsdelivr.net/gh/8bytsdvg/LampaSync@main/lampa-sync.js
```

## Хранилище: секретный Gist пользователя

Ключ в настройках (`Lampa.Storage` `gsync_key`) — `"<gist id>:<token>"` либо только токен; тогда `ensureGist()` ищет секретный Gist с описанием, начинающимся с `Lampa sync data`, или создаёт его, и сохраняет `id:token`.

Файлы Gist — словари «ключ → запись», в каждой записи `updated` (мс, `Date.now()` устройства-автора):

| Файл | Ключ | Запись |
|---|---|---|
| `timeline.json` | хеш файла Лампы (`Lampa.Timeline`) | `{time, duration, percent, updated, card?, season?, episode?}` |
| `pins.json` | `id_<tmdb id>` | «Моя раздача»: `{title, Title, MagnetUri, Link, Tracker, size, updated}` или `{deleted: true, updated}` |
| `last.json` | `id_<tmdb id>` | последняя запущенная раздача, тот же формат |
| `settings.json` | имя настройки Лампы | `{value, updated}` (сейчас только `full_btn_priority`) |
| `library.json` | `id_<tmdb id>` | «Библиотека»: `{card, watched: мс\|0, flags: {watching, later, planned, waiting, like, done, dropped: мс}, updated}` или `{deleted: true, updated}` |

Старые ключи `tmdb_<id>` / `cub_<id>` нормализуются в `id_<id>` при чтении (`normPins`).

**Правило слияния везде одно: побеждает запись с большим `updated`.** Удаление «Моей раздачи» — запись-«надгробие» `deleted: true`, чтобы оно дошло до других устройств.

## Цикл синхронизации (`cycle()`)

1. `GET /gists/:id` с `If-None-Match` (ETag). 304 → изменений нет, запрос не расходует лимит.
2. Если пришла новая версия: применить чужое (`applyRemote`, `applyPins`, `applyLast`, `applySettings`), затем `reconcile()` — собрать в очередь всё локальное, чего в Gist нет или что новее. Это и есть «GitHub — главная копия» плюс самовосстановление после потерянной записи, падения Лампы и работы без интернета.
3. Если очередь не пуста — один `PATCH` со всеми изменёнными файлами (содержимое = файл из GET + очередь, слияние по `updated`).
4. Ошибка → очередь возвращается, повтор через 30 с (403/429 — по `Retry-After` или через 2 мин). 401/404 → кнопка в шапке красная, одно уведомление.

Защиты:
- Файл, который не удалось прочитать (битый JSON), **не перезаписывается** (`fileJson` возвращает `null`).
- Файлы > 1 МБ GitHub обрезает (`truncated`) — дочитываются по `raw_url`.
- Таймкоды во время просмотра пишутся не чаще раза в 30 с (`WRITE_GAP`); «Моя раздача», последняя раздача и настройки — сразу; после возврата в Лампу (15 с) и при её сворачивании — сразу (`urgentUntil`, `push({final})`).
- Запросы сериализованы через `queue`.

Производительность: хранилища плагина (`gsync_pins`, `gsync_last`, `gsync_library`) читаются из `localStorage` один раз и дальше живут в памяти (`readStore`/`writeStore`); метки на постерах перерисовываются только при изменении флагов (`el.__gsyncSig`); кнопки карточки обновляются на месте, а не пересоздаются (иначе теряется фокус пульта).

Расписание: при старте; каждые 20 с, пока страница видима; при `visibilitychange`/`focus`; кнопка в шапке — принудительно без ETag.

## Точки встраивания в Лампу

| Событие / API | Зачем |
|---|---|
| `Lampa.Timeline.listener 'update'` | любой новый таймкод → очередь (кроме применяемых нами, флаг `applying`) |
| `Lampa.Timeline.update({…, received: true})` | применить чужой таймкод, не меняя `updated` |
| `Lampa.Listener 'torrent'` `onenter` / `onlong` / `render` | запоминание последней раздачи, меню «Моя раздача», подсветка в списке |
| `Lampa.Listener 'torrent_file'` `render` | автозапуск фильма из одного файла после «Продолжить» |
| `Lampa.Listener 'full'` `complite` | кнопки «Продолжить» / «Выбрать источник» на карточке (`refreshCard`) |
| `Lampa.Torrent.start(element, movie)` | запуск раздачи без поиска |
| `Lampa.Player.listener 'create'` | macOS: стартовая позиция для IINA и запись запуска |
| `Lampa.SettingsApi` | раздел «Синхронизация таймкодов» |
| `Lampa.Head.addIcon` | кнопка «Обновить» (после `.open--search`): `refreshAll()` — `pollIina` (Mac) → `cycle({force, final})` → проверка `VERSION` через API GitHub → при новой версии сброс кэша jsDelivr → `location.reload()` |

## Как время из внешнего плеера попадает в Лампу

Синхронизации всё равно, откуда таймкод: ей достаточно, чтобы плеер так или иначе вызвал `Lampa.Timeline.update`.

- **Android TV.** Нативная оболочка Лампы (`top.rootu.lampa`) получает позицию от плеера: Just+ Player — отчётами во время просмотра (лучший вариант), MX/Just Player/VLC/MPV/ViMu — при закрытии.
- **macOS + IINA.** IINA не сообщает позицию Лампе. Поэтому: Лампа добавляет к ссылке TorrServer метку `gsync_t=<секунды>` → плагин IINA перематывает и каждые 10 с пишет позицию в TorrServer (`POST /viewed {action:"set", hash, file_index, timecode}`) → `pollIina()` в Лампе читает `/viewed` и вызывает `Timeline.update`. В TorrServer должно быть включено `TrackTimecode`.
- **Windows (Lampa Desktop, NW.js).** В Лампе уже есть модуль внешних плееров: VLC, MPC-HC, MPC-BE, MPC-QT, KMPlayer (тип определяется по пути `player_nw_path`). Лампа запускает плеер и опрашивает его веб-интерфейс (порт 3999; VLC — пароль `123456`), а при закрытии записывает таймкод. **Дорабатывать ничего не нужно** — плагин подхватит этот таймкод.

### Если нужен другой плеер на Windows (mpv, PotPlayer и т. п.)

Повторите схему IINA:
1. Плеер при открытии ссылки `http://127.0.0.1:8090/stream/...?link=<hash>&index=<n>&play[&gsync_t=<сек>]` перематывает на `gsync_t`.
2. Раз в 5–10 с и при закрытии плеер (или его скрипт: для mpv — Lua-скрипт с `observe_property("time-pos")`) отправляет `POST http://127.0.0.1:8090/viewed` с `{"action":"set","hash":"<hash>","file_index":<n>,"timecode":<сек>}`.
3. В `lampa-sync.js` расширьте условия: `setupIina()` и `pollIina()` сейчас работают только при `Lampa.Platform.macOS()`. Добавьте свою платформу (`Lampa.Platform.desktop()`), а запуск плеера — через `player_nw_path` или собственный обработчик `Lampa.Player.listener 'create'`.
4. Добавьте проверку в `tests/sync.test.mjs`.

## Правила для изменений

- Сохраняйте ключи хранилища (`gsync_*`, имена файлов Gist) — на них уже работают устройства пользователей. Новые данные — новый файл в `MAPS` с полем `updated`.
- Никогда не перезаписывайте файл Gist, который не удалось прочитать.
- Меняете цикл синхронизации — прогоните `node tests/sync.test.mjs` (все проверки должны пройти).
- Секреты (токены, ID Gist) в репозиторий не коммитить.
- После пуша в `main` — сброс кэша jsDelivr (см. выше).
- Меняя плагин, повышайте `VERSION` в `lampa-sync.js`: по ней кнопка «Обновить» понимает, что вышла новая версия.
