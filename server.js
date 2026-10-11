// שרת משחק טריוויה לשני שחקנים. ללא תלויות חיצוניות - רק Node.js 18 ומעלה.
"use strict";
const http = require("http");
const crypto = require("crypto");
const QUESTIONS = require("./questions.json");

const PORT = process.env.PORT || 3000;
const QUESTION_MS = Number(process.env.QUESTION_MS) || 10000; // זמן לכל שאלה
const REVEAL_MS = Number(process.env.REVEAL_MS) || 2500;      // כמה זמן מציגים את התשובה הנכונה
const START_MS = Number(process.env.START_MS) || 3000;        // ספירה לאחור לפני השאלה הראשונה
const POLL_HOLD_MS = 9000;       // כמה זמן מחזיקים בקשת poll פתוחה
const DISCONNECT_MS = 15000;     // אחרי כמה זמן בלי קשר שחקן נחשב כעזב
const LOBBY_IDLE_MS = 5 * 60 * 1000;

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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickQuestions(n) {
  const idx = shuffle(QUESTIONS.map((_, i) => i)).slice(0, n);
  return idx.map((i) => {
    const row = QUESTIONS[i];
    const correctText = row[1];
    const answers = shuffle(row.slice(1));
    return { text: row[0], answers, correct: answers.indexOf(correctText) };
  });
}

function makePlayer(name) {
  return { id: "p" + rid(8), name: cleanName(name), score: 0, ans: null, lastSeen: now(), waiting: null };
}

function connected(p) {
  return !!p.waiting || now() - p.lastSeen < DISCONNECT_MS;
}

