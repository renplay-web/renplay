# Renplay

Self-hosted Ren'Py game library with browser play, web-based game management, and cloud save sync.

## Quick Start

```bash
# 1. Build the Docker image
make build

# 2. Prepare directories
mkdir -p games data

# 3. Run
make run
# or: docker compose up
```

Open http://localhost:8080

## Adding Games via Web UI

1. Click the **gear icon** (⚙) in the top-right corner
2. Click the **"Add Game"** button
3. Fill in:
   - **Slug** — URL path (e.g., `my-game`), matches the subdirectory in `$GAMES_DIR`
   - **Title** — display name
   - **Author** — optional
   - **Description** — short blurb shown on the card
   - **Tags** — comma-separated (e.g., `visual-novel, romance`)
   - **Thumbnail path** — optional path to a thumbnail image
4. Click **Create**

To upload a custom thumbnail, click **"Choose file"** while editing a game (supports JPEG, PNG, WebP, GIF).

## Adding Games via games.json (Deprecated)

The old static `games.json` approach has been replaced by the SQLite database. Use the web UI instead.

## Converting a Ren'Py Game for Web

### Prerequisites

- **Ren'Py SDK 8.5+** — download from [renpy.org](https://www.renpy.org/)
- A Ren'Py game project folder (contains `game/`, `renpy/`, etc.)

### Method A: Ren'Py Launcher (GUI)

1. Open the game project in the Ren'Py Launcher
2. Select the game from the list on the left
3. Click **"Web"** (bottom-left)
4. Click **"Build Web Application"**
5. Wait for the build to complete
6. Click **"Open Build Directory"** to find the output

The output is a directory named like `YourGame-1.0-web/`.

### Method B: Command Line

```bash
# If renpy is in your PATH:
renpy web /path/to/game

# Or on macOS with the SDK app:
/Applications/RenPy.app/Contents/MacOS/renpy web /path/to/game
```

The output will be in the project's `dists/` directory.

### Post-Processing (Required for Save Sync)

```bash
# Run the injection script on the web build
./deploy/scripts/prepare-game.sh ./YourGame-1.0-web/
```

This injects the save-sync client script so saves sync across devices.

### Deploying

```bash
# 1. Copy the processed build to your games directory
mkdir -p games/your-game
cp -r YourGame-1.0-web/* games/your-game/

# 2. Add the game via the web UI (gear icon → Add Game)
#    Slug must match the directory name
```

## Save Sync

Renplay syncs game saves across devices:

1. Enter a **profile name** on the game selector page
2. Saves are automatically uploaded to the server every 10 seconds while playing
3. When you reload or open the game on another device, saves are downloaded and restored

Saves are stored as individual files in `$SAVES_DIR/{game-slug}/{profile-name}/`.

No authentication is required — the profile name acts as the save key.

## Data Storage

| Path | Env Var | Default | Contents |
|------|---------|---------|----------|
| Game files | `GAMES_DIR` | `/games` | Ren'Py web build directories (read-only NAS mount) |
| Persistent data | `DATA_DIR` | `/data` | SQLite DB (`renplay.db`), uploaded thumbnails (`thumbnails/`) |
| Saves | `SAVES_DIR` | `$DATA_DIR/saves` | Player save files |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `GAMES_DIR` | `/games` | Directory containing game web builds |
| `DATA_DIR` | `/data` | Persistent data storage (DB, thumbnails) |
| `SAVES_DIR` | `$DATA_DIR/saves` | Directory for persistent save data |

## Architecture

```
Browser                          Docker Container
┌─────────────────┐               ┌──────────────────────────────┐
│ Game Selector    │  ───/───→   │ nginx (port 8080)            │
│ (React SPA)      │             │  / → React SPA               │
│  Admin panel     │             │  /play/* → GAMES_DIR          │
│  (CRUD + thumb)  │             │  /api/games → node backend   │
│                  │             │  /api/thumbnails → DATA_DIR   │
│ Ren'Py Game      │  ───/play──→│                              │
│ (WASM)           │             │ node (127.0.0.1:3000)         │
│  sync-client.js──┼──/api/saves→│  ├─ games CRUD (SQLite)      │
│  ↕ IndexedDB     │             │  ├─ thumbnail upload         │
└─────────────────┘             │  └─ save sync                │
                                  │  DATA_DIR/                    │
                                  │   ├─ renplay.db (SQLite)     │
                                  │   ├─ thumbnails/             │
                                  │   └─ saves/                  │
                                  └──────────────────────────────┘
```

## Building the Image

```bash
docker build -t renplay:latest -f deploy/nginx/Dockerfile .
```

## Directory Structure

```
renplay/
├── selector/              ← React + Vite game selector UI
├── save-sync/             ← Node.js backend (Express + SQLite)
├── deploy/
│   ├── nginx/
│   │   ├── Dockerfile
│   │   ├── nginx.conf.template
│   │   ├── entrypoint.sh
│   │   └── sync-client.js
│   └── scripts/
│       └── prepare-game.sh
├── games/                 ← Mount your GAMES_DIR here
├── data/                  ← Mount your DATA_DIR here
│   ├── renplay.db         ← SQLite database (auto-created)
│   ├── thumbnails/        ← Uploaded thumbnails
│   └── saves/             ← Player save files
├── docker-compose.yml
├── Makefile
└── README.md
```
