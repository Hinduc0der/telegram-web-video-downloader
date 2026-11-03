**English** · [Русский](README.ru.md)

# Telegram channel video downloader

A Chrome extension that downloads videos from the channel or chat you have open in **Telegram Web K**
(`https://web.telegram.org/k/`) — by date range, sorted into folders, with a history of what is already saved.

![icon](icons/icon128.png)

> The extension's interface is in Russian.

## Features
- Finds every video in the chat without manual scrolling (optionally including round video messages).
- **Date range**: last 7/30/90 days, last year, all time, or custom dates.
- **Per-session limit** in gigabytes and/or files; the rest goes to the next session.
- **File name mask with folders**: `Telegram/{channel}/{yyyy}-{mm}/{date}_{id}_{name}.{ext}`
  (variables: `{channel} {yyyy} {mm} {dd} {date} {time} {id} {name} {ext} {caption}`).
- **Per-chat history**: how much is saved and which period is fully covered; a "next chunk back" button.
- **Disk check**: files deleted from the downloads folder are downloaded again (can be turned off).
- Channels that restrict saving content are skipped, just like in Telegram itself.
- Windows, macOS, Linux.

## Installation
1. Download the archive from the Releases page (or clone the repository) and unpack it into its own folder.
2. Open `chrome://extensions` → enable "Developer mode" → "Load unpacked" → select the folder.
3. Open or reload `https://web.telegram.org/k/`. A panel appears in the bottom-right corner.

**Required:** in `chrome://settings/downloads` turn off "Ask where to save each file before downloading".
Otherwise Chrome asks about every file, folders are not created, and files download one at a time.
The download location set there is where the subfolders are created.

## Usage
1. Open a channel, choose the period and, if needed, a limit.
2. "Найти" (Find) shows how many files and gigabytes go into this session, what is already saved, and what is missing on disk.
3. "Скачать" (Download). Files go from newest to oldest, so an interrupted session still leaves a continuous covered period.
4. To continue: run the same period again (saved files are skipped) or press "← Следующий кусок назад" (next chunk back).

If you move downloaded files to another drive, uncheck "…если файл ещё на диске" (verify file on disk):
to Chrome, a moved file looks deleted.

## How it works
| File | Purpose |
|---|---|
| `content.js` | The panel (in Shadow DOM) and the main logic. Runs in the page context and calls the web client's own functions: `rootScope.managers.appMessagesManager.getHistory` with a video filter, and `appDownloadManager.downloadToDisc` — the client's native streaming download to disk. |
| `bridge.js` | Bridge between the page and the extension background (the page has no access to `chrome.*`). |
| `background.js` | Intercepts downloads from web.telegram.org (`chrome.downloads.onDeterminingFilename`) and sets the folder path; keeps the history in `chrome.storage.local`; checks that files are still on disk. |

Background log: `chrome://extensions` → the extension card → "Service worker" → Console, lines tagged `[tgvdl]`.

## Limitations
- Only the **K** version of the web client; in version A the panel just offers to switch.
- Relies on internal functions of Telegram Web K — client updates may require fixes.
- Telegram Web itself also limits how many files download at once.
- Other download-manager extensions that rename files may interfere with folder sorting.

For personal archiving: download only what you have access to and are allowed to keep.

Idea, requirements and real-world testing by the repository owner; code written by Claude (Anthropic).

## License
MIT — see [LICENSE](LICENSE).
