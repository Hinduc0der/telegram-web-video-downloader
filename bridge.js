// Мост: скрипт страницы (world MAIN) не имеет доступа к chrome.* — передаём его запросы фону.
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.tgvdl !== 'req') return;
  const { id, msg } = e.data;
  chrome.runtime.sendMessage(msg, res => {
    window.postMessage({ tgvdl: 'res', id, res, err: chrome.runtime.lastError?.message }, location.origin);
  });
});
