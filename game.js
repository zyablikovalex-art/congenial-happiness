"use strict";

/* =========================================================================
   Футбол 11 на 11 — псевдо-3D вид сбоку (broadcast), альбомная ориентация.
   Управление: экранный джойстик + Пас/Удар/Спринт или клавиатура.
   «Пас» работает и как отбор, если мяч не у нашей команды.
   Всё игровое состояние живёт в мировых координатах (x вдоль поля от ворот
   к воротам, z — глубина от ближней бровки к дальней). Проекция в экранные
   пиксели делается отдельно в project().
   ========================================================================= */

// ---- Мир ----
const PITCH_L = 1200;     // длина поля (ось x: 0 — левые ворота, PITCH_L — правые)
const PITCH_W = 720;      // ширина/глубина (ось z: 0 — ближняя бровка, PITCH_W — дальняя)
const GOAL_HALF = 112;    // половина ширины створа ворот (по z)
const VIS_NEAR = 720;     // сколько мировых единиц длины видно у ближней бровки
                          // (< PITCH_L => всё поле не влезает, камера ездит)
const GOAL_DEPTH_H = 130; // макс. высота мяча, при которой он ещё влетает в ворота
const PLR_R = 15;         // радиус игрока (мир)
const BALL_R = 8;

const MOUTH_LO = PITCH_W / 2 - GOAL_HALF;
const MOUTH_HI = PITCH_W / 2 + GOAL_HALF;

// ---- Тюнинг ----
const MATCH_SECONDS = 120;
const SPEED = 132;        // базовая скорость игрока (мир/сек) — темп снижен
const SPRINT = 188;       // скорость со спринтом
const GK_SPEED = 118;
const ACCEL = 820;
const CTRL_R = 27;        // радиус получения контроля над мячом
const TACKLE_R = 28;      // радиус отбора (ИИ, автоматический)
const TACKLE_STEAL_R = 46;// радиус ручного отбора по кнопке «Пас»
const STEAL_RATE = 2.2;   // вероятность отбора в секунду при контакте
const DRIBBLE_AHEAD = 24; // насколько мяч выносится вперёд при ведении
// Сила паса/удара зависит от заряда шкалы усилия (min при коротком тапе, max при полном).
const PASS_MIN = 220, PASS_MAX = 500;
const SHOT_MIN = 360, SHOT_MAX = 620;
const CHARGE_TIME = 0.8;  // сек до полного заряда
const CHARGE_MIN = 0.32;  // доля силы при мгновенном тапе
const GRAV = 900;
const BOUNCE = 0.55;

const canvas = document.getElementById("pitch");
const ctx = canvas.getContext("2d");

// Параметры проекции (заполняются в resize())
const P = {
  cssW: 480, cssH: 800, dpr: 1,
  CX: 240, FAR_Y: 130, NEAR_Y: 560,
  ppuNear: 1, ppuFar: 0.68,     // пикселей на мировую единицу длины (ближняя/дальняя бровка)
  NEAR_SCALE: 1, FAR_SCALE: 0.56,
};
let camX = PITCH_L / 2;          // центр камеры по длине поля (едет за мячом)

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 800;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  P.cssW = cssW; P.cssH = cssH; P.dpr = dpr;
  P.CX = cssW / 2;
  P.FAR_Y = cssH * 0.15;
  P.NEAR_Y = cssH * 0.88;
  // Масштаб длины: у ближней бровки на весь экран влезает VIS_NEAR единиц.
  P.ppuNear = cssW / VIS_NEAR;
  P.ppuFar = P.ppuNear * 0.66;  // дальше — сильнее сжато (перспектива)
  P.NEAR_SCALE = clamp(cssH / 430, 0.9, 2.0);
  P.FAR_SCALE = P.NEAR_SCALE * 0.62;
}
window.addEventListener("resize", resize);

// Допустимый диапазон камеры: у ближней бровки не выходим за пределы поля.
function camClamp(x) {
  const half = VIS_NEAR / 2;
  return clamp(x, half, PITCH_L - half);
}

// Мир -> экран. h — высота мяча над газоном (мировые единицы).
function project(x, z, h) {
  const t = z / PITCH_W;                       // 0 — ближе (низ, крупнее), 1 — дальше
  const scale = P.NEAR_SCALE + (P.FAR_SCALE - P.NEAR_SCALE) * t;
  const gy = P.NEAR_Y + (P.FAR_Y - P.NEAR_Y) * t;
  const ppu = P.ppuNear + (P.ppuFar - P.ppuNear) * t;
  const sx = P.CX + (x - camX) * ppu;
  const sy = gy - (h || 0) * 0.7 * scale;
  return { sx, sy, scale };
}

