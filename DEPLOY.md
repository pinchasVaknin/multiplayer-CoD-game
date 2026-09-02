# Deploying OPERATOR to Render.com

The whole game is **one web service**: the Node process serves the built client *and* the
WebSocket on the same port. That is the shape this guide assumes, and it is why there is no
address to configure and no CORS to allow — the page and the socket share a scheme, a host and
a port, so the browser considers them the same origin.

---

## Step by step

### 1. Push to GitHub

```bash
git push -u origin main
```

`dist/` and `dist-server/` are gitignored on purpose. Render builds them.

### 2. Create the service

1. Sign in at **[render.com](https://render.com)** → **New** → **Web Service**.
2. **Connect your GitHub account** and pick this repository.
3. Fill in four fields:

   | Field | Value |
   |---|---|
   | Runtime | `Node` |
   | Build Command | `npm install && npm run build` |
   | Start Command | `npm start` |
   | Instance Type | `Free` |

### 3. Add one environment variable

Under **Environment**, add:

| Key | Value | Why |
|---|---|---|
| `VITE_SERVER_URL` | `1` | "Connect to whatever origin served this page." Read at **build** time and baked into the client. |
| `NODE_VERSION` | `22` | The build targets Node 22. |

**Do not set `PORT`.** Render sets it, and the server reads it (`src/server/Config.ts`).

### 4. Deploy

Click **Create Web Service**. The first build takes a few minutes. When it goes live, open the
URL Render gives you (`https://your-app.onrender.com`) and press **Play Multiplayer**.

> **Shortcut:** this repo contains `render.yaml`, so you can instead use **New → Blueprint**
> and Render will fill all of the above in for you.

---

## What was already right, and what changed

| Requirement | Status |
|---|---|
| Dynamic port binding | Already correct — `PORT` with an `8080` fallback, and the host binds `0.0.0.0`. |
| Client connection URL | Already derived from `window.location`, including the `ws:`→`wss:` upgrade on an HTTPS page. **Changed:** a build-time `VITE_SERVER_URL` of `1` now means "this origin", which it did not before — it would have tried to open `wss://1/ws`. |
| Build / start scripts | **Added.** `build` now produces *both* halves; `start` runs the server. `engines` pins Node ≥ 22. |
| CORS | Not applicable on one origin, and **`Access-Control-Allow-Origin: *`** is sent on static files anyway, so splitting the client onto a CDN later does not become an afternoon. WebSocket is exempt from the same-origin policy and `ws` performs no origin check. |

The one structural change: **the server now serves the client** (`WsServer.staticDir`,
default `dist`). Set `STATIC_DIR=` (empty) to turn that off — which is the right answer behind
a reverse proxy that is already serving the client itself, and is how the bare-metal deployment
in `deploy/` still works.

---

## Things worth knowing about the free tier

- **It sleeps.** A free service spins down after ~15 minutes with no traffic, and the next
  request takes 30–60 s to wake it. The first player through the door will think it is broken.
  It is not.
- **Sleeping ends matches.** Every player is disconnected when it spins down. The arena is
  rebuilt from scratch on wake; nothing persists server-side by design (§6.9 — progression
  lives in the player's own `localStorage`).
- **512 MB and roughly half a CPU.** Measured on this build: ~35 MB heap, ~0.5 ms per tick with
  a live match and the arena both running. There is plenty of headroom; the tick loop is the
  thing to watch, and Render's metrics tab will show CPU throttling as tick jitter if you ever
  raise `WARMUP_BOTS` or the bot count much.
- **Health check.** `/healthz` returns 200 and is answered before anything touches the disk, so
  it stays honest even if a build produced no client.

## Useful environment variables

All optional; every one has a working default. Full list in `src/server/Config.ts`.

| Key | Default | Notes |
|---|---|---|
| `WARMUP_BOTS` | `3` | Bots in the permanent arena. |
| `SUMMARY_HOLD_SECONDS` | `14` | How long the post-match board is held. |
| `PLAY_SECONDS` | `120` | Free play between ballots. |
| `STATIC_DIR` | `dist` | Empty string serves no client. |
| `METRICS_SECONDS` | `30` | Structured metrics into the Render log. |
| `CHEATS_ENABLED` | *(off)* | `1` honours the F14 cheat codes that change the simulation — god mode, invisibility, free cam, and thirty kills into the killstreak balance. **Leave it unset in production.** Off, the server refuses each one and tells the player why. It does not gate `DEBUG666`, which opens the client's own overlay and touches nothing the server owns. The boot line says `CHEAT CODES ENABLED` while it is set. |

## Verifying a deploy

```bash
curl -i https://your-app.onrender.com/healthz     # 200 ok
curl -I https://your-app.onrender.com/            # 200 text/html
```

Then open the site and press Play Multiplayer. If the button is greyed out with "no server
address configured", `VITE_SERVER_URL` was not set **at build time** — add it and trigger a
manual redeploy, because the value is compiled into the client bundle rather than read at
runtime.
