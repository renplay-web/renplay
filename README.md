# Renplay

**Self-hosted Ren'Py game library with browser play, cloud save sync, and progressive asset loading.**

Renplay lets you play your Ren'Py visual novels in any browser — on desktop, tablet, or phone — without installing each game. It manages the full lifecycle: preparing web builds, hosting them, syncing saves across devices, and providing a clean library UI.

> [!TIP]
> Renplay is designed for large games (10 GB+). It uses Ren'Py's native progressive download system so players don't have to wait for multi-gigabyte downloads.

---

## Quick Start

```bash
# 1. Build the Docker image
make build

# 2. Create directories
mkdir -p games data

# 3. Run
make run
```

Open **http://localhost:8080**.

---

## How It Works

1. **Prepare** — convert a Ren'Py game to web using the SDK (one command)
2. **Add** — drop the web build into your `games/` folder, scan from the admin panel
3. **Play** — open your library, click a game, and it streams in your browser

---

## Preparing a Game

### Prerequisites

- **Ren'Py SDK 8.5+** — download from [renpy.org](https://www.renpy.org/)
- A Ren'Py game project (a folder containing `game/`, `renpy/`, etc.)

### Basic Web Build

```bash
/path/to/renpy.sh /path/to/launcher web_build /path/to/game/ --destination /path/to/output/
```

The output is a self-contained web distribution. Copy it to your `games/` folder:

```bash
cp -r /path/to/output/* games/my-game/
```

### Progressive Download (for Large Games)

For games over a few hundred megabytes, configure progressive asset loading so players only download what they need:

#### 1. Extract RPA archives

Ren'Py's progressive download system works on individual files, not files inside RPA archives. Extract all `.rpa` files **first**:

```bash
cd /path/to/game/game/

# Extract each archive
unrpa -p . archive.rpa
unrpa -p . images.rpa
unrpa -p . audio.rpa
# ... repeat for every .rpa file
```

> [!WARNING]
> **You must delete every `.rpa` archive after extraction.** The game will still work if you leave them, but the Ren'Py ProgressiveFilter cannot see inside archives — files hidden in a remaining `.rpa` will be baked into the boot zip instead of streamed on demand, defeating progressive download.
>
> **Check carefully.** Archives can be deeply nested in the directory tree and there may be many of them. Some games split assets across dozens of archives (e.g., `ep1_images.rpa`, `ep2_images.rpa`, `gui.rpa`, `movies.rpa`, `music_ep1.rpa`, …). Verify none remain before proceeding:
> ```bash
> find /path/to/game/game/ -name '*.rpa'
> # Should return nothing
> ```

#### 2. Create `progressive_download.txt`

Place this file in your game project root (next to `game/`). It tells the build which files to keep in the boot zip vs. stream on demand:

```
# Keep GUI in the boot zip
- image game/gui/**
# Stream everything else
+ image game/images/**
+ music game/music/**
+ music game/audio/**
+ voice game/voice/**
```

Valid types: `image`, `music`, `voice`. Videos are always streamed automatically.

#### 3. Run the web build

The SDK reads `progressive_download.txt`, excludes matched files from `game.zip`, copies them as individual files alongside the zip, and generates the metadata needed for on-demand download.

#### 4. Deploy

Copy the output to your `games/` folder and click **Scan for new games** in the admin panel (gear icon, top-right).

> [!IMPORTANT]
> Do **not** decompress `game.zip`. It is an Emscripten Virtual Filesystem archive read by the Ren'Py WASM engine at runtime — not a regular archive.

---

## Features

### Save Sync

Saves are automatically synced between devices. Pick a profile name on the library page, and saves upload every few seconds while you play. Open the same game on another device (or after clearing your browser data) and your saves are restored.

### Library Management

- Upload custom **thumbnails** per game
- Upload **walkthrough PDFs** — a button appears in the game view
- Drag-and-drop reordering, tags, and search

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GAMES_DIR` | `/games` | Directory with game web builds |
| `DATA_DIR` | `/data` | Persistent data (database, thumbnails, walkthroughs, saves) |
| `SAVES_DIR` | `$DATA_DIR/saves` | Save file storage |

---

## Architecture

```
Browser                          Docker Container
┌─────────────────┐               ┌──────────────────────────────┐
│ Game Library     │  ───/───→   │ nginx (port 8080)            │
│ (React SPA)      │             │  / → SPA                     │
│  Admin panel     │             │  /play/* → games directory   │
│  (CRUD + upload) │             │  /api/* → node backend       │
│                  │             │                              │
│ Ren'Py Game      │  ───/play──→│ node (127.0.0.1:3000)         │
│ (WASM)           │             │  ├─ games CRUD (SQLite)      │
│  save sync ──────┼──/api/saves→│  ├─ thumbnail upload         │
└─────────────────┘             │  ├─ walkthrough upload       │
                                  │  └─ save storage            │
                                  │  DATA_DIR/                    │
                                  │   ├── renplay.db             │
                                  │   ├── thumbnails/            │
                                  │   ├── walkthroughs/          │
                                  │   └── saves/                 │
                                  └──────────────────────────────┘
```

---

## Development

```bash
make dev
```

Uses `docker compose up --build` with the local source mounted for hot-reload.

---

## Project Structure

```
renplay/
├── selector/          ← React + Vite game library UI
├── server/            ← Node.js backend (Express + SQLite)
├── deploy/nginx/      ← Docker image with nginx
│   ├── Dockerfile
│   ├── nginx.conf.template
│   ├── entrypoint.sh
│   └── sync-client.js
├── games/             ← Your game web builds (mount here)
├── data/              ← Persistent data (mount here)
├── docker-compose.yml
├── Makefile
└── README.md
```

---

## License

MIT