// ---- Мелкие утилиты ----
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hyp(a, b) { return Math.hypot(a, b); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
// Детерминированный псевдослучай (Math.random в этом окружении недоступен).
function nrand(n) { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }

// ---- Расстановка (4-4-2), доли поля от своих ворот (fx) и по ширине (fz) ----
const FORMATION = [
  { fx: 0.05, fz: 0.50, gk: true }, // вратарь
  { fx: 0.20, fz: 0.16 },
  { fx: 0.22, fz: 0.38 },
  { fx: 0.22, fz: 0.62 },
  { fx: 0.20, fz: 0.84 },
  { fx: 0.42, fz: 0.14 },
  { fx: 0.45, fz: 0.38 },
  { fx: 0.45, fz: 0.62 },
  { fx: 0.42, fz: 0.86 },
  { fx: 0.66, fz: 0.40 },
  { fx: 0.66, fz: 0.60 },
];

// ---- Игроки ----
// team 0 = ВЫ (атакует вправо, защищает левые ворота x=0)
// team 1 = ИИ (атакует влево, защищает правые ворота x=PITCH_L)
const players = [];
function makeTeam(team) {
  for (let i = 0; i < FORMATION.length; i++) {
    const f = FORMATION[i];
    const hx = team === 0 ? f.fx * PITCH_L : (1 - f.fx) * PITCH_L;
    const hz = f.fz * PITCH_W;
    players.push({
      id: players.length, team, isGK: !!f.gk,
      home: { x: hx, z: hz },
      x: hx, z: hz, vx: 0, vz: 0,
      dirx: team === 0 ? 1 : -1, dirz: 0,
      runPhase: i * 0.7,
    });
  }
}
makeTeam(0);
makeTeam(1);

const ball = { x: PITCH_L / 2, z: PITCH_W / 2, h: 0, vx: 0, vz: 0, vh: 0, owner: null, cooldown: 0 };

// ---- Состояние матча ----
let state = "menu";        // menu | playing | over
let scoreYou = 0, scoreCpu = 0;
let timeLeft = MATCH_SECONDS;
let celebrate = 0;
let lastGoal = null;
let active = null;         // активный игрок команды 0
let F = 0;                 // счётчик кадров (для детерминированного «рандома»)

const el = {
  scoreYou: document.getElementById("scoreYou"),
  scoreCpu: document.getElementById("scoreCpu"),
  clock: document.getElementById("clock"),
  overlay: document.getElementById("overlay"),
  overlayText: document.getElementById("overlayText"),
  startBtn: document.getElementById("startBtn"),
  installHint: document.getElementById("installHint"),
  gamepad: document.getElementById("gamepad"),
};

/* =========================================================================
   Запрет масштабирования на мобильных (iOS Safari игнорирует user-scalable=no).
   Гасим пинч-жесты и двойной тап, не мешая кнопкам/джойстику.
   ========================================================================= */
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
document.addEventListener("dblclick", (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = e.timeStamp;
  // Гасим только быстрый повторный тап (double-tap zoom), не трогая кнопки.
  if (now - lastTouchEnd <= 350 && !(e.target && e.target.closest && e.target.closest("button"))) {
    e.preventDefault();
  }
  lastTouchEnd = now;
}, { passive: false });

/* =========================================================================
   Ввод: экранный геймпад + клавиатура
   ========================================================================= */
const pad = { sprint: false };
const actionQueue = []; // 'switch' | {type:'pass'|'shoot'|'tackle', power}

// Заряд усилия для паса/удара (удержание кнопки).
const charge = { action: null, t: 0 };
const barEl = document.getElementById("powerbar");
const barFillEl = document.getElementById("powerfill");

function showPowerBar(action, frac) {
  if (!barEl || !barFillEl) return;
  barEl.hidden = false;
  barFillEl.style.width = Math.round(frac * 100) + "%";
  barFillEl.style.background = action === "shoot" ? "#ff5a4d" : "#4a90ff";
}
function hidePowerBar() { if (barEl) barEl.hidden = true; }

function beginPass() {
  if (state !== "playing") return;
  if (active && ball.owner === active) { charge.action = "pass"; charge.t = 0; }
  else actionQueue.push({ type: "tackle" }); // мяч не у нас — сразу отбор
}
function beginShoot() {
  if (state !== "playing") return;
  if (active && ball.owner === active) { charge.action = "shoot"; charge.t = 0; }
}
function releaseCharge(action) {
  if (charge.action !== action) return;
  const f = CHARGE_MIN + Math.min(1, charge.t / CHARGE_TIME) * (1 - CHARGE_MIN);
  actionQueue.push({ type: action, power: f });
  charge.action = null; charge.t = 0;
  hidePowerBar();
}
function resetCharge() { charge.action = null; charge.t = 0; hidePowerBar(); }

// Экранный джойстик (аналоговый). База зафиксирована, ручка тянется к пальцу.
const stick = { active: false, id: null, cx: 0, cy: 0, jx: 0, jy: 0, R: 46 };
const stickEl = document.getElementById("stick");
const knobEl = document.getElementById("knob");

function stickSet(clientX, clientY) {
  let dx = clientX - stick.cx;
  let dy = clientY - stick.cy;
  const d = hyp(dx, dy);
  if (d > stick.R) { dx = dx / d * stick.R; dy = dy / d * stick.R; }
  stick.jx = dx / stick.R;
  stick.jy = dy / stick.R;
  if (knobEl) knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
}
function stickReset() {
  stick.active = false; stick.id = null; stick.jx = 0; stick.jy = 0;
  if (knobEl) knobEl.style.transform = "translate(0px, 0px)";
}
if (stickEl) {
  stickEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = stickEl.getBoundingClientRect();
    stick.cx = r.left + r.width / 2;
    stick.cy = r.top + r.height / 2;
    stick.R = r.width * 0.36;
    stick.active = true; stick.id = e.pointerId;
    stickSet(e.clientX, e.clientY);
    try { stickEl.setPointerCapture(e.pointerId); } catch (_) {}
  });
  stickEl.addEventListener("pointermove", (e) => {
    if (!stick.active || e.pointerId !== stick.id) return;
    stickSet(e.clientX, e.clientY);
  });
  const up = (e) => { if (e.pointerId === stick.id) stickReset(); };
  stickEl.addEventListener("pointerup", up);
  stickEl.addEventListener("pointercancel", up);
  stickEl.addEventListener("contextmenu", (e) => e.preventDefault());
}

