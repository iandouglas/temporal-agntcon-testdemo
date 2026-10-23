#!/usr/bin/env node
/**
 * One-button rehearsal console for the audience site.
 *
 * The board ships locked, and unlocking it normally means loading /control with
 * the admin token in the URL -- awkward when you are juggling several browser
 * windows and possibly sharing your screen. This holds the token server-side
 * and exposes a single page with one button, so the token never reaches a tab.
 *
 * Zero dependencies: Node 22 ships a WebSocket client and an HTTP server.
 *
 *   AUDIENCE_URL=https://... ADMIN_TOKEN=... node server.mjs
 *   # or put those in ./.env and just: node server.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config -----------------------------------------------------------------

/** Minimal .env reader, so this stays dependency-free. */
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(join(HERE, ".env"));

const AUDIENCE_URL = (process.env.AUDIENCE_URL ?? "").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PORT = Number.parseInt(process.env.PORT ?? "4000", 10);

/*
 * Loopback by default: this is a local tool. Railway needs "::" (dual-stack)
 * to reach it, which is set in that deployment's variables.
 */
const BIND_HOST = process.env.BIND_HOST ?? "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/*
 * Gate for the console itself. Anyone who can open this page can open the
 * floor and toggle every service, so a deployment reachable off-box must have
 * one. Loopback-only runs may skip it.
 */
const CONSOLE_TOKEN = process.env.CONSOLE_TOKEN ?? "";

