"use strict";

// ---- Logical field (all game logic uses these coordinates) ----
const W = 480;
const H = 800;
const MARGIN = 26;           // pitch border inset
const GOAL_W = 150;          // width of the goal mouth
const BALL_R = 12;
const PLR_R = 20;

const canvas = document.getElementById("pitch");
const ctx = canvas.getContext("2d");

// Screen <-> logical transform (filled in by resize())
let view = { scale: 1, offX: 0, offY: 0, cssW: W, cssH: H };

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || W;
  const cssH = canvas.clientHeight || H;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const scale = Math.min(cssW / W, cssH / H);
  view = {
    scale,
    offX: (cssW - W * scale) / 2,
    offY: (cssH - H * scale) / 2,
    cssW,
    cssH,
    dpr,
  };
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * view.offX, dpr * view.offY);
}
window.addEventListener("resize", resize);

function screenToLogical(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - view.offX) / view.scale,
    y: (clientY - rect.top - view.offY) / view.scale,
  };
}

// ---- Entities ----
const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, r: BALL_R };
const you = { x: W / 2, y: H * 0.72, vx: 0, vy: 0, r: PLR_R, color: "#ffe14d" };
const cpu = { x: W / 2, y: H * 0.28, vx: 0, vy: 0, r: PLR_R, color: "#ff8f6b" };

const goalTop = { y: MARGIN, x1: (W - GOAL_W) / 2, x2: (W + GOAL_W) / 2 };   // YOU score here
const goalBot = { y: H - MARGIN, x1: (W - GOAL_W) / 2, x2: (W + GOAL_W) / 2 }; // CPU scores here

// ---- Game state ----
const MATCH_SECONDS = 90;
let state = "menu"; // menu | playing | over
let scoreYou = 0;
let scoreCpu = 0;
let timeLeft = MATCH_SECONDS;
let celebrate = 0; // seconds of goal flash remaining
let lastGoal = null;

const el = {
  scoreYou: document.getElementById("scoreYou"),
  scoreCpu: document.getElementById("scoreCpu"),
  clock: document.getElementById("clock"),
  overlay: document.getElementById("overlay"),
  overlayText: document.getElementById("overlayText"),
  startBtn: document.getElementById("startBtn"),
  installHint: document.getElementById("installHint"),
};

// ---- Input ----
const keys = new Set();
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

// Floating joystick (touch / mouse drag on the pitch)
const joy = { active: false, id: null, ox: 0, oy: 0, x: 0, y: 0 };
const JOY_MAX = 90; // logical units for full tilt

canvas.addEventListener("pointerdown", (e) => {
  if (state !== "playing") return;
  const p = screenToLogical(e.clientX, e.clientY);
  joy.active = true;
  joy.id = e.pointerId;
  joy.ox = joy.x = p.x;
  joy.oy = joy.y = p.y;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!joy.active || e.pointerId !== joy.id) return;
  const p = screenToLogical(e.clientX, e.clientY);
  joy.x = p.x;
  joy.y = p.y;
});
function endJoy(e) {
  if (e.pointerId !== joy.id) return;
  joy.active = false;
  joy.id = null;
}
canvas.addEventListener("pointerup", endJoy);
canvas.addEventListener("pointercancel", endJoy);

function inputVector() {
  let dx = 0, dy = 0;
  if (keys.has("arrowleft") || keys.has("a")) dx -= 1;
  if (keys.has("arrowright") || keys.has("d")) dx += 1;
  if (keys.has("arrowup") || keys.has("w")) dy -= 1;
  if (keys.has("arrowdown") || keys.has("s")) dy += 1;
  if (dx || dy) {
    const m = Math.hypot(dx, dy);
    return { x: dx / m, y: dy / m };
  }
  if (joy.active) {
    let jx = joy.x - joy.ox;
    let jy = joy.y - joy.oy;
    const d = Math.hypot(jx, jy);
    if (d > 6) {
      const m = Math.min(1, d / JOY_MAX);
      return { x: (jx / d) * m, y: (jy / d) * m };
    }
  }
  return { x: 0, y: 0 };
}

// ---- Physics helpers ----
const PLR_SPEED = 300;
const CPU_SPEED = 288;
const PLR_ACCEL = 2400;
const KICK = 660;
const BALL_MAX = 940;