// Кнопки действий: ⚡Спринт (удержание), ⇄Смена (тап), ПАС/Отбор и УДАР (заряд).
if (el.gamepad) {
  el.gamepad.querySelectorAll("[data-btn]").forEach((btn) => {
    const name = btn.dataset.btn;
    const press = (e) => {
      e.preventDefault();
      btn.classList.add("pressed");
      if (name === "pass") beginPass();
      else if (name === "shoot") beginShoot();
      else if (name === "switch") { if (state === "playing") actionQueue.push("switch"); }
      else pad[name] = true; // sprint
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    };
    const release = (e) => {
      btn.classList.remove("pressed");
      if (name === "pass") releaseCharge("pass");
      else if (name === "shoot") releaseCharge("shoot");
      else if (name !== "switch") pad[name] = false;
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

// Клавиатура (ПК)
const keyHeld = new Set();
const MOVE_KEYS = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d"];
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.includes(k) || k === " " || k === "shift" || k === "j" || k === "l" || k === "k") e.preventDefault();
  if (keyHeld.has(k)) return; // без автоповтора
  keyHeld.add(k);
  if (state === "playing") {
    if (k === "j" || k === " ") beginPass();
    if (k === "l" || k === "enter") beginShoot();
    if (k === "k") actionQueue.push("switch");
  }
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keyHeld.delete(k);
  if (k === "j" || k === " ") releaseCharge("pass");
  if (k === "l" || k === "enter") releaseCharge("shoot");
});

function inputVector() {
  // Клавиатура (дискретно, полная скорость)
  let dx = 0, dz = 0;
  if (keyHeld.has("arrowleft") || keyHeld.has("a")) dx -= 1;
  if (keyHeld.has("arrowright") || keyHeld.has("d")) dx += 1;
  if (keyHeld.has("arrowup") || keyHeld.has("w")) dz += 1;   // вверх по экрану = дальняя сторона
  if (keyHeld.has("arrowdown") || keyHeld.has("s")) dz -= 1;
  if (dx || dz) { const m = hyp(dx, dz); return { x: dx / m, z: dz / m }; }
  // Джойстик (аналогово: модуль вектора = сила нажатия)
  if (stick.active) {
    const mag = hyp(stick.jx, stick.jy);
    if (mag > 0.14) return { x: stick.jx, z: -stick.jy }; // экранный низ (jy>0) => к ближней бровке (z-)
  }
  return { x: 0, z: 0 };
}
function sprintHeld() { return pad.sprint || keyHeld.has("shift"); }

/* =========================================================================
   Движение и физика
   ========================================================================= */
function moveActor(p, wx, wz, speed, dt) {
  const tvx = wx * speed, tvz = wz * speed;
  const k = Math.min(1, ACCEL * dt / (speed || 1));
  p.vx += (tvx - p.vx) * k;
  p.vz += (tvz - p.vz) * k;
  p.x += p.vx * dt;
  p.z += p.vz * dt;
  p.x = clamp(p.x, PLR_R, PITCH_L - PLR_R);
  p.z = clamp(p.z, PLR_R, PITCH_W - PLR_R);
  const spd = hyp(p.vx, p.vz);
  if (spd > 10) { p.dirx = p.vx / spd; p.dirz = p.vz / spd; p.runPhase += spd * dt * 0.06; }
}

function moveTo(p, tx, tz, speed, dt) {
  const dx = tx - p.x, dz = tz - p.z, d = hyp(dx, dz);
  let wx = 0, wz = 0;
  if (d > 4) { const g = Math.min(1, d / 24); wx = dx / d * g; wz = dz / d * g; }
  moveActor(p, wx, wz, speed, dt);
}

function anyOpponentWithin(p, r) {
  for (const o of players) {
    if (o.team === p.team) continue;
    if (dist(o, p) < r) return true;
  }
  return false;
}

// Нанести удар/пас: мяч становится свободным.
function kick(power, dx, dz, loft) {
  ball.owner = null;
  ball.cooldown = 0.2;
  ball.vx = dx * power;
  ball.vz = dz * power;
  ball.vh = loft || 0;
  if (loft > 0) ball.h = Math.max(ball.h, 1);
}

// f — доля усилия [0..1]. Для ИИ по умолчанию берём среднюю силу.
function doShoot(p, f) {
  if (!p || ball.owner !== p) return;
  if (f == null) f = 0.85;
  const goalX = p.team === 0 ? PITCH_L : 0;
  const targetZ = PITCH_W / 2;
  const dx = goalX - p.x, dz = targetZ - p.z, d = hyp(dx, dz) || 1;
  const speed = SHOT_MIN + f * (SHOT_MAX - SHOT_MIN);
  const loft = 90 + f * 90;
  kick(speed, dx / d, dz / d, loft);
}

function doPass(p, f) {
  if (!p || ball.owner !== p) return;
  if (f == null) f = 0.7;
  const attackDir = p.team === 0 ? 1 : -1;
  const speed = PASS_MIN + f * (PASS_MAX - PASS_MIN);

  // Направление прицела. У активного игрока — джойстик/клавиши (куда целишься),
  // иначе (в т.ч. ИИ) — куда смотрит игрок, в крайнем случае вперёд к воротам.
  let aimx = 0, aimz = 0;
  if (p === active) {
    const iv = inputVector();
    if (hyp(iv.x, iv.z) > 0.2) { aimx = iv.x; aimz = iv.z; }
  }
  if (aimx === 0 && aimz === 0) {
    if (hyp(p.dirx, p.dirz) > 0.1) { aimx = p.dirx; aimz = p.dirz; }
    else { aimx = attackDir; aimz = 0; }
  }
  const am = hyp(aimx, aimz) || 1; aimx /= am; aimz /= am;

  // Ищем партнёра в секторе прицела (совпадение направления важнее всего).
  let best = null, bestScore = -1e9;
  for (const t of players) {
    if (t.team !== p.team || t === p || t.isGK) continue;
    const dx = t.x - p.x, dz = t.z - p.z, d = hyp(dx, dz);
    if (d < 30 || d > 480) continue;
    const align = (dx * aimx + dz * aimz) / d;   // -1..1: насколько партнёр в сторону прицела
    if (align < 0.30) continue;                  // не пасуем вбок/назад от прицела
    const score = align * 1.8 - d / 500;         // приоритет — совпадение с прицелом, ближе лучше
    if (score > bestScore) { bestScore = score; best = t; }
  }

  // Никого в секторе прицела — пас в направлении прицела (в свободную зону).
  if (!best) { kick(speed, aimx, aimz, 0); return; }
  const lx = best.x + aimx * 18, lz = best.z + aimz * 18; // небольшой вынос под ход
  const dx = lx - p.x, dz = lz - p.z, d = hyp(dx, dz) || 1;
  kick(speed, dx / d, dz / d, 0);
}

// Отбор/перехват: рывок к мячу и захват при сближении.
function doTackle(p) {
  if (!p || ball.owner === p) return;
  const dx = ball.x - p.x, dz = ball.z - p.z, d = hyp(dx, dz) || 1;
  p.vx += dx / d * 90; p.vz += dz / d * 90; // рывок делает отбор отзывчивым
  if (d < TACKLE_STEAL_R) {
    if (ball.owner && ball.owner.team !== p.team) {
      ball.owner = p; ball.cooldown = 0.05; // отбор у соперника
    } else if (!ball.owner) {
      ball.owner = p; ball.cooldown = 0;     // перехват свободного мяча
    }
  }
}

/* =========================================================================
   Мяч
   ========================================================================= */
function updateFreeBall(dt) {
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;
  ball.h += ball.vh * dt;
  ball.vh -= GRAV * dt;

  if (ball.h <= 0) {
    ball.h = 0;
    if (ball.vh < 0) ball.vh = -ball.vh * BOUNCE;
    if (Math.abs(ball.vh) < 30) ball.vh = 0;
    const fr = Math.exp(-1.35 * dt); // трение о газон (мяч катится дальше)
    ball.vx *= fr; ball.vz *= fr;
  } else {
    const fr = Math.exp(-0.35 * dt);
    ball.vx *= fr; ball.vz *= fr;
  }
  const sp = hyp(ball.vx, ball.vz);
  if (sp < 4 && ball.h === 0) { ball.vx = 0; ball.vz = 0; }

  // Голы + отскоки от лицевых линий
  if (ball.x <= 0) {
    if (ball.z > MOUTH_LO && ball.z < MOUTH_HI && ball.h < GOAL_DEPTH_H) { scoreGoal("cpu"); return; }
    ball.x = BALL_R; ball.vx = Math.abs(ball.vx) * 0.55;
  } else if (ball.x >= PITCH_L) {
    if (ball.z > MOUTH_LO && ball.z < MOUTH_HI && ball.h < GOAL_DEPTH_H) { scoreGoal("you"); return; }
    ball.x = PITCH_L - BALL_R; ball.vx = -Math.abs(ball.vx) * 0.55;
  }
  // Бровки
  if (ball.z < BALL_R) { ball.z = BALL_R; ball.vz = Math.abs(ball.vz) * 0.6; }
  if (ball.z > PITCH_W - BALL_R) { ball.z = PITCH_W - BALL_R; ball.vz = -Math.abs(ball.vz) * 0.6; }

  if (ball.cooldown > 0) ball.cooldown -= dt;
}

function resolvePossession(dt) {
  if (ball.owner) {
    // Попытки отбора соперниками
    const owner = ball.owner;
    for (const o of players) {
      if (o.team === owner.team) continue;
      if (dist(o, owner) < TACKLE_R) {
        if (nrand(F * 1.7 + o.id * 3.1) < STEAL_RATE * dt) {
          ball.owner = o; ball.cooldown = 0.05;
          break;
        }
      }
    }
  } else if (ball.cooldown <= 0) {
    // Свободный мяч — ближайший в радиусе получает контроль
    let best = null, bd = CTRL_R;
    for (const p of players) {
      const d = dist(p, ball);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) ball.owner = best;
  }
}

function glueBall() {
  const o = ball.owner;
  let bx = o.x + o.dirx * DRIBBLE_AHEAD;
  let bz = o.z + o.dirz * DRIBBLE_AHEAD;
  ball.x = clamp(bx, BALL_R, PITCH_L - BALL_R);
  ball.z = clamp(bz, BALL_R, PITCH_W - BALL_R);
  ball.h = 0; ball.vh = 0;
  ball.vx = o.vx; ball.vz = o.vz;
}

/* =========================================================================
   ИИ команд
   ========================================================================= */
function nearestFieldToBall(team) {
  let best = null, best2 = null, bd = 1e9, bd2 = 1e9;
  for (const p of players) {
    if (p.team !== team || p.isGK) continue;
    const d = dist(p, ball);
    if (d < bd) { bd2 = bd; best2 = best; bd = d; best = p; }
    else if (d < bd2) { bd2 = d; best2 = p; }
  }
  return [best, best2];
}

let chaser = [null, null];
let chaser2 = [null, null];

function aiWithBall(p, dt) {
  const oppGoalX = p.team === 0 ? PITCH_L : 0;
  const attackDir = p.team === 0 ? 1 : -1;
  const distGoal = Math.abs(oppGoalX - p.x);
  const central = Math.abs(p.z - PITCH_W / 2) < 175;
  const pressured = anyOpponentWithin(p, 48);

  if (distGoal < 250 && central) { doShoot(p); return; }
  if (pressured && nrand(F * 0.3 + p.id) < 0.04) { doPass(p); return; }
  // Ведём к воротам, слегка смещаясь к центру
  const tz = p.z + (PITCH_W / 2 - p.z) * 0.03;
  moveTo(p, oppGoalX, tz, SPEED * 0.98, dt);
}

function aiControl(p, dt) {
  const team = p.team;
  const attackDir = team === 0 ? 1 : -1;
  const ownGoalX = team === 0 ? 0 : PITCH_L;

  if (p.isGK) {
    const tx = ownGoalX + attackDir * 30;
    const tz = clamp(ball.z, MOUTH_LO + 8, MOUTH_HI - 8);
    // выходит чуть вперёд, если мяч близко к воротам
    const rush = Math.abs(ball.x - ownGoalX) < 170 ? attackDir * 45 : 0;
    moveTo(p, tx + rush, tz, GK_SPEED, dt);
    return;
  }

  const teamHasBall = ball.owner && ball.owner.team === team;

  // Домашняя позиция, смещённая к мячу (команда двигается как единое целое)
  let tx = p.home.x + (ball.x - PITCH_L / 2) * 0.32;
  let tz = p.home.z + (ball.z - PITCH_W / 2) * 0.42;

  if (!teamHasBall) {
    // Защита: ближайший прессингует мяч, второй страхует
    if (p === chaser[team]) { tx = ball.x; tz = ball.z; }
    else if (p === chaser2[team]) { tx = ball.x - attackDir * 42; tz = ball.z; }
  } else {
    // Атака без мяча: подтягиваемся вперёд, открываемся
    tx += attackDir * 46;
  }

  tx = clamp(tx, 20, PITCH_L - 20);
  tz = clamp(tz, 16, PITCH_W - 16);
  const spd = (p === chaser[team] && !teamHasBall) ? SPEED * 1.04 : SPEED * 0.9;
  moveTo(p, tx, tz, spd, dt);
}

let manualHold = 0; // сек, в течение которых уважаем ручной выбор игрока

function pickActive() {
  // Владеем мячом — управляем владельцем всегда.
  if (ball.owner && ball.owner.team === 0) { active = ball.owner; manualHold = 0; return; }
  const [n] = nearestFieldToBall(0);
  if (!active || active.isGK || active.team !== 0) { active = n; return; }
  // Игрок вручную выбрал игрока — не перехватываем управление автоматически.
  if (manualHold > 0) return;
  if (n && n !== active && dist(n, ball) + 14 < dist(active, ball)) active = n;
  if (!active) active = n;
}

// Ручная смена управляемого игрока (кнопка «Смена»). Циклично по игрокам
// команды 0, отсортированным по близости к мячу.
function cycleActivePlayer() {
  if (ball.owner && ball.owner.team === 0) return; // владеем — смена не нужна
  const field = players.filter((p) => p.team === 0 && !p.isGK);
  field.sort((a, b) => dist(a, ball) - dist(b, ball));
  if (!field.length) return;
  const idx = field.indexOf(active);
  active = field[(idx + 1) % field.length];
  manualHold = 1.6;
}

function userMove(p, dt) {
  const v = inputVector();
  const speed = sprintHeld() ? SPRINT : SPEED;
  moveActor(p, v.x, v.z, speed, dt);
}

function separatePlayers() {
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = hyp(dx, dz) || 0.001;
      const min = PLR_R * 1.7;
      if (d < min) {
        const push = (min - d) / 2;
        const nx = dx / d, nz = dz / d;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
        a.x = clamp(a.x, PLR_R, PITCH_L - PLR_R); a.z = clamp(a.z, PLR_R, PITCH_W - PLR_R);
        b.x = clamp(b.x, PLR_R, PITCH_L - PLR_R); b.z = clamp(b.z, PLR_R, PITCH_W - PLR_R);
      }
    }
  }
}

