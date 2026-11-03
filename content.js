// Скачивание видео открытого канала/чата в Telegram Web K — по периодам, с папками и историей.
// Работает в контексте страницы (world: MAIN) и пользуется функциями самого клиента:
//   rootScope.managers.appMessagesManager.getHistory({inputFilter: видео}) — список видео;
//   appDownloadManager.downloadToDisc({media, fileName}) — родная загрузка на диск через service worker.
// Путь с папками: перед загрузкой шлём фону «ожидание» {name, path}, background.js подставляет путь.
// История — в chrome.storage.local через bridge.js.
// Каналы с запретом сохранения контента (noforwards) пропускаются — так же, как это делает сам клиент.
(() => {
  'use strict';
  if (window.__tgVideoDl) return;
  window.__tgVideoDl = true;

  const PAGE = 50;
  const DAY = 86400;
  const MARK = 'tgvdl~~';
  const DEF_MASK = 'Telegram/{channel}/{yyyy}-{mm}/{date}_{id}_{name}.{ext}';
  const SETTINGS_KEY = 'tgvdl-settings';

  let state = 'idle';   // idle | scanning | downloading | stopping
  let plan = null;      // {peerId, title, from, to, queue:[...], rest, restBytes, limited}

  // ---------- Связь с фоном ----------
  let rpcSeq = 0;
  const rpcWait = new Map();
  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.tgvdl !== 'res') return;
    const w = rpcWait.get(e.data.id);
    if (w) { rpcWait.delete(e.data.id); e.data.err ? w.reject(new Error(e.data.err)) : w.resolve(e.data.res); }
  });
  const rpc = msg => new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    rpcWait.set(id, { resolve, reject });
    window.postMessage({ tgvdl: 'req', id, msg }, location.origin);
    setTimeout(() => { if (rpcWait.delete(id)) reject(new Error('расширение не отвечает — обновите вкладку')); }, 10000);
  });

  // История одного чата: {title, files: {mid: [date, size]}, covered: [[from,to],...], sessions: [...]}
  async function loadHist(peerId, title) {
    const key = 'h:' + peerId;
    const h = (await rpc({ op: 'get', keys: [key] }))?.[key] || { files: {}, covered: [], sessions: [] };
    if (title) h.title = title;
    // Перенос отметок из версии 1.0 (localStorage).
    const old = localStorage.getItem('tgvdl-done:' + peerId);
    if (old) {
      for (const mid of JSON.parse(old)) if (!h.files[mid]) h.files[mid] = [0, 0];
      localStorage.removeItem('tgvdl-done:' + peerId);
      await saveHist(peerId, h);
    }
    return h;
  }
  const saveHist = (peerId, h) => rpc({ op: 'set', items: { ['h:' + peerId]: h } });

  // ---------- Оформление ----------
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = s => { if (!s) return 'начала'; const d = new Date(s * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; };
  const isoDay = s => { const d = new Date(s * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const size = b => b >= 1099511627776 ? (b / 1099511627776).toFixed(2) + ' ТБ'
    : b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' ГБ' : (b / 1048576).toFixed(0) + ' МБ';
  const now = () => Math.floor(Date.now() / 1000);

  function mergeRanges(list) {
    const r = list.filter(x => x && x[1] >= x[0]).map(x => x.slice()).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const x of r) {
      const last = out[out.length - 1];
      if (last && x[0] <= last[1] + 1) last[1] = Math.max(last[1], x[1]); else out.push(x);
    }
    return out;
  }
  const rangesText = rs => rs.length ? rs.slice().reverse().map(([a, b]) => `${fmtDate(a)} – ${fmtDate(b)}`).join(', ') : 'ничего';

  // ---------- Панель ----------
  // Панель живёт в Shadow DOM: стили Telegram (они, например, прячут все чекбоксы) сюда не проникают.
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:99999';
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('div');
  shadow.appendChild(panel);
  panel.style.cssText = 'width:360px;max-height:85vh;overflow:auto;box-sizing:border-box;color-scheme:dark;' +
    'padding:12px;background:#212121;color:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.5);' +
    'font:13px/1.4 system-ui,sans-serif';
  const inp = 'background:#2c2c2c;color:#fff;border:1px solid #444;border-radius:6px;padding:3px 5px';
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <b>Видео канала</b>
      <span data-x="hide" style="cursor:pointer;opacity:.6;padding:0 4px" title="Свернуть">—</span>
    </div>
    <div data-x="body">
      <div data-x="chat" style="font-weight:600">Чат: —</div>
      <div data-x="chathist" style="opacity:.75;margin-bottom:8px;font-size:12px"></div>

      <div style="margin-bottom:6px">Период:
        <select data-x="period" style="${inp}">
          <option value="7">последние 7 дней</option>
          <option value="30" selected>последние 30 дней</option>
          <option value="90">последние 90 дней</option>
          <option value="365">последний год</option>
          <option value="all">всё время</option>
          <option value="custom">свой</option>
        </select>
      </div>
      <div data-x="customrow" style="display:none;margin-bottom:6px">
        с <input type="date" data-x="from" style="${inp}"> по <input type="date" data-x="to" style="${inp}">
      </div>
      <div style="margin-bottom:6px">
        <button data-x="next" style="width:100%">← Следующий кусок назад (длиной как период)</button>
      </div>
      <div style="margin-bottom:6px">За сессию не больше:
        <input type="number" min="0" step="1" data-x="limgb" placeholder="∞" style="${inp};width:60px"> ГБ
        <input type="number" min="0" step="1" data-x="limn" placeholder="∞" style="${inp};width:55px"> файлов
      </div>
      <div style="margin-bottom:2px">Маска имени (<code>/</code> — папка):</div>
      <input data-x="mask" style="${inp};width:100%;box-sizing:border-box;margin-bottom:2px">
      <div style="opacity:.6;font-size:11px;margin-bottom:6px">
        {channel} {yyyy} {mm} {dd} {date} {time} {id} {name} {ext} {caption}
        <span data-x="maskreset" style="text-decoration:underline;cursor:pointer">по умолчанию</span>
      </div>
      <div data-x="preview" style="opacity:.7;font-size:11px;margin-bottom:6px;word-break:break-all"></div>
      <label style="display:block"><input type="checkbox" data-x="round"> добавить кружочки (видеосообщения)</label>
      <label style="display:block"><input type="checkbox" data-x="skip" checked> пропускать уже скачанные</label>
      <label style="display:block" title="Удалённые из папки загрузок файлы скачаются заново. Выключите, если переносите скачанное на другой диск — для Chrome перенесённый файл выглядит удалённым.">
        <input type="checkbox" data-x="verify" checked> …если файл ещё на диске (удалённые — заново)</label>
      <div style="margin-bottom:8px" title="Telegram Web может сам ставить загрузки в очередь — тогда больше одного файла сразу не пойдёт.">Одновременно:
        <select data-x="par" style="${inp}"><option>1</option><option selected>2</option><option>3</option><option>4</option></select>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button data-x="scan">Найти</button>
        <button data-x="go" disabled>Скачать</button>
        <button data-x="stop" disabled>Стоп</button>
      </div>
      <div data-x="status" style="white-space:pre-wrap;opacity:.9;margin-bottom:8px">Откройте канал и нажмите «Найти».</div>
      <div style="opacity:.6;font-size:11px;margin-bottom:8px">Если Chrome спрашивает, куда сохранить каждый файл, — выключите
        «Всегда указывать место для скачивания» в chrome://settings/downloads. Иначе папки не создаются и файлы идут по одному.</div>
      <div style="display:flex;gap:6px">
        <button data-x="histbtn">История всех чатов</button>
        <button data-x="export">Экспорт</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button data-x="forget">Забыть историю этого чата</button>
      </div>
      <div data-x="histlist" style="display:none;margin-top:8px;font-size:12px"></div>
    </div>`;
  panel.querySelectorAll('button').forEach(b => b.style.cssText +=
    ';flex:1;padding:6px;border:0;border-radius:8px;background:#8774e1;color:#fff;cursor:pointer');
  // Вешаем на <html> и возвращаем на место, если клиент перерисует страницу.
  const attach = () => { if (!host.isConnected) document.documentElement.appendChild(host); };
  attach();
  setInterval(attach, 2000);
  console.log('[tgvdl] панель добавлена', location.href);

  const $ = n => panel.querySelector(`[data-x="${n}"]`);
  const setStatus = t => { $('status').textContent = t; };
  $('forget').style.background = '#6b3b3b';
  $('hide').onclick = () => { const b = $('body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };

  if (!location.pathname.startsWith('/k')) {
    $('body').innerHTML = 'Расширение работает только в версии <b>K</b>.<br>' +
      '<a href="https://web.telegram.org/k/" style="color:#8774e1">Открыть web.telegram.org/k/</a><br>' +
      '<span style="opacity:.7">или в Telegram: меню ☰ → «Перейти на K-версию».</span>';
    return;
  }

  // ---------- Настройки ----------
  const settings = Object.assign({ period: '30', mask: DEF_MASK, limgb: '', limn: '', round: false, skip: true, verify: true, par: '2' },
    JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
  $('period').value = settings.period; $('mask').value = settings.mask;
  $('limgb').value = settings.limgb; $('limn').value = settings.limn;
  $('round').checked = settings.round; $('skip').checked = settings.skip; $('verify').checked = settings.verify; $('par').value = settings.par;
  const saveSettings = () => {
    Object.assign(settings, {
      period: $('period').value, mask: $('mask').value || DEF_MASK, limgb: $('limgb').value, limn: $('limn').value,
      round: $('round').checked, skip: $('skip').checked, verify: $('verify').checked, par: $('par').value
    });
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  };
  panel.addEventListener('change', () => { saveSettings(); showCustom(); preview(); plan = null; ui(); });
  $('mask').addEventListener('input', preview);
  $('maskreset').onclick = () => { $('mask').value = DEF_MASK; saveSettings(); preview(); };

  function showCustom() { $('customrow').style.display = $('period').value === 'custom' ? '' : 'none'; }
  showCustom();

  // Диапазон в секундах: [from, to]; from = 0 — с самого начала.
  function getRange() {
    const p = $('period').value;
    if (p === 'all') return [0, now()];
    if (p !== 'custom') return [now() - Number(p) * DAY, now()];
    const f = $('from').value, t = $('to').value;
    const from = f ? Math.floor(new Date(f + 'T00:00:00').getTime() / 1000) : 0;
    const to = t ? Math.floor(new Date(t + 'T23:59:59').getTime() / 1000) : now();
    return [from, to];
  }

  // ---------- Имя файла по маске ----------
  const clean = s => String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/~{2,}/g, '~')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);

  function fileName(f, channel) {
    const d = new Date(f.date * 1000);
    const orig = f.doc.file_name || '';
    const dot = orig.lastIndexOf('.');
    const ext = dot > 0 ? orig.slice(dot + 1) : ((f.doc.mime_type || 'video/mp4').split('/')[1] || 'mp4').replace('quicktime', 'mov');
    const name = dot > 0 ? orig.slice(0, dot) : (orig || 'video');
    const v = {
      channel, yyyy: d.getFullYear(), mm: pad(d.getMonth() + 1), dd: pad(d.getDate()),
      date: isoDay(f.date), time: `${pad(d.getHours())}-${pad(d.getMinutes())}`,
      id: f.mid, name, ext, caption: (f.caption || '').replace(/\s+/g, ' ').slice(0, 60) || name
    };
    const mask = $('mask').value || DEF_MASK;
    const parts = mask.split('/').map(part =>
      clean(part.replace(/\{(\w+)\}/g, (m, k) => (k in v ? clean(v[k]) : m)))).filter(Boolean);
    if (!parts.length) parts.push(clean(`${f.mid}_${name}`));
    if (!/\{ext\}/.test(mask)) parts[parts.length - 1] += '.' + ext;
    return parts;
  }

  function preview() {
    const p = currentPeer();
    const sample = { mid: 12345, date: now(), caption: 'Подпись к видео', doc: { file_name: 'clip.mp4', mime_type: 'video/mp4' } };
    $('preview').textContent = 'Пример: Загрузки/' + fileName(sample, clean(p?.title || 'Канал')).join('/');
  }

  // ---------- Текущий чат ----------
  function currentPeer() {
    const h = decodeURIComponent(location.hash.slice(1));
    let peerId = /^-?\d+$/.test(h) ? Number(h) : null;
    if (peerId == null) {
      const el = document.querySelector('.chat.active .chat-info [data-peer-id], .chat.active .top [data-peer-id]');
      if (el) peerId = Number(el.dataset.peerId);
    }
    const title = document.querySelector('.chat.active .chat-info .peer-title')?.textContent?.trim() || String(peerId);
    return peerId ? { peerId, title } : null;
  }

  let lastPeer = null;
  async function refreshChat() {
    const p = currentPeer();
    $('chat').textContent = 'Чат: ' + (p ? p.title : '—');
    if (!p) { $('chathist').textContent = ''; lastPeer = null; return; }
    if (p.peerId === lastPeer) return;
    lastPeer = p.peerId;
    if (state === 'idle') plan = null;
    ui(); preview();
    try {
      const h = await loadHist(p.peerId);
      const files = Object.values(h.files);
      $('chathist').textContent = files.length
        ? `Скачано: ${files.length} файлов, ${size(files.reduce((s, x) => s + (x[1] || 0), 0))}\nПолностью: ${rangesText(h.covered)}`
        : 'Из этого чата ещё ничего не скачивали.';
    } catch (e) { $('chathist').textContent = 'История недоступна: ' + e.message; }
  }
  setInterval(refreshChat, 1000);
  const forceRefresh = () => { lastPeer = null; refreshChat(); };

  // «Следующий кусок назад»: от начала самого свежего покрытого отрезка ещё на длину периода.
  $('next').onclick = async () => {
    const p = currentPeer(); if (!p) return;
    const h = await loadHist(p.peerId);
    const days = ['custom', 'all'].includes($('period').value) ? 30 : Number($('period').value);
    const newest = h.covered.slice().sort((a, b) => b[1] - a[1])[0];
    const to = newest ? newest[0] - 1 : now();
    const from = Math.max(0, to - days * DAY);
    $('period').value = 'custom';
    $('from').value = isoDay(from); $('to').value = isoDay(to);
    saveSettings(); showCustom(); plan = null; ui();
    setStatus(`Период: ${fmtDate(from)} – ${fmtDate(to)}. Нажмите «Найти».`);
  };

  const ui = () => {
    $('scan').disabled = state !== 'idle';
    $('go').disabled = state !== 'idle' || !plan?.queue.length;
    $('stop').disabled = state === 'idle' || state === 'stopping';
    $('next').disabled = state !== 'idle';
  };

  function isProtected(peerId, msg) {
    if (msg?.pFlags?.noforwards) return true;
    if (peerId < 0) { try { return !!window.apiManagerProxy?.getChat?.(-peerId)?.pFlags?.noforwards; } catch { } }
    return false;
  }

  // ---------- Поиск ----------
  // Обычные видео и кружочки (видеосообщения) Telegram отдаёт разными фильтрами.
  async function fetchPage(peerId, offsetId, filter) {
    const m = window.rootScope.managers.appMessagesManager;
    const res = await m.getHistory({ peerId, limit: PAGE, offsetId, maxId: offsetId, inputFilter: { _: filter } });
    let msgs = res?.messages || res?.history || [];
    if (msgs.length && typeof msgs[0] === 'number') msgs = await Promise.all(msgs.map(mid => m.getMessageByPeer(peerId, mid)));
    return { msgs: msgs.filter(Boolean), count: res?.count };
  }

  async function scan() {
    const p = currentPeer();
    if (!p) { setStatus('Не вижу открытого чата. Откройте канал слева.'); return; }
    if (!window.rootScope?.managers || !window.appDownloadManager) {
      setStatus('Не нашёл внутренности Telegram Web K. Нужна версия web.telegram.org/k/ и вход в аккаунт.'); return;
    }
    saveSettings();
    const [from, to] = getRange();
    if (from > to) { setStatus('Начало периода позже конца.'); return; }
    state = 'scanning'; plan = null; ui();
    const withRound = $('round').checked, skip = $('skip').checked;
    const h = await loadHist(p.peerId, p.title);
    // Проверка, что ранее скачанные файлы ещё на диске.
    let gone = 0, unchecked = 0;
    if (skip && $('verify').checked && Object.keys(h.files).length) {
      setStatus('Проверяю, на месте ли скачанные файлы…');
      try {
        const r = await rpc({ op: 'check', peerId: p.peerId, mids: Object.keys(h.files).map(Number) });
        if (r?.error) throw new Error(r.error);
        unchecked = r.unknown.length;
        if (r.missing.length) {
          gone = r.missing.length;
          for (const mid of r.missing) {
            const d = h.files[mid]?.[0];
            delete h.files[mid];
            // Покрытый отрезок с пропавшим файлом больше не «полный» — разрезаем его в этой точке.
            if (d) h.covered = h.covered.flatMap(([a, b]) => d < a || d > b ? [[a, b]] : [[a, d - 1], [d + 1, b]].filter(x => x[1] >= x[0]));
          }
          await saveHist(p.peerId, h);
        }
      } catch (e) { console.warn('[tgvdl] проверка файлов', e); unchecked = -1; }
    }
    const seen = new Set(), all = [];
    let total = 0, prot = 0, already = 0, alreadyBytes = 0;
    const filters = withRound ? ['inputMessagesFilterVideo', 'inputMessagesFilterRoundVideo'] : ['inputMessagesFilterVideo'];
    try {
     for (const filter of filters) {
      let offsetId = 0, count0 = 0;
      while (state === 'scanning') {
        const { msgs, count } = await fetchPage(p.peerId, offsetId, filter);
        if (count && !count0) { count0 = count; total += count; }
        const fresh = msgs.filter(x => !seen.has(x.mid));
        if (!fresh.length) break;
        for (const msg of fresh) {
          seen.add(msg.mid);
          if (msg.date > to || msg.date < from) continue;
          const doc = msg.media?.document;
          if (!doc) continue;
          const ok = doc.type === 'video' || (doc.type === 'round' && withRound) || (!doc.type && /^video\//.test(doc.mime_type || ''));
          if (!ok) continue;
          if (isProtected(p.peerId, msg)) { prot++; continue; }
          if (skip && h.files[msg.mid]) { already++; alreadyBytes += doc.size || 0; continue; }
          all.push({ mid: msg.mid, date: msg.date, doc, size: doc.size || 0, caption: msg.message });
        }
        offsetId = Math.min(...fresh.map(x => x.mid));
        const oldest = Math.min(...fresh.map(x => x.date));
        setStatus(`Просматриваю… ${seen.size}${total ? ' из ' + total : ''} (дошёл до ${fmtDate(oldest)})\nВ периоде к скачиванию: ${all.length}`);
        if (oldest < from) break; // история идёт от новых к старым — дальше только старее периода
      }
     }
      const stopped = state !== 'scanning';
      // Качаем от новых к старым: так прерванная сессия оставляет сплошной покрытый отрезок.
      all.sort((a, b) => b.date - a.date || b.mid - a.mid);
      const limB = Number($('limgb').value) > 0 ? Number($('limgb').value) * 1073741824 : Infinity;
      const limN = Number($('limn').value) > 0 ? Number($('limn').value) : Infinity;
      const queue = []; let bytes = 0;
      for (const f of all) {
        if (queue.length >= limN || (queue.length && bytes + f.size > limB)) break;
        queue.push(f); bytes += f.size;
      }
      const rest = all.slice(queue.length), restBytes = rest.reduce((s, f) => s + f.size, 0);
      plan = { peerId: p.peerId, title: p.title, from, to, queue, rest: rest.length, restBytes, limited: rest.length > 0, stopped };
      setStatus(`Период ${fmtDate(from)} – ${fmtDate(to)}` + (stopped ? ' (поиск прерван)' : '') +
        `\nК скачиванию в эту сессию: ${queue.length} (${size(bytes)})` +
        (queue.length ? `\nс ${fmtDate(queue[queue.length - 1].date)} по ${fmtDate(queue[0].date)}` : '') +
        (rest.length ? `\nНе влезло в лимит: ${rest.length} (${size(restBytes)}) — следующей сессией` : '') +
        (already ? `\nУже скачано раньше: ${already} (${size(alreadyBytes)})` : '') +
        (gone ? `\nНет на диске (удалены/перенесены): ${gone} — скачаю заново` : '') +
        (unchecked > 0 ? `\nНе проверить ${unchecked}: скачаны до версии 1.1.4 или очищен список загрузок Chrome. ` +
          `Если их нет на диске — «Забыть историю этого чата».` : '') +
        (unchecked < 0 ? '\nПроверить файлы на диске не удалось (подробности в консоли).' : '') +
        (prot ? `\nПропущено ${prot}: в канале запрещено сохранение.` : ''));
    } catch (e) {
      console.error('[tgvdl]', e);
      setStatus('Ошибка при поиске: ' + (e?.message || e?.type || e));
    }
    state = 'idle'; ui();
  }

  // ---------- Загрузка ----------
  async function download() {
    if (!plan?.queue.length) return;
    const p = currentPeer();
    if (!p || p.peerId !== plan.peerId) { setStatus('Открыт другой чат — нажмите «Найти» заново.'); plan = null; ui(); return; }
    state = 'downloading'; ui();
    const h = await loadHist(plan.peerId, plan.title);
    const channel = clean(plan.title) || String(plan.peerId);
    const queue = plan.queue.slice();
    const doneNow = new Set();
    let ok = 0, fail = 0, bytes = 0, active = [];
    const total = plan.queue.length;
    let saving = Promise.resolve();
    const save = () => (saving = saving.then(() => saveHist(plan.peerId, h)).catch(e => console.warn('[tgvdl] история', e)));

    const show = () => setStatus(`Скачано ${ok} из ${total} (${size(bytes)})` + (fail ? `, ошибок ${fail}` : '') +
      `\nСейчас: ${active.join(', ') || '—'}` + (state === 'stopping' ? '\nОстанавливаюсь после текущих…' : ''));

    async function worker() {
      while (queue.length && state === 'downloading') {
        const f = queue.shift();
        const label = `${fmtDate(f.date)} ${size(f.size)}`;
        active.push(label); show();
        const parts = fileName(f, channel);
        const path = parts.join('/');
        try {
          // Сначала говорим фону, куда положить файл, потом запускаем загрузку.
          await rpc({ op: 'expect', name: parts[parts.length - 1], path, peerId: plan.peerId, mid: f.mid });
          await window.appDownloadManager.downloadToDisc({ media: f.doc, fileName: parts[parts.length - 1] });
          ok++; bytes += f.size; doneNow.add(f.mid);
          h.files[f.mid] = [f.date, f.size];
          save();
        } catch (e) {
          fail++;
          console.warn('[tgvdl] не скачалось', f, e);
          rpc({ op: 'unexpect', path }).catch(() => { });
        }
        active.splice(active.indexOf(label), 1); show();
      }
    }
    const par = Math.max(1, Number($('par').value) || 2);
    await Promise.all(Array.from({ length: par }, worker));

    // Покрытие: идём от новых к старым, пока файлы подряд скачаны.
    const list = plan.queue;
    let covFrom = null, broken = false;
    for (const f of list) { if (h.files[f.mid]) covFrom = f.date; else { broken = true; break; } }
    const fullyDone = !broken && !plan.limited && !plan.stopped;
    if (fullyDone) covFrom = plan.from;            // весь период целиком
    if (covFrom != null) h.covered = mergeRanges([...h.covered, [covFrom, plan.to]]);
    else if (!list.length) h.covered = mergeRanges([...h.covered, [plan.from, plan.to]]);
    h.sessions.push({
      at: now(), from: plan.from, to: plan.to, planned: total, ok, fail, bytes,
      status: fullyDone ? 'весь период' : broken ? (state === 'stopping' ? 'остановлено' : 'с ошибками') : 'лимит'
    });
    await save();

    setStatus(`Готово: ${ok} из ${total} (${size(bytes)})` + (fail ? `, ошибок ${fail}` : '') +
      `\nПокрыто полностью: ${rangesText(h.covered)}` +
      (plan.rest ? `\nВ периоде осталось: ${plan.rest} (${size(plan.restBytes)}) — «Найти» → «Скачать» ещё раз` : '') +
      (fail ? '\nНескачанные попадут в следующую сессию.' : ''));
    plan = null;
    state = 'idle'; ui(); forceRefresh();
  }

  // ---------- История всех чатов ----------
  async function showHistory() {
    const box = $('histlist');
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = '';
    box.textContent = 'Загружаю…';
    const all = await rpc({ op: 'all' });
    const rows = Object.entries(all || {}).filter(([k]) => k.startsWith('h:')).map(([k, h]) => {
      const files = Object.values(h.files || {});
      const last = (h.sessions || []).slice(-1)[0];
      return { title: h.title || k.slice(2), n: files.length, b: files.reduce((s, x) => s + (x[1] || 0), 0), covered: h.covered || [], last };
    }).sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0));
    box.innerHTML = '';
    if (!rows.length) { box.textContent = 'Пока пусто.'; return; }
    for (const r of rows) {
      const d = document.createElement('div');
      d.style.cssText = 'padding:6px 0;border-top:1px solid #333';
      d.textContent = `${r.title}\n${r.n} файлов, ${size(r.b)}\nПолностью: ${rangesText(r.covered)}` +
        (r.last ? `\nПоследняя сессия ${fmtDate(r.last.at)}: ${r.last.ok}/${r.last.planned}, ${r.last.status}` : '');
      d.style.whiteSpace = 'pre-wrap';
      box.appendChild(d);
    }
  }

  async function exportHistory() {
    const all = await rpc({ op: 'all' });
    const data = Object.fromEntries(Object.entries(all || {}).filter(([k]) => k.startsWith('h:')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `tg-video-history-${isoDay(now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  $('scan').onclick = scan;
  $('go').onclick = download;
  $('stop').onclick = () => { state = 'stopping'; ui(); };
  $('histbtn').onclick = showHistory;
  $('export').onclick = exportHistory;

  // «Забыть историю этого чата» — по двойному подтверждению, без системных диалогов.
  let forgetArmed = 0;
  $('forget').onclick = async () => {
    const p = currentPeer();
    if (!p || state !== 'idle') return;
    if (Date.now() - forgetArmed > 4000) {
      forgetArmed = Date.now();
      $('forget').textContent = 'Точно? Нажмите ещё раз';
      setTimeout(() => { $('forget').textContent = 'Забыть историю этого чата'; }, 4000);
      return;
    }
    forgetArmed = 0;
    await rpc({ op: 'remove', keys: ['h:' + p.peerId, 'ids:' + p.peerId] });
    localStorage.removeItem('tgvdl-done:' + p.peerId);
    $('forget').textContent = 'Забыть историю этого чата';
    plan = null; ui(); forceRefresh();
    setStatus(`История чата «${p.title}» удалена. Файлы на диске не тронуты.`);
  };
  preview(); ui();
})();
