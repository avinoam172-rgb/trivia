// שרת משחק טריוויה לכמה שחקנים. ללא תלויות חיצוניות - רק Node.js 18 ומעלה.
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const DATA = require("./questions.json");
const CATEGORIES = DATA.categories;
const CAT_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

const PORT = process.env.PORT || 3000;
const QUESTION_MS = Number(process.env.QUESTION_MS) || 10000; // זמן לכל שאלה
const REVEAL_MS = Number(process.env.REVEAL_MS) || 2500;      // כמה זמן מציגים את התשובה הנכונה
const START_MS = Number(process.env.START_MS) || 3000;        // ספירה לאחור לפני השאלה הראשונה
const POLL_HOLD_MS = 9000;       // כמה זמן מחזיקים בקשת poll פתוחה
const DISCONNECT_MS = 30000;     // אחרי כמה זמן בלי קשר שחקן נחשב כעזב (במהלך משחק)
const LOBBY_DISCONNECT_MS = 60000;
const LOBBY_IDLE_MS = 10 * 60 * 1000;
const ANSWER_GRACE_MS = 700;     // זמן חסד לתשובות שהגיעו באיחור קל ברשת
const MAX_PLAYERS = 8;
const MAX_QUESTIONS = 100;
const MAX_CUSTOM_CATS = 8;
const MAX_CUSTOM_Q = 60;

const rooms = new Map();

function now() { return Date.now(); }
function rid(n) { return crypto.randomBytes(n).toString("hex"); }