/* =========================================================================
   Голы / вбрасывание
   ========================================================================= */
function kickoffReset(kickTeam) {
  for (const p of players) {
    p.x = p.home.x; p.z = p.home.z; p.vx = 0; p.vz = 0;
    p.dirx = p.team === 0 ? 1 : -1; p.dirz = 0;
  }
  ball.x = PITCH_L / 2; ball.z = PITCH_W / 2; ball.h = 0;
  ball.vx = 0; ball.vz = 0; ball.vh = 0; ball.owner = null; ball.cooldown = 0.25;
  // Начинающая команда получает мяч: ставим её нападающего в центр
  const fwd = players.find((p) => p.team === kickTeam && !p.isGK && p.home.x === (kickTeam === 0 ? 0.66 * PITCH_L : (1 - 0.66) * PITCH_L));
  const starter = fwd || players.find((p) => p.team === kickTeam && !p.isGK);
  if (starter) { starter.x = PITCH_L / 2; starter.z = PITCH_W / 2 + 6; }
  camX = camClamp(PITCH_L / 2); // камера в центр без долгой прокрутки
  resetCharge();
}

function scoreGoal(who) {
  if (who === "you") scoreYou++; else scoreCpu++;
  el.scoreYou.textContent = scoreYou;
  el.scoreCpu.textContent = scoreCpu;
  celebrate = 1.3;
  lastGoal = who;
  kickoffReset(who === "you" ? 1 : 0); // пропустившая команда вводит мяч
}

