# Rehearsal console

A local one-button page for testing the deployed audience board across several
browsers at once.

The board ships **locked** — switches render but do nothing until an operator
opens the floor. Doing that normally means loading `/control?token=…`, which is
awkward when you are juggling browser windows and possibly sharing a screen.
This gives you one button instead, and keeps the admin token in a local process
so it never reaches a browser tab.

## Run it locally

```bash
cd test-demo
node server.mjs          # reads ./.env
```

Then open <http://127.0.0.1:4000>. Nothing to install — Node 22 ships both the
HTTP server and the WebSocket client.

`.env` is gitignored (it holds the admin token). Copy `.env.example` to `.env`
and set `AUDIENCE_URL` and `ADMIN_TOKEN`.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AUDIENCE_URL` | — | Required. The board, no trailing slash. |
| `ADMIN_TOKEN` | — | Required. The board's `admin_token`. Stays in this process. |
| `CONSOLE_TOKEN` | none | Gate for this console. **Required unless `BIND_HOST` is loopback.** Open the page at `/?key=<token>`; a successful key sets an HttpOnly cookie so later requests don't need it. |
| `BIND_HOST` | `127.0.0.1` | Listen address. Railway needs `::`. |
| `PORT` | `4000` | |

Anyone who can open this page can open the floor and toggle every service, so
the server **refuses to start** if `BIND_HOST` is not loopback and
`CONSOLE_TOKEN` is unset. That is deliberate: a public, unauthenticated
"START THE DEMO / ALL OFF" panel is worse than no panel.

Neither token is ever sent to the browser — verified by grepping the served
HTML for both.

## Testing across browsers

1. Start the console, leave it open in one window.
2. Open the board URL (shown at the top of the console, with a copy button) in
   Chrome, Safari, Firefox, a private window, your phone — as many as you like.
   Each one should show the switches greyed out and *waiting for the demo to
   start*.
3. Watch **Browsers on the board** climb as each one connects. The number comes
   from the board itself and sums across replicas, with this console's own
   control socket subtracted. Verified exact: opening three tabs moves it by
   three, and it drops back within ~10s of closing them. It does still count
   any *other* client — a `/control` tab you left open, or a phone on the same
   URL — so if it starts at 1 with nothing of yours open, something else is
   connected.
4. Press **START THE DEMO**. Every browser should come alive at once with no
   reload.
5. Tap switches in one browser and watch them move in the others.
6. Press **STOP THE DEMO** to lock them again mid-test.

## What the buttons do

| Button | Effect |
|---|---|
| START / STOP THE DEMO | Opens or closes the floor for the whole room (`arm`). The label follows the board's real state, so it stays correct even if you also use `/control`. |
| ALL ON / ALL OFF | Forces every service to that position. This **drives the services**, firing a real POST each, so it is a true reset rather than a cosmetic one. |
| RESET COUNTERS | Zeroes tap counts and last-call lines. Leaves switch positions alone. |

## Deployed copy

There is also a Railway deployment of this console, so you can drive the board
from a phone or a second machine without running anything locally:

    https://test-demo-production-bdde.up.railway.app/?key=<CONSOLE_TOKEN>

It runs with `BIND_HOST=::` and a `CONSOLE_TOKEN`, so the bare URL returns 401
and every API route is gated too. The token is a Railway variable and is not in
this repo.

Prefer the local copy when you are at your laptop: it is one less public
surface, and it cannot be reached by anyone else at all.

## Notes

- Zero dependencies. Node 22 ships both the HTTP server and the WebSocket
  client, so there is nothing to install.
- Binds `127.0.0.1` only — it is a local tool, not something to expose.
- The console reconnects on its own if the board redeploys under it.
- If the board's Redis goes degraded, a warning appears at the bottom.
- **ALL ON also flips the MCP switch**, which is currently cosmetic: the board
  POSTs `{mcp_url}/on`, the MCP server has no such route, and the tap 404s
  (open item 2 in INTEGRATION-NOTES.md). The switch will read ON while nothing
  was actually told to the MCP server. The four API switches are real.