function moveActor(a, wish, speed, accel, dt) {
  const tvx = wish.x * speed;
  const tvy = wish.y * speed;
  const k = Math.min(1, accel * dt / (speed || 1));
  a.vx += (tvx - a.vx) * k;
  a.vy += (tvy - a.vy) * k;
  a.x += a.vx * dt;
  a.y += a.vy * dt;
  // keep inside pitch
  const minX = MARGIN + a.r, maxX = W - MARGIN - a.r;
  const minY = MARGIN + a.r, maxY = H - MARGIN - a.r;
  if (a.x < minX) { a.x = minX; a.vx = 0; }
  if (a.x > maxX) { a.x = maxX; a.vx = 0; }
  if (a.y < minY) { a.y = minY; a.vy = 0; }
  if (a.y > maxY) { a.y = maxY; a.vy = 0; }
}

function actorHitsBall(a) {
  const dx = ball.x - a.x;
  const dy = ball.y - a.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const min = a.r + ball.r;
  if (dist < min) {
    const nx = dx / dist, ny = dy / dist;
    // separate
    ball.x = a.x + nx * min;
    ball.y = a.y + ny * min;
    // kick: outward impulse + a share of the actor's momentum
    const impulse = KICK + Math.hypot(a.vx, a.vy) * 0.7;
    ball.vx = nx * impulse + a.vx * 0.35;
    ball.vy = ny * impulse + a.vy * 0.35;
  }
}

function cpuThink(dt) {
  // Get behind the ball on the bottom side, then push it toward the top goal.
  const goalX = (goalTop.x1 + goalTop.x2) / 2;
  const aimX = ball.x + (ball.x - goalX) * 0.35;
  const behindY = ball.y + (ball.r + cpu.r) * 0.9; // stand below ball
  let tx = aimX;
  let ty = behindY;
  // if ball is behind cpu (closer to top goal than cpu is), race back to defend center
  if (ball.y < cpu.y - 40 && ball.y < H * 0.4) {
    tx = W / 2;
    ty = Math.min(cpu.y, H * 0.34);
  }
  const dx = tx - cpu.x, dy = ty - cpu.y;
  const d = Math.hypot(dx, dy) || 1;
  const gate = d > 8 ? 1 : 0;
  moveActor(cpu, { x: (dx / d) * gate, y: (dy / d) * gate }, CPU_SPEED, PLR_ACCEL, dt);
}

function kickoff(towardTop) {
  ball.x = W / 2; ball.y = H / 2; ball.vx = 0; ball.vy = 0;
  you.x = W / 2; you.y = H * 0.72; you.vx = you.vy = 0;
  cpu.x = W / 2; cpu.y = H * 0.28; cpu.vx = cpu.vy = 0;
}

function scoreGoal(who) {
  if (who === "you") scoreYou++; else scoreCpu++;
  el.scoreYou.textContent = scoreYou;
  el.scoreCpu.textContent = scoreCpu;
  celebrate = 1.1;
  lastGoal = who;
  kickoff();
}

function updateBall(dt) {
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  // friction
  const damp = Math.exp(-1.7 * dt);
  ball.vx *= damp;
  ball.vy *= damp;
  const sp = Math.hypot(ball.vx, ball.vy);
  if (sp > BALL_MAX) { ball.vx *= BALL_MAX / sp; ball.vy *= BALL_MAX / sp; }
  if (sp < 3) { ball.vx = 0; ball.vy = 0; }

  const left = MARGIN + ball.r, right = W - MARGIN - ball.r;
  const top = MARGIN + ball.r, bot = H - MARGIN - ball.r;

  // side walls
  if (ball.x < left) { ball.x = left; ball.vx = Math.abs(ball.vx) * 0.7; }
  if (ball.x > right) { ball.x = right; ball.vx = -Math.abs(ball.vx) * 0.7; }

  // top: goal mouth or wall
  if (ball.y < top) {
    if (ball.x > goalTop.x1 && ball.x < goalTop.x2 && ball.y < MARGIN) {
      scoreGoal("you"); return;
    }
    ball.y = top; ball.vy = Math.abs(ball.vy) * 0.7;
  }
  // bottom: goal mouth or wall
  if (ball.y > bot) {
    if (ball.x > goalBot.x1 && ball.x < goalBot.x2 && ball.y > H - MARGIN) {
      scoreGoal("cpu"); return;
    }
    ball.y = bot; ball.vy = -Math.abs(ball.vy) * 0.7;
  }
}