/* =========================================================================
   Главный цикл
   ========================================================================= */
let last = 0;
function frame(ts) {
  if (!last) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  if (dt > 0.05) dt = 0.05;

  if (state === "playing") {
    F++;
    timeLeft -= dt;
    if (celebrate > 0) celebrate -= dt;
    if (timeLeft <= 0) { timeLeft = 0; endMatch(); }
    else step(dt);
  }

  draw();
  requestAnimationFrame(frame);
}

function step(dt) {
  if (manualHold > 0) manualHold -= dt;

  // Кого прессинговать
  const n0 = nearestFieldToBall(0), n1 = nearestFieldToBall(1);
  chaser[0] = n0[0]; chaser2[0] = n0[1];
  chaser[1] = n1[0]; chaser2[1] = n1[1];

  pickActive();

  // Накопление заряда усилия, пока держим ПАС/УДАР.
  if (charge.action) {
    // Если по какой-то причине потеряли мяч во время заряда — отменяем.
    if (!active || ball.owner !== active) resetCharge();
    else {
      charge.t = Math.min(CHARGE_TIME, charge.t + dt);
      showPowerBar(charge.action, charge.t / CHARGE_TIME);
    }
  }

  // Действия игрока
  while (actionQueue.length) {
    const a = actionQueue.shift();
    if (a === "switch") cycleActivePlayer();
    else if (a.type === "tackle") doTackle(active);
    else if (a.type === "pass") doPass(active, a.power);
    else if (a.type === "shoot") doShoot(active, a.power);
  }

  // Ход всех игроков
  for (const p of players) {
    if (p === active) userMove(p, dt);
    else if (ball.owner === p) aiWithBall(p, dt);
    else aiControl(p, dt);
  }

  // Мяч
  if (!ball.owner) updateFreeBall(dt);
  resolvePossession(dt);
  if (ball.owner) glueBall();

  separatePlayers();

  // Камера едет за мячом по длине поля (плавно).
  const target = camClamp(ball.x);
  camX += (target - camX) * Math.min(1, 2.6 * dt);

  const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
  el.clock.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* =========================================================================
   Отрисовка
   ========================================================================= */
function draw() {
  ctx.clearRect(0, 0, P.cssW, P.cssH);
  drawStands();
  drawPitch();

  // Сортировка по глубине: дальние (большой z) рисуем раньше
  const order = [];
  for (const p of players) order.push({ z: p.z, p });
  order.push({ z: ball.z, ball: true });
  order.sort((a, b) => b.z - a.z);
  for (const o of order) { if (o.ball) drawBall(); else drawPerson(o.p); }

  if (celebrate > 0) drawGoalFlash();
}

function drawStands() {
  const g = ctx.createLinearGradient(0, 0, 0, P.FAR_Y + 30);
  g.addColorStop(0, "#10141c");
  g.addColorStop(1, "#1b2230");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, P.cssW, P.FAR_Y + 24);
  // Трибуны: ряды точек-«зрителей»
  ctx.save();
  for (let row = 0; row < 4; row++) {
    const y = P.FAR_Y - 6 - row * 9;
    if (y < 4) break;
    for (let x = 8; x < P.cssW - 4; x += 9) {
      const c = nrand(row * 97.3 + x * 1.7);
      ctx.fillStyle = c > 0.66 ? "#3a4457" : c > 0.33 ? "#4a5568" : "#5a6478";
      ctx.fillRect(x, y, 5, 5);
    }
  }
  ctx.restore();
}

