// Фон расширения.
// 1) Раскладка по папкам. Страница Telegram не может создать подпапку, а имя файла, которое мы
//    передаём клиенту, до Chrome доходит не всегда. Поэтому content.js перед каждой загрузкой
//    присылает сюда «ожидание»: {name, path, peerId, mid}. Когда Chrome начинает загрузку с
//    web.telegram.org, мы находим ожидание — по имени, а если имя не совпало, то по очереди —
//    подставляем путь и запоминаем id загрузки Chrome для этого сообщения (ключ "ids:<peerId>").
// 2) Проверка, что скачанные файлы ещё на диске (chrome.downloads.search → exists).
// 3) Хранилище истории (chrome.storage.local — переживает выход из Telegram и очистку сайта).

const TTL = 10 * 60 * 1000; // ожидание живёт 10 минут
const ses = chrome.storage.session;
const loc = chrome.storage.local;

// Все чтения-записи ожиданий и id — строго по очереди, иначе параллельные загрузки
// могут забрать одно и то же ожидание.
let lock = Promise.resolve();
const serial = fn => (lock = lock.then(fn, fn));

async function getPending() {
  const { pending = [] } = await ses.get('pending');
  return pending.filter(p => Date.now() - p.t < TTL);
}

const baseName = s => (s || '').split(/[\\/]/).pop();
const stripCopy = s => s.replace(/ \(\d+\)(?=\.[^.]+$|$)/, ''); // "имя (1).mp4" → "имя.mp4"

async function rememberId(peerId, mid, id) {
  if (peerId == null || mid == null) return;
  const key = 'ids:' + peerId;
  const { [key]: ids = {} } = await loc.get(key);
  ids[mid] = id;
  await loc.set({ [key]: ids });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Только файлы, отданные самим Telegram Web (его service worker или blob), а не ссылки из чатов.
  const src = [item.url, item.finalUrl].join(' ');
  if (!src.includes('web.telegram.org')) return;
  const base = baseName(item.filename);
  console.log('[tgvdl] загрузка из Telegram:', { id: item.id, filename: item.filename, url: item.url });

  serial(async () => {
    const pending = await getPending();
    if (!pending.length || base.startsWith('tg-video-history')) return suggest();
    let i = pending.findIndex(p => p.name === base || p.name === stripCopy(base));
    const how = i >= 0 ? 'по имени' : 'по очереди';
    if (i < 0) i = 0; // самое старое ожидание
    const [p] = pending.splice(i, 1);
    await ses.set({ pending });
    await rememberId(p.peerId, p.mid, item.id);
    console.log(`[tgvdl] → ${p.path} (${how})`);
    suggest({ filename: p.path, conflictAction: 'uniquify' });
  }).catch(e => { console.warn('[tgvdl]', e); try { suggest(); } catch { } });
  return true; // ответ асинхронный
});

// Какие из скачанных файлов чата пропали с диска.
async function check(peerId, mids) {
  const key = 'ids:' + peerId;
  const { [key]: ids = {} } = await loc.get(key);
  // Первый search() заставляет Chrome проверить файлы на диске, второй — возвращает свежий результат.
  await chrome.downloads.search({ limit: 0 });
  await new Promise(r => setTimeout(r, 700));
  const items = new Map((await chrome.downloads.search({ limit: 0 })).map(x => [x.id, x]));
  const missing = [], unknown = [];
  for (const mid of mids) {
    const id = ids[mid];
    const it = id != null ? items.get(id) : null;
    if (!it) { unknown.push(mid); continue; }       // скачано старой версией или список загрузок очищен
    if (it.state === 'in_progress') continue;
    if (it.state === 'interrupted' || !it.exists) missing.push(mid);
  }
  if (missing.length) { missing.forEach(m => delete ids[m]); await loc.set({ [key]: ids }); }
  return { missing, unknown };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const op = msg?.op;
  if (op === 'get') loc.get(msg.keys).then(reply);
  else if (op === 'set') loc.set(msg.items).then(() => reply(true));
  else if (op === 'all') loc.get(null).then(reply);
  else if (op === 'remove') loc.remove(msg.keys).then(() => reply(true));
  else if (op === 'check') serial(() => check(msg.peerId, msg.mids)).then(reply, e => reply({ error: String(e) }));
  else if (op === 'expect') serial(async () => {
    const pending = await getPending();
    pending.push({ name: msg.name, path: msg.path, peerId: msg.peerId, mid: msg.mid, t: Date.now() });
    await ses.set({ pending });
  }).then(() => reply(true));
  else if (op === 'unexpect') serial(async () => {
    await ses.set({ pending: (await getPending()).filter(p => p.path !== msg.path) });
  }).then(() => reply(true));
  else return false;
  return true;
});