// ---- מצב מותאם לשחקן ----
function snapshot(room, pid) {
  const me = room.players.find((p) => p.id === pid);
  const opp = room.players.find((p) => p.id !== pid) || null;
  const st = {
    v: room.v,
    now: now(),
    phase: room.phase,
    code: room.code,
    rounds: room.rounds,
    q: room.q,
    startAt: room.startAt,
    qStart: room.qStart,
    deadline: room.deadline,
    revealUntil: room.revealUntil,
    me: { name: me.name, score: me.score, answered: !!me.ans, choice: me.ans ? me.ans.choice : -1 },
    opp: opp ? { name: opp.name, score: opp.score, answered: !!opp.ans, connected: connected(opp) } : null,
    question: null,
    reveal: null,
    result: null,
  };
  if ((room.phase === "question" || room.phase === "reveal") && room.q >= 0) {
    const q = room.questions[room.q];
    st.question = { text: q.text, answers: q.answers };
  }
  if (room.phase === "reveal" && opp) {
    const q = room.questions[room.q];
    st.reveal = {
      correct: q.correct,
      me: { choice: me.ans ? me.ans.choice : -1, points: me.ans ? me.ans.points : 0 },
      opp: { choice: opp.ans ? opp.ans.choice : -1, points: opp.ans ? opp.ans.points : 0 },
    };
  }
  if (room.phase === "finished") {
    let winner = "tie";
    if (room.forfeitBy) winner = room.forfeitBy === pid ? "opp" : "me";
    else if (opp) winner = me.score > opp.score ? "me" : me.score < opp.score ? "opp" : "tie";
    st.result = { winner, forfeit: !!room.forfeitBy };
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

function finish(room, forfeitBy) {
  room.phase = "finished";
  room.forfeitBy = forfeitBy || null;
  bump(room);
}

function tick() {
  const t = now();
  for (const [code, room] of rooms) {
    if (room.phase === "lobby") {
      if (t - room.touched > LOBBY_IDLE_MS || (!connected(room.players[0]) && t - room.players[0].lastSeen > 60000)) {
        rooms.delete(code);
      }
      continue;
    }
    if (room.phase === "finished") {
      if (t - room.touched > 2 * 60 * 1000) rooms.delete(code);
      continue;
    }
    // עזיבה באמצע משחק
    const gone = room.players.find((p) => !connected(p));
    if (gone) {
      finish(room, gone.id);
      continue;
    }
    if (room.phase === "starting" && t >= room.startAt) {
      startQuestion(room, 0);
    } else if (room.phase === "question" && t >= room.deadline) {
      endQuestion(room);
    } else if (room.phase === "reveal" && t >= room.revealUntil) {
      if (room.q + 1 < room.rounds) startQuestion(room, room.q + 1);
      else finish(room, null);
    }
  }
}
setInterval(tick, 100);

// ---- פעולות ----
function createRoom(body) {
  const code = newCode();
  if (!code) return { code: 503, body: { error: "busy" } };
  let rounds = parseInt(body.rounds, 10);
  if (![5, 10, 15, 20].includes(rounds)) rounds = 10;
  rounds = Math.min(rounds, QUESTIONS.length);
  const p = makePlayer(body.name);
  const room = {
    code, rounds, players: [p], phase: "lobby", v: 1, q: -1,
    questions: pickQuestions(rounds),
    startAt: 0, qStart: 0, deadline: 0, revealUntil: 0,
    forfeitBy: null, touched: now(),
  };
  rooms.set(code, room);
  return { code: 200, body: { room: code, player: p.id } };
}

function joinRoom(body) {
  const room = rooms.get(String(body.room || "").trim());
  if (!room) return { code: 404, body: { error: "not_found" } };
  if (room.phase !== "lobby") return { code: 409, body: { error: room.players.length >= 2 ? "full" : "started" } };
  if (room.players.length >= 2) return { code: 409, body: { error: "full" } };
  const p = makePlayer(body.name);
  room.players.push(p);
  room.phase = "starting";
  room.startAt = now() + START_MS;
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
  const t = now();
  if (t > room.deadline + 400) return { code: 409, body: { error: "late" } };
  const choice = parseInt(body.choice, 10);
  if (!(choice >= 0 && choice <= 3)) return { code: 400, body: { error: "bad_choice" } };
  const elapsed = Math.min(Math.max(t - room.qStart, 0), QUESTION_MS);
  const correct = choice === room.questions[room.q].correct;
  // 1000 נקודות לתשובה מיידית, יורד עד 200 לתשובה בסוף הזמן. טעות = 0
  const points = correct ? Math.round(200 + 800 * (1 - elapsed / QUESTION_MS)) : 0;
  p.ans = { choice, points, elapsed };
  if (room.players.every((x) => x.ans)) endQuestion(room); // שניהם ענו - ממשיכים מיד
  else bump(room);
  return { code: 200, body: { ok: true } };
}

function leave(body) {
  const room = rooms.get(String(body.room || ""));
  if (!room) return { code: 200, body: { ok: true } };
  const p = room.players.find((x) => x.id === body.player);
  if (!p) return { code: 200, body: { ok: true } };
  if (room.phase === "lobby") rooms.delete(room.code);
  else if (room.phase !== "finished") finish(room, p.id);
  return { code: 200, body: { ok: true } };
}

function poll(url, res) {
  const room = rooms.get(url.searchParams.get("room") || "");
  if (!room) return respond(res, 200, { error: "gone" });
  const p = room.players.find((x) => x.id === url.searchParams.get("player"));
  if (!p) return respond(res, 200, { error: "gone" });
  const v = Number(url.searchParams.get("v"));
  p.lastSeen = now();
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
    if (data.length > 10000) req.destroy();
  });
  req.on("end", () => {
    try { cb(JSON.parse(data || "{}")); } catch (e) { cb(null); }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST" });
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/") {
    return respond(res, 200, { ok: true, rooms: rooms.size, questions: QUESTIONS.length });
  }
  if (req.method === "GET" && url.pathname === "/poll") return poll(url, res);
  if (req.method === "POST") {
    const handlers = { "/create": createRoom, "/join": joinRoom, "/answer": answer, "/leave": leave };
    const h = handlers[url.pathname];
    if (!h) return respond(res, 404, { error: "not_found" });
    return readJson(req, (body) => {
      if (!body) return respond(res, 400, { error: "bad_json" });
      const r = h(body);
      respond(res, r.code, r.body);
    });
  }
  respond(res, 404, { error: "not_found" });
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log("Trivia server listening on port " + PORT + " (" + QUESTIONS.length + " questions)"));
