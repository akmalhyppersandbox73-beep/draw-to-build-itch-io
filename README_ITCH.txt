DRAW TO BUILD - itch.io build (v2: ownership + 24h Global Build)

UPLOAD
1. Upload this ZIP on itch.io: Kind of project = HTML, tick "This file will be played in the browser".
2. index.html is at the zip root. Set viewport ~1280x720, enable "Mobile friendly" (landscape) and "Fullscreen button".
   (The server/ folder is not used by the browser; you may delete it from the ZIP before uploading, or leave it.)
3. Singleplayer works offline-in-browser (saves in IndexedDB).
4. Three.js loads from cdnjs.cloudflare.com (needs internet). To self-host, put three.min.js (r149) in the root and change the script tag in index.html.

GLOBAL BUILD SERVER  (IMPORTANT - do this once)
The ownership + 24h auto-delete rules live on the server, so the Global Build server must run the code in server/.
 - Deploy server/ on any Node.js (>=18) host with persistent disk and HTTPS (see server/README_SERVER.md).
 - Edit config.js: SERVER_URL (wss://.../ws) and STATUS_URL (https://.../api/status).
 - If the game still talks to the old server it shows a "Server lama" warning and none of the new rules are enforced.

NEW IN THIS VERSION
 - Inventory > Placed: only YOUR buildings. Long-press (or right-click on PC) to multi-select; Hapus / Pilih Semua / Batal; selected counter.
 - Global buildings disappear 24h after they were built (timer badge in Placed).
 - You can only move/resize/pack/delete your own buildings; the server enforces it.
 - Your identity is a private key stored in this browser (localStorage). Clearing site data = you lose control of buildings you already placed (they expire after 24h anyway).