if (!LOOPBACK.has(BIND_HOST) && !CONSOLE_TOKEN) {
  console.error(
    [
      "",
      "  Refusing to start.",
      "",
      `  BIND_HOST is "${BIND_HOST}", so this console would be reachable from`,
      "  outside this machine -- and anyone who reaches it can open the floor",
      "  and toggle every service. Set CONSOLE_TOKEN to a long random string:",
      "",
      "    CONSOLE_TOKEN=$(openssl rand -hex 24)",
      "",
      "  Then open the console at  <url>/?key=<that token>",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (!AUDIENCE_URL || !ADMIN_TOKEN) {
  console.error(
    [
      "",
      "  Missing configuration.",
      "",
      "  Set both, either in test-demo/.env or on the command line:",
      "",
      "    AUDIENCE_URL=https://audience-site-production.up.railway.app",
      "    ADMIN_TOKEN=<the audience site's admin_token>",
      "",
      "  Copy .env.example to .env to get started.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// --- upstream control socket ------------------------------------------------

/**
 * Everything the page renders. Kept as one object and pushed whole on every
 * change, so a dropped SSE frame self-corrects on the next one.
 */
const view = {
  linked: false,      // is our control socket up?
  armed: false,       // is the floor open?
  conns: 0,           // every client the board sees, including this console
  audience: 0,        // conns minus our own control socket
  state: {},          // per-switch booleans
  taps: {},           // per-switch tap counts
  services: [],       // [{id, name, kind}] for labelling
  bus: null,          // the board's Redis health
  error: null,
};

const sseClients = new Set();

function push() {
  const frame = `data: ${JSON.stringify(view)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** Service names are not on the socket; the admin REST endpoint has them. */
async function loadServiceNames() {
  try {
    const res = await fetch(`${AUDIENCE_URL}/api/admin/state`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      view.error = `admin/state returned HTTP ${res.status}`;
      return;
    }
    const body = await res.json();
    view.services = body.services ?? [];
    view.bus = body.bus ?? null;
    view.error = null;
  } catch (err) {
    view.error = `could not reach ${AUDIENCE_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

let socket = null;
let reconnectTimer = null;

function connectUpstream() {
  const wsUrl =
    `${AUDIENCE_URL.replace(/^http/, "ws")}/ws` +
    `?role=control&token=${encodeURIComponent(ADMIN_TOKEN)}`;

  const ws = new WebSocket(wsUrl);
  socket = ws;

  ws.addEventListener("open", () => {
    view.linked = true;
    view.error = null;
    console.log("[link] control socket open");
    push();
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    switch (msg.t) {
      case "hello":
        view.state = msg.state ?? {};
        view.armed = Boolean(msg.armed);
        break;
      case "full":
        view.state = msg.state ?? {};
        break;
      case "state":
        view.state = { ...view.state, [msg.id]: msg.v };
        break;
      case "armed":
        view.armed = Boolean(msg.v);
        console.log(`[link] floor ${msg.v ? "OPEN" : "LOCKED"}`);
        break;
      case "stats":
        view.conns = msg.conns ?? 0;
        // The board counts control clients too, and one of them is us. Without
        // this the headline number reads one high, which is confusing for the
        // one question this tool exists to answer.
        view.audience = Math.max(0, view.conns - 1);
        view.taps = msg.taps ?? {};
        view.bus = msg.bus ?? view.bus;
        break;
      default:
        return;
    }
    push();
  });

  const down = () => {
    if (socket !== ws) return;
    view.linked = false;
    push();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectUpstream();
      }, 1500);
    }
  };
  ws.addEventListener("close", down);
  ws.addEventListener("error", down);
}

function send(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// --- http -------------------------------------------------------------------

/** Constant-time compare, so the console token cannot be guessed byte by byte. */
function tokenMatches(candidate) {
  if (!CONSOLE_TOKEN) return true; // loopback-only run with no token configured
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(CONSOLE_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accepts ?key=... or the cookie set after a successful key. */
function authorized(req, url) {
  if (!CONSOLE_TOKEN) return true;
  if (tokenMatches(url.searchParams.get("key"))) return true;
  const cookie = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)console_key=([^;]+)/.exec(cookie);
  return match ? tokenMatches(decodeURIComponent(match[1])) : false;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    if (!authorized(req, url)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      // Spell out which token this is: it is NOT the board's admin_token, and
      // reaching for that one is the obvious mistake.
      res.end(
        [
          "This console needs its own key.",
          "",
          "  Open:  <this url>/?key=<CONSOLE_TOKEN>",
          "",
          "CONSOLE_TOKEN is a separate value from the audience board's",
          "admin_token -- the board's token will not work here. On Railway it",
          "is the CONSOLE_TOKEN variable on this service.",
          "",
        ].join("\n"),
      );
      return;
    }
    const html = await readFile(join(HERE, "index.html"), "utf8");
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    // Remember a good key so the page's own fetches do not need it in the URL.
    if (CONSOLE_TOKEN && url.searchParams.get("key")) {
      headers["set-cookie"] =
        `console_key=${encodeURIComponent(CONSOLE_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` +
        (LOOPBACK.has(BIND_HOST) ? "" : "; Secure");
    }
    res.writeHead(200, headers);
    // replaceAll: the placeholder appears twice (href and link text).
    res.end(html.replaceAll("__AUDIENCE_URL__", AUDIENCE_URL));
    return;
  }

  if (!authorized(req, url)) {
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(view)}\n\n`);
    sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 20_000);
    req.on("close", () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/arm") {
    const v = url.searchParams.get("v") === "1";
    json(res, send({ t: "arm", v }) ? 200 : 503, { ok: view.linked, armed: v });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/all") {
    const v = url.searchParams.get("v") === "1";
    let sent = 0;
    for (const service of view.services) {
      if (send({ t: "force", id: service.id, v })) sent += 1;
    }
    json(res, sent > 0 ? 200 : 503, { ok: sent > 0, forced: sent });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/force") {
    // One switch, same message ALL ON/OFF sends per service. Only ids the
    // board told us about, so a stray id can't invent a switch on the board.
    const id = url.searchParams.get("id") ?? "";
    const v = url.searchParams.get("v") === "1";
    const known = view.services.some((s) => s.id === id) || id in view.state;
    if (!known) {
      json(res, 404, { error: `unknown switch: ${id}` });
      return;
    }
    json(res, send({ t: "force", id, v }) ? 200 : 503, { ok: view.linked, id, v });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    json(res, send({ t: "reset-counters" }) ? 200 : 503, { ok: view.linked });
    return;
  }

  json(res, 404, { error: "not found" });
});

await loadServiceNames();
connectUpstream();

server.listen(PORT, BIND_HOST, () => {
  const where = LOOPBACK.has(BIND_HOST) ? `http://127.0.0.1:${PORT}` : `[${BIND_HOST}]:${PORT}`;
  const key = CONSOLE_TOKEN ? "/?key=<CONSOLE_TOKEN>" : "";
  console.log("");
  console.log(`  rehearsal console : ${where}${key}`);
  console.log(`  driving the board : ${AUDIENCE_URL}`);
  console.log(`  console gate      : ${CONSOLE_TOKEN ? "token required" : "open (loopback only)"}`);
  console.log("");
  console.log("  Open the board in as many browsers as you like, then press START.");
  console.log("");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nshutting down");
    socket?.close();
    server.close(() => process.exit(0));
  });
}