function fieldPoly(x0, x1, z0, z1) {
  const a = project(x0, z0, 0), b = project(x1, z0, 0);
  const c = project(x1, z1, 0), d = project(x0, z1, 0);
  ctx.beginPath();
  ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
  ctx.lineTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy);
  ctx.closePath();
}

function lineWorld(x0, z0, x1, z1) {
  const a = project(x0, z0, 0), b = project(x1, z1, 0);
  ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
}

function ellipseWorld(cx, cz, rx, rz) {
  ctx.beginPath();
  const N = 28;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const pt = project(cx + Math.cos(a) * rx, cz + Math.sin(a) * rz, 0);
    if (i === 0) ctx.moveTo(pt.sx, pt.sy); else ctx.lineTo(pt.sx, pt.sy);
  }
  ctx.stroke();
}

function drawPitch() {
  // Газон с полосами (полосы поперёк поля — вдоль оси x)
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    const x0 = (i / stripes) * PITCH_L, x1 = ((i + 1) / stripes) * PITCH_L;
    fieldPoly(x0, x1, 0, PITCH_W);
    ctx.fillStyle = i % 2 ? "#0a6c35" : "#0b7a3b";
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 2;

  // Границы поля
  fieldPoly(0, PITCH_L, 0, PITCH_W); ctx.stroke();
  // Средняя линия + центральный круг
  lineWorld(PITCH_L / 2, 0, PITCH_L / 2, PITCH_W);
  ellipseWorld(PITCH_L / 2, PITCH_W / 2, 96, 84);

  // Штрафные площади
  const boxD = 170, boxHalf = 210;
  fieldPoly(0, boxD, PITCH_W / 2 - boxHalf, PITCH_W / 2 + boxHalf); ctx.stroke();
  fieldPoly(PITCH_L - boxD, PITCH_L, PITCH_W / 2 - boxHalf, PITCH_W / 2 + boxHalf); ctx.stroke();

  // Ворота
  drawGoal(0, 1);
  drawGoal(PITCH_L, -1);
}