function newCode() {
  for (let i = 0; i < 100; i++) {
    const c = String(Math.floor(10000 + Math.random() * 90000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

function cleanName(n) {
  n = String(n || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
  return n || "שחקן";
}

function uniqueName(room, name) {
  let n = cleanName(name);
  let base = n, i = 2;
  while (room.players.some((p) => p.name === n)) n = base + " (" + i++ + ")";
  return n;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickQuestions(cats, perCat) {
  const out = [];
  for (const cat of cats) {
    const chosen = shuffle(cat.questions.slice()).slice(0, perCat);
    for (const row of chosen) {
      const correctText = row[1];
      const answers = shuffle(row.slice(1));
      out.push({ text: row[0], answers, correct: answers.indexOf(correctText), cat: cat.emoji + " " + cat.name });
    }
  }
  return shuffle(out);
}

// קטגוריות שנוצרו על ידי השחקן (נשמרות אצלו בטלפון ונשלחות עם יצירת המשחק)
function str(x, max) {
  return String(x == null ? "" : x).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanCustom(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const c of list.slice(0, MAX_CUSTOM_CATS)) {
    if (!c || !Array.isArray(c.questions)) continue;
    const questions = [];
    for (const row of c.questions.slice(0, MAX_CUSTOM_Q)) {
      if (!Array.isArray(row)) continue;
      const text = str(row[0], 200);
      const answers = row.slice(1, 5).map((a) => str(a, 80)).filter((a) => a.length > 0);
      if (!text || answers.length < 2) continue;
      if (new Set(answers.map((a) => a.toLowerCase())).size !== answers.length) continue; // תשובות זהות
      questions.push([text].concat(answers)); // התשובה הנכונה היא הראשונה
    }
    if (questions.length === 0) continue;
    out.push({ id: "u" + (out.length + 1), name: str(c.name, 24) || "הקטגוריה שלי", emoji: "\u270F\uFE0F", questions });
  }
  return out;
}

function makePlayer(room, name) {
  return { id: "p" + rid(8), name: uniqueName(room, name), score: 0, ans: null, lastSeen: now(), waiting: null, left: false, quit: false };
}

function connected(p) {
  return !!p.waiting || now() - p.lastSeen < DISCONNECT_MS;
}

const active = (room) => room.players.filter((p) => !p.left);

// ---- מצב מותאם לשחקן ----
function snapshot(room, pid) {
  const me = room.players.find((p) => p.id === pid);
  const st = {
    v: room.v,
    now: now(),
    phase: room.phase,
    code: room.code,
    rounds: room.questions.length,
    maxPlayers: room.maxPlayers,
    q: room.q,
    startAt: room.startAt,
    qStart: room.qStart,
    deadline: room.deadline,
    revealUntil: room.revealUntil,
    players: room.players.map((p) => ({
      name: p.name,
      score: room.phase === "finished" ? p.score : 0, // הניקוד נחשף רק בסוף המשחק
      answered: !!p.ans,
      connected: connected(p),
      left: p.left,
      me: p.id === pid,
    })),
    question: null,
    reveal: null,
    result: null,
  };
  if ((room.phase === "question" || room.phase === "reveal") && room.q >= 0) {
    const q = room.questions[room.q];
    st.question = { text: q.text, answers: q.answers, cat: q.cat };
  }
  if (room.phase === "reveal") {
    const q = room.questions[room.q];
    st.reveal = {
      correct: q.correct,
      // נקודות של שחקנים אחרים לא נחשפות במהלך המשחק
      results: room.players.map((p) => ({ choice: p.ans ? p.ans.choice : -1, points: p.id === pid && p.ans ? p.ans.points : 0 })),
    };
  }
  if (room.phase === "finished") {
    let rank;
    if (room.forfeit) rank = me && !me.left ? 1 : room.players.length;
    else rank = 1 + room.players.filter((p) => p.score > me.score).length;
    st.result = { forfeit: !!room.forfeit, rank, total: room.players.length };
  }
  return st;
}

function respond(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function flush(room) {
  for (const p of room.players) {
    if (p.waiting) {
      const w = p.waiting;
      p.waiting = null;
      clearTimeout(w.timer);
      p.lastSeen = now();
      respond(w.res, 200, snapshot(room, p.id));
    }
  }
}

function bump(room) {
  room.v++;
  room.touched = now();
  flush(room);
}

// ---- מעברי מצב ----
function startQuestion(room, i) {
  room.q = i;
  room.phase = "question";
  room.qStart = now();
  room.deadline = room.qStart + QUESTION_MS;
  room.players.forEach((p) => (p.ans = null));
  bump(room);
}

function endQuestion(room) {
  if (room.phase !== "question") return;
  room.phase = "reveal";
  room.players.forEach((p) => {
    if (p.ans) p.score += p.ans.points;
  });
  room.revealUntil = now() + REVEAL_MS;
  bump(room);
}

function finish(room, forfeit) {
  room.phase = "finished";
  room.forfeit = !!forfeit;
  bump(room);
}

// שחקן עזב באמצע משחק: ממשיכים אם נשארו לפחות שניים, אחרת המשחק נגמר
function playerLeft(room, p) {
  if (p.left) return;
  p.left = true;
  if (active(room).length < 2) {
    finish(room, true);
    return;
  }
  if (room.phase === "question" && active(room).every((x) => x.ans)) endQuestion(room);
  else bump(room);
}

function tick() {
  try { tickInner(); } catch (e) { console.error("tick", e); }
}

function tickInner() {
  const t = now();
  for (const [code, room] of rooms) {
    if (room.phase === "lobby") {
      let changed = false;
      for (const p of room.players.slice()) {
        if (!p.waiting && t - p.lastSeen > LOBBY_DISCONNECT_MS) {
          room.players.splice(room.players.indexOf(p), 1);
          changed = true;
        }
      }
      if (room.players.length === 0 || t - room.touched > LOBBY_IDLE_MS) rooms.delete(code);
      else if (changed) bump(room);
      continue;
    }
    if (room.phase === "finished") {
      if (t - room.touched > 2 * 60 * 1000) rooms.delete(code);
      continue;
    }
    for (const p of active(room)) {
      if (!connected(p)) {
        playerLeft(room, p);
        if (room.phase === "finished") break;
      }
    }
    if (room.phase === "finished") continue;
    if (room.phase === "starting" && t >= room.startAt) {
      startQuestion(room, 0);
    } else if (room.phase === "question" && t >= room.deadline + ANSWER_GRACE_MS) {
      endQuestion(room);
    } else if (room.phase === "reveal" && t >= room.revealUntil) {
      if (room.q + 1 < room.questions.length) startQuestion(room, room.q + 1);
      else finish(room, false);
    }
  }
}
setInterval(tick, 100);

// ---- פעולות ----
function createRoom(body) {
  let maxPlayers = parseInt(body.maxPlayers, 10);
  if (!(maxPlayers >= 2)) maxPlayers = 2;
  maxPlayers = Math.min(maxPlayers, MAX_PLAYERS);

  const ids = (Array.isArray(body.categories) ? body.categories : []).filter((id, i, a) => CAT_BY_ID.has(id) && a.indexOf(id) === i);
  const cats = ids.map((id) => CAT_BY_ID.get(id)).concat(cleanCustom(body.custom));
  if (cats.length === 0) return { code: 400, body: { error: "no_categories" } };

  let perCat = parseInt(body.perCat, 10);
  if (!(perCat >= 1)) perCat = 5;
  perCat = Math.min(perCat, 20);

  const questions = pickQuestions(cats, perCat);
  if (questions.length > MAX_QUESTIONS) return { code: 400, body: { error: "too_many" } };

  const code = newCode();
  if (!code) return { code: 503, body: { error: "busy" } };

  const room = {
    code, maxPlayers, players: [], phase: "lobby", v: 1, q: -1, questions,
    startAt: 0, qStart: 0, deadline: 0, revealUntil: 0, forfeit: false, touched: now(),
  };
  const p = makePlayer(room, body.name);
  room.players.push(p);
  rooms.set(code, room);
  return { code: 200, body: { room: code, player: p.id } };
}

function joinRoom(body) {
  const room = rooms.get(String(body.room || "").trim());
  if (!room) return { code: 404, body: { error: "not_found" } };
  if (room.phase !== "lobby") return { code: 409, body: { error: "started" } };
  if (room.players.length >= room.maxPlayers) return { code: 409, body: { error: "full" } };
  const p = makePlayer(room, body.name);
  room.players.push(p);
  if (room.players.length >= room.maxPlayers) {
    room.phase = "starting";
    room.startAt = now() + START_MS;
  }
  bump(room);
  return { code: 200, body: { room: room.code, player: p.id } };
}

function answer(body) {
  const room = rooms.get(String(body.room || ""));
  if (!room) return { code: 404, body: { error: "gone" } };
  const p = room.players.find((x) => x.id === body.player);
  if (!p) return { code: 403, body: { error: "bad_player" } };
  p.lastSeen = now();
  if (room.phase !== "question") return { code: 409, body: { error: "not_open" } };
  if (p.ans) return { code: 409, body: { error: "already" } };
  const recv = now();
  // הלקוח שולח את רגע הלחיצה (בשעון השרת), כדי שעיכוב ברשת לא יקנוס אותו. מגבילים ל-3 שניות אחורה.
  let t = recv;
  const at = Number(body.at);
  if (isFinite(at) && at > 0) t = Math.min(recv, Math.max(at, recv - 3000));
  if (t > room.deadline) return { code: 409, body: { error: "late" } };
  const choice = parseInt(body.choice, 10);
  if (!(choice >= 0 && choice <= 3)) return { code: 400, body: { error: "bad_choice" } };
  const elapsed = Math.min(Math.max(t - room.qStart, 0), QUESTION_MS);
  const correct = choice === room.questions[room.q].correct;
  // 1000 נקודות לתשובה מיידית, יורד עד 200 לתשובה בסוף הזמן. טעות = 0
  const points = correct ? Math.round(200 + 800 * (1 - elapsed / QUESTION_MS)) : 0;
  p.ans = { choice, points, elapsed };
  if (active(room).every((x) => x.ans)) endQuestion(room); // כולם ענו - ממשיכים מיד
  else bump(room);
  return { code: 200, body: { ok: true } };
}

function leave(body) {
  const room = rooms.get(String(body.room || ""));
  if (!room) return { code: 200, body: { ok: true } };
  const p = room.players.find((x) => x.id === body.player);
  if (!p) return { code: 200, body: { ok: true } };
  p.quit = true;
  if (room.phase === "lobby") {
    room.players.splice(room.players.indexOf(p), 1);
    if (room.players.length === 0) rooms.delete(room.code);
    else bump(room);
  } else if (room.phase !== "finished") {
    playerLeft(room, p);
  }
  return { code: 200, body: { ok: true } };
}

function poll(url, res) {
  const room = rooms.get(url.searchParams.get("room") || "");
  if (!room) return respond(res, 200, { error: "gone" });
  const p = room.players.find((x) => x.id === url.searchParams.get("player"));
  if (!p) return respond(res, 200, { error: "gone" });
  const v = Number(url.searchParams.get("v"));
  p.lastSeen = now();
  // שחקן שהחיבור שלו נפל והוא חזר (למשל אחרי שהאפליקציה הייתה ברקע) - מחזירים אותו למשחק
  if (p.left && !p.quit && room.phase !== "finished" && active(room).length >= 1) {
    p.left = false;
    bump(room);
  }
  if (p.waiting) { // בקשה ישנה פתוחה - משחררים אותה
    clearTimeout(p.waiting.timer);
    respond(p.waiting.res, 200, snapshot(room, p.id));
    p.waiting = null;
  }
  if (!(v >= room.v)) return respond(res, 200, snapshot(room, p.id));
  const w = { res };
  w.timer = setTimeout(() => {
    if (p.waiting === w) {
      p.waiting = null;
      p.lastSeen = now();
      respond(res, 200, snapshot(room, p.id));
    }
  }, POLL_HOLD_MS);
  p.waiting = w;
  res.on("close", () => {
    if (p.waiting === w) {
      clearTimeout(w.timer);
      p.waiting = null;
      p.lastSeen = now();
    }
  });
}

function readJson(req, cb) {
  let data = "";
  req.on("data", (c) => {
    data += c;
    if (data.length > 300000) req.destroy();
  });
  req.on("end", () => {
    try { cb(JSON.parse(data || "{}")); } catch (e) { cb(null); }
  });
}

// ---- אתר המשחק (קבצים מהתיקייה public) ----
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const STATIC = new Map();
const NO_CACHE = new Set(["/index.html", "/sw.js", "/manifest.json"]);
try {
  for (const f of fs.readdirSync(PUBLIC_DIR)) {
    const full = path.join(PUBLIC_DIR, f);
    if (!fs.statSync(full).isFile()) continue;
    STATIC.set("/" + f, { type: MIME[path.extname(f).toLowerCase()] || "application/octet-stream", buf: fs.readFileSync(full) });
  }
} catch (e) {
  console.error("לא נמצאה תיקיית public - האתר לא יוגש", e.message);
}

function serveStatic(res, pathname, headOnly) {
  const f = STATIC.get(pathname);
  if (!f) return false;
  res.writeHead(200, {
    "Content-Type": f.type,
    "Content-Length": f.buf.length,
    "Cache-Control": NO_CACHE.has(pathname) ? "no-cache" : "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(headOnly ? undefined : f.buf);
  return true;
}

process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" });
    return res.end();
  }
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
    // דפדפן מקבל את האתר, כל השאר (בדיקות תקינות וכד') מקבלים JSON כמו קודם
    if (String(req.headers.accept || "").includes("text/html") && serveStatic(res, "/index.html", req.method === "HEAD")) return;
    const total = CATEGORIES.reduce((s, c) => s + c.questions.length, 0);
    return respond(res, 200, { ok: true, rooms: rooms.size, categories: CATEGORIES.length, questions: total });
  }
  if ((req.method === "GET" || req.method === "HEAD") && serveStatic(res, url.pathname, req.method === "HEAD")) return;
  if (req.method === "GET" && url.pathname === "/categories") {
    return respond(res, 200, {
      categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, count: c.questions.length })),
      maxPlayers: MAX_PLAYERS,
      maxQuestions: MAX_QUESTIONS,
      maxCustomCats: MAX_CUSTOM_CATS,
      maxCustomQuestions: MAX_CUSTOM_Q,
    });
  }
  if (req.method === "GET" && url.pathname === "/poll") return poll(url, res);
  if (req.method === "POST") {
    const handlers = { "/create": createRoom, "/join": joinRoom, "/answer": answer, "/leave": leave };
    const h = handlers[url.pathname];
    if (!h) return respond(res, 404, { error: "not_found" });
    return readJson(req, (body) => {
      if (!body) return respond(res, 400, { error: "bad_json" });
      let r;
      try { r = h(body); } catch (e) { console.error(e); r = { code: 500, body: { error: "server" } }; }
      respond(res, r.code, r.body);
    });
  }
  respond(res, 404, { error: "not_found" });
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => {
  const total = CATEGORIES.reduce((s, c) => s + c.questions.length, 0);
  console.log("Trivia server listening on port " + PORT + " (" + CATEGORIES.length + " categories, " + total + " questions)");
});