// ---- Main loop ----
let last = 0;
function frame(ts) {
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  if (dt > 0.05) dt = 0.05; // clamp big gaps

  if (state === "playing") {
    timeLeft -= dt;
    if (celebrate > 0) celebrate -= dt;
    if (timeLeft <= 0) {
      timeLeft = 0;
      endMatch();
    } else {
      moveActor(you, inputVector(), PLR_SPEED, PLR_ACCEL, dt);
      cpuThink(dt);
      updateBall(dt);
      actorHitsBall(you);
      actorHitsBall(cpu);
      // separate players so they don't overlap
      separate(you, cpu);
      const m = Math.floor(timeLeft / 60);
      const s = Math.floor(timeLeft % 60);
      el.clock.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
  }

  draw();
  requestAnimationFrame(frame);
}

function separate(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 0.001;
  const min = a.r + b.r;
  if (dist < min) {
    const push = (min - dist) / 2;
    const nx = dx / dist, ny = dy / dist;
    a.x -= nx * push; a.y -= ny * push;
    b.x += nx * push; b.y += ny * push;
  }
}

// ---- Rendering ----
function draw() {
  ctx.clearRect(-2, -2, W + 4, H + 4);

  // grass stripes
  const stripes = 10;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? "#0a6c35" : "#0b7a3b";
    ctx.fillRect(0, (H / stripes) * i, W, H / stripes + 1);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 3;

  // outer boundary
  roundRectPath(MARGIN, MARGIN, W - 2 * MARGIN, H - 2 * MARGIN, 10);
  ctx.stroke();

  // halfway line + center circle
  ctx.beginPath();
  ctx.moveTo(MARGIN, H / 2);
  ctx.lineTo(W - MARGIN, H / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 58, 0, Math.PI * 2);
  ctx.stroke();
  dot(W / 2, H / 2, 4);

  // penalty boxes
  const boxW = 220, boxH = 92;
  ctx.strokeRect((W - boxW) / 2, MARGIN, boxW, boxH);
  ctx.strokeRect((W - boxW) / 2, H - MARGIN - boxH, boxW, boxH);

  // goals
  drawGoal(goalTop.x1, MARGIN, GOAL_W, true);
  drawGoal(goalBot.x1, H - MARGIN, GOAL_W, false);

  // entities
  drawPlayer(cpu, "И");
  drawPlayer(you, "В");
  drawBall();

  // joystick
  if (joy.active) {
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(joy.ox, joy.oy, JOY_MAX, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.6;
    let jx = joy.x - joy.ox, jy = joy.y - joy.oy;
    const d = Math.hypot(jx, jy);
    if (d > JOY_MAX) { jx = jx / d * JOY_MAX; jy = jy / d * JOY_MAX; }
    ctx.beginPath(); ctx.arc(joy.ox + jx, joy.oy + jy, 34, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // goal flash
  if (celebrate > 0) {
    ctx.globalAlpha = Math.min(0.5, celebrate * 0.5);
    ctx.fillStyle = lastGoal === "you" ? "#ffe14d" : "#ff8f6b";
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#06371c";
    ctx.font = "bold 54px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ГОЛ!", W / 2, H / 2);
  }
}

function drawGoal(x, y, w, top) {
  ctx.save();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  // net box
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.5;
  const depth = 16;
  const yy = top ? y - depth : y + depth;
  ctx.strokeRect(x, Math.min(y, yy), w, depth);
  ctx.restore();
}

function drawPlayer(p, label) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#06371c";
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, p.x, p.y + 1);
}

function drawBall() {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, ball.r * 0.42, 0, Math.PI * 2);
  ctx.fill();
}

function dot(x, y, r) {
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- Flow ----
function startMatch() {
  scoreYou = 0; scoreCpu = 0; timeLeft = MATCH_SECONDS; celebrate = 0;
  el.scoreYou.textContent = "0";
  el.scoreCpu.textContent = "0";
  kickoff();
  state = "playing";
  el.overlay.classList.remove("show");
}

function endMatch() {
  state = "over";
  let title;
  if (scoreYou > scoreCpu) title = "Победа! 🏆";
  else if (scoreYou < scoreCpu) title = "Поражение 😔";
  else title = "Ничья 🤝";
  el.overlayText.innerHTML =
    `<b style="font-size:20px">${title}</b><br />Счёт ${scoreYou} : ${scoreCpu}<br /><br />Ещё разок?`;
  el.startBtn.textContent = "Играть снова";
  el.overlay.classList.add("show");
}

el.startBtn.addEventListener("click", startMatch);

// Show install hint on iOS-style standalone-capable browsers
if (!window.matchMedia("(display-mode: standalone)").matches) {
  el.installHint.hidden = false;
}

resize();
requestAnimationFrame(frame);

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