function drawGoal(gx, dir) {
  // Стойки в точках z = MOUTH_LO и MOUTH_HI, перекладина сверху.
  const postH = 96; // мировая высота ворот (визуально)
  const near = project(gx, MOUTH_LO, 0);
  const far = project(gx, MOUTH_HI, 0);
  const nearTop = project(gx, MOUTH_LO, postH);
  const farTop = project(gx, MOUTH_HI, postH);

  // Сетка
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  const N = 5;
  for (let i = 1; i < N; i++) {
    const zz = MOUTH_LO + (MOUTH_HI - MOUTH_LO) * (i / N);
    const b = project(gx, zz, 0), t = project(gx, zz, postH);
    const bb = project(gx + dir * 26, zz, 0), tt = project(gx + dir * 26, zz, postH * 0.85);
    ctx.beginPath(); ctx.moveTo(t.sx, t.sy); ctx.lineTo(tt.sx, tt.sy); ctx.lineTo(bb.sx, bb.sy); ctx.stroke();
  }
  for (let i = 0; i <= 3; i++) {
    const hh = postH * (i / 3);
    const a = project(gx + dir * 26, MOUTH_LO, hh * 0.85), b = project(gx + dir * 26, MOUTH_HI, hh * 0.85);
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
  }

  // Каркас
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(near.sx, near.sy); ctx.lineTo(nearTop.sx, nearTop.sy);
  ctx.lineTo(farTop.sx, farTop.sy); ctx.lineTo(far.sx, far.sy);
  ctx.stroke();
}

function teamColors(p) {
  if (p.isGK) {
    return p.team === 0
      ? { shirt: "#2fbf71", shorts: "#186b3f", socks: "#2fbf71" }
      : { shirt: "#ffcf40", shorts: "#8a6a00", socks: "#ffcf40" };
  }
  return p.team === 0
    ? { shirt: "#2f7bff", shorts: "#ffffff", socks: "#2f7bff" }
    : { shirt: "#e8443c", shorts: "#20232b", socks: "#e8443c" };
}

function drawPerson(p) {
  const { sx, sy, scale } = project(p.x, p.z, 0);
  const bh = 46 * scale;
  const spd = hyp(p.vx, p.vz);
  const moving = spd > 14;
  const swing = moving ? Math.sin(p.runPhase) : 0;
  const col = teamColors(p);

  // Тень
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(sx, sy, 13 * scale, 5 * scale, 0, 0, Math.PI * 2); ctx.fill();

  // Подсветка активного игрока
  if (p === active && state === "playing") {
    ctx.strokeStyle = "#ffe14d";
    ctx.lineWidth = 3 * scale;
    ctx.beginPath(); ctx.ellipse(sx, sy, 16 * scale, 6.5 * scale, 0, 0, Math.PI * 2); ctx.stroke();
    // стрелка над головой
    ctx.fillStyle = "#ffe14d";
    const ay = sy - bh - 10 * scale;
    ctx.beginPath();
    ctx.moveTo(sx, ay + 8 * scale);
    ctx.lineTo(sx - 6 * scale, ay);
    ctx.lineTo(sx + 6 * scale, ay);
    ctx.closePath(); ctx.fill();
  }

  const hipY = sy - bh * 0.42;
  const shoulderY = sy - bh * 0.80;
  const headR = bh * 0.11;
  const legSpread = swing * bh * 0.16;
  const armSpread = swing * bh * 0.12;

  ctx.lineCap = "round";
  // Ноги
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 4.5 * scale;
  ctx.beginPath(); ctx.moveTo(sx, hipY); ctx.lineTo(sx - bh * 0.09 + legSpread, sy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx, hipY); ctx.lineTo(sx + bh * 0.09 - legSpread, sy); ctx.stroke();
  // Гетры
  ctx.strokeStyle = col.socks;
  ctx.lineWidth = 4.5 * scale;
  ctx.beginPath(); ctx.moveTo(sx - bh * 0.09 + legSpread, sy - bh * 0.12); ctx.lineTo(sx - bh * 0.09 + legSpread, sy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx + bh * 0.09 - legSpread, sy - bh * 0.12); ctx.lineTo(sx + bh * 0.09 - legSpread, sy); ctx.stroke();
  // Шорты
  ctx.fillStyle = col.shorts;
  ctx.fillRect(sx - bh * 0.15, hipY - bh * 0.04, bh * 0.30, bh * 0.16);
  // Руки
  ctx.strokeStyle = "#e8b48c";
  ctx.lineWidth = 3.6 * scale;
  ctx.beginPath(); ctx.moveTo(sx - bh * 0.14, shoulderY + bh * 0.05); ctx.lineTo(sx - bh * 0.20 - armSpread, hipY + bh * 0.02); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx + bh * 0.14, shoulderY + bh * 0.05); ctx.lineTo(sx + bh * 0.20 + armSpread, hipY + bh * 0.02); ctx.stroke();
  // Торс (футболка)
  ctx.fillStyle = col.shirt;
  roundRect(sx - bh * 0.17, shoulderY, bh * 0.34, hipY - shoulderY + bh * 0.05, bh * 0.08);
  ctx.fill();
  // Голова
  ctx.fillStyle = "#e8b48c";
  ctx.beginPath(); ctx.arc(sx, shoulderY - headR * 0.6, headR, 0, Math.PI * 2); ctx.fill();
}

function drawBall() {
  const { sx, sy, scale } = project(ball.x, ball.z, 0);
  const lift = ball.h * 0.7 * scale;
  // Тень (меньше и бледнее при высоком мяче)
  const shrink = Math.min(0.6, ball.h * 0.003);
  ctx.fillStyle = `rgba(0,0,0,${0.28 - shrink * 0.3})`;
  ctx.beginPath();
  ctx.ellipse(sx, sy, (7 - shrink * 3) * scale, (3.4 - shrink * 1.5) * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  // Мяч
  const r = 6.8 * scale;
  const by = sy - lift;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(sx, by, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(sx, by, r * 0.34, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(sx, by, r, 0, Math.PI * 2); ctx.stroke();
}

function drawGoalFlash() {
  ctx.globalAlpha = Math.min(0.5, celebrate * 0.45);
  ctx.fillStyle = lastGoal === "you" ? "#ffe14d" : "#ff8f6b";
  ctx.fillRect(0, 0, P.cssW, P.cssH);
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#06371c";
  ctx.font = `bold ${Math.round(P.cssW * 0.13)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("ГОЛ!", P.cssW / 2, P.cssH * 0.4);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* =========================================================================
   Потоки: меню / матч / итог
   ========================================================================= */
function startMatch() {
  scoreYou = 0; scoreCpu = 0; timeLeft = MATCH_SECONDS; celebrate = 0; F = 0;
  el.scoreYou.textContent = "0";
  el.scoreCpu.textContent = "0";
  kickoffReset(0);
  active = null;
  state = "playing";
  el.overlay.classList.remove("show");
  document.body.classList.add("playing");
}

function endMatch() {
  state = "over";
  document.body.classList.remove("playing");
  resetCharge();
  pad.sprint = false;
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

if (!window.matchMedia("(display-mode: standalone)").matches) {
  el.installHint.hidden = false;
}

resize();
// повторный расчёт после того, как layout устоялся
setTimeout(resize, 60);
requestAnimationFrame(frame);

// ---- Service worker ----
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
