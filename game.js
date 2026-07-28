"use strict";

/* =========================================================================
   Футбол 11 на 11 — 3D (Three.js), альбомная ориентация.
   Этот файл — только СИМУЛЯЦИЯ (мир, физика, ИИ, ввод) в мировых координатах
   (x вдоль поля от ворот к воротам, z — ширина от ближней бровки к дальней,
   h — высота мяча). Весь рендер — в scene.js (window.Scene3D).
   ========================================================================= */

// ---- Мир ----
const PITCH_L = 2400;     // длина поля (ось x) — увеличено вдвое
const PITCH_W = 1800;     // ширина/глубина (ось z) — увеличено вдвое
const GOAL_HALF = 140;    // половина ширины створа ворот (по z) — прежнего размера
const VIS_NEAR = 900;     // диапазон панорамирования камеры по длине (мировые единицы)
const GOAL_DEPTH_H = 105; // макс. высота мяча для гола (~высота перекладины); выше — мимо
const PLR_R = 15;         // радиус игрока (мир)
const BALL_R = 8;

const MOUTH_LO = PITCH_W / 2 - GOAL_HALF;
const MOUTH_HI = PITCH_W / 2 + GOAL_HALF;

// ---- Тюнинг ----
const MATCH_SECONDS = 120;
const SPEED = 106;        // базовая скорость бега (мир/сек) — игроки бегают медленно
const SPRINT = 150;       // скорость со спринтом
const GK_SPEED = 94;
const ACCEL = 1700;       // ускорение большое => резкий отклик (реакция), бег остаётся медленным
const CTRL_R = 27;        // радиус получения контроля над мячом
const TACKLE_R = 28;      // радиус отбора (ИИ, автоматический)
const TACKLE_STEAL_R = 46;// радиус ручного отбора по кнопке «Пас»
const STEAL_RATE = 2.2;   // вероятность отбора в секунду при контакте
const DRIBBLE_AHEAD = 24; // насколько мяч выносится вперёд при ведении
// Сила паса/удара зависит от заряда шкалы усилия (min при коротком тапе, max при полном).
const PASS_MIN = 300, PASS_MAX = 820;
const SHOT_MIN = 480, SHOT_MAX = 940;
// Подброс удара растёт с зарядом как f² — почти весь диапазон это резкий низкий удар,
// и только у самого максимума мяч перелетает перекладину.
const SHOT_MIN_LOFT = 20, SHOT_MAX_LOFT = 470;
// Навес (пас с подъёмом): дальность ≈ speed · (2·loft/GRAV) − потери на трении.
// При выбранном партнёре скорость дополнительно урезается, чтобы не перебросить.
const LOB_MIN_SPEED = 240, LOB_MAX_SPEED = 700;
const LOB_MIN_LOFT = 190, LOB_MAX_LOFT = 560;
const CHARGE_TIME = 0.8;  // сек до полного заряда
const CHARGE_MIN = 0.32;  // доля силы при мгновенном тапе
const GRAV = 680;         // гравитация (меньше => мяч дольше в полёте, легче)
const BOUNCE = 0.5;

const canvas = document.getElementById("pitch");
let camX = PITCH_L / 2; // центр камеры по длине поля (едет за мячом)
let camZ = PITCH_W / 2; // фокус камеры по ширине (мягко следует за мячом)

function resize() { if (window.Scene3D) Scene3D.resize(); }
window.addEventListener("resize", resize);

// Допустимый диапазон камеры: у ближней бровки не выходим за пределы поля.
function camClamp(x) {
  const half = VIS_NEAR / 2;
  return clamp(x, half, PITCH_L - half);
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

const ball = { x: PITCH_L / 2, z: PITCH_W / 2, h: 0, vx: 0, vz: 0, vh: 0, owner: null, cooldown: 0, lastTeam: 0 };

// ---- Состояние матча ----
let state = "menu";        // menu | playing | over
let scoreYou = 0, scoreCpu = 0;
let timeLeft = MATCH_SECONDS;
let celebrate = 0;
let lastGoal = null;
let restartMsg = "", restartMsgT = 0; // подпись типа возобновления игры
// Режим: 'ai' — соперник под управлением ИИ (как было); 'host' — мы считаем
// матч и принимаем ввод соперника; 'guest' — матч считает соперник, мы шлём
// ввод и рисуем присланное состояние.
let netMode = "ai";
let myTeam = 0;            // за какую команду играю я (гость играет за 1)
const activeOf = [null, null]; // активный игрок каждой команды
let active = null;         // активный игрок МОЕЙ команды (= activeOf[myTeam])
// Ввод соперника по сети (используется хостом)
const remote = { vec: { x: 0, z: 0 }, sprint: false, queue: [] };
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
  cineBig: document.getElementById("cineBig"),
  cineSub: document.getElementById("cineSub"),
  flash: document.getElementById("flash"),
  settingsBtn: document.getElementById("settingsBtn"),
  settings: document.getElementById("settings"),
  angleRange: document.getElementById("angleRange"),
  heightRange: document.getElementById("heightRange"),
  angleVal: document.getElementById("angleVal"),
  heightVal: document.getElementById("heightVal"),
  settingsClose: document.getElementById("settingsClose"),
  settingsReset: document.getElementById("settingsReset"),
  netBtn: document.getElementById("netBtn"),
  netPanel: document.getElementById("netPanel"),
  netCodeInput: document.getElementById("netCodeInput"),
  netLocal: document.getElementById("netLocal"),
  netStatus: document.getElementById("netStatus"),
  netGo: document.getElementById("netGo"),
  netStart: document.getElementById("netStart"),
  netCancel: document.getElementById("netCancel"),
  netCopy: document.getElementById("netCopy"),
  netLog: document.getElementById("netLog"),
};

/* =========================================================================
   Настройки камеры (угол/высота) — панель с ползунками, сохраняются локально
   ========================================================================= */
const CAM_DEFAULTS = { angle: 40, height: 10 };
let paused = false;

function applyCamSettings(s, save) {
  Scene3D.setCamera(s);
  const cur = Scene3D.getCamera();
  if (el.angleRange) el.angleRange.value = cur.angle;
  if (el.heightRange) el.heightRange.value = cur.height;
  if (el.angleVal) el.angleVal.textContent = Math.round(cur.angle) + "°";
  if (el.heightVal) el.heightVal.textContent = cur.height;
  if (save) {
    try { localStorage.setItem("cam", JSON.stringify(cur)); } catch (_) {}
  }
}

function loadCamSettings() {
  let s = CAM_DEFAULTS;
  try {
    const raw = localStorage.getItem("cam");
    if (raw) { const p = JSON.parse(raw); if (p && p.angle != null) s = p; }
  } catch (_) {}
  applyCamSettings(s, false);
}

function openSettings() {
  if (!el.settings) return;
  paused = true;
  resetCharge();
  pad.sprint = false;
  stickReset();
  keyHeld.clear();
  el.settings.hidden = false;
}
function closeSettings() {
  if (!el.settings) return;
  el.settings.hidden = true;
  paused = false;
}

if (el.settingsBtn) el.settingsBtn.addEventListener("click", openSettings);
if (el.settingsClose) el.settingsClose.addEventListener("click", closeSettings);
if (el.settingsReset) el.settingsReset.addEventListener("click", () => applyCamSettings(CAM_DEFAULTS, true));
if (el.angleRange) el.angleRange.addEventListener("input", () => applyCamSettings({ angle: +el.angleRange.value }, true));
if (el.heightRange) el.heightRange.addEventListener("input", () => applyCamSettings({ height: +el.heightRange.value }, true));

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
  barFillEl.style.background =
    action === "shoot" ? "#ff5a4d" : action === "lob" ? "#40c86a" : "#4a90ff";
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
function beginLob() {
  if (state !== "playing") return;
  if (active && ball.owner === active) { charge.action = "lob"; charge.t = 0; }
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
      else if (name === "lob") beginLob();
      else if (name === "switch") { if (state === "playing") actionQueue.push("switch"); }
      else pad[name] = true; // sprint
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    };
    const release = (e) => {
      btn.classList.remove("pressed");
      if (name === "pass") releaseCharge("pass");
      else if (name === "shoot") releaseCharge("shoot");
      else if (name === "lob") releaseCharge("lob");
      else if (name !== "switch") pad[name] = false;
    };
    btn.addEventListener("pointerdown", press);
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
    btn.addEventListener("pointerleave", release);
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

// Клавиатура (ПК): стрелки — движение, D — удар, S — пас/отбор,
// Пробел — смена игрока, Shift — ускорение.
const keyHeld = new Set();
const MOVE_KEYS = ["arrowup", "arrowdown", "arrowleft", "arrowright"];
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.includes(k) || k === " " || k === "shift" || k === "s" || k === "d" || k === "a") e.preventDefault();
  if (keyHeld.has(k)) return; // без автоповтора
  keyHeld.add(k);
  if (state === "playing") {
    if (k === "s") beginPass();
    if (k === "d") beginShoot();
    if (k === "a") beginLob();
    if (k === " ") actionQueue.push("switch");
  }
});
window.addEventListener("keyup", (e) => {
  const k = e.key.toLowerCase();
  keyHeld.delete(k);
  if (k === "s") releaseCharge("pass");
  if (k === "d") releaseCharge("shoot");
  if (k === "a") releaseCharge("lob");
});

function inputVector() {
  // Клавиатура (только стрелки, полная скорость).
  // Камера смотрит вдоль -x, поэтому экранная «право/лево» = мировая -x/+x.
  let dx = 0, dz = 0;
  if (keyHeld.has("arrowleft")) dx += 1;   // влево на экране = +x в мире
  if (keyHeld.has("arrowright")) dx -= 1;  // вправо на экране = -x в мире
  if (keyHeld.has("arrowup")) dz += 1;     // вверх по экрану = дальняя сторона
  if (keyHeld.has("arrowdown")) dz -= 1;
  if (dx || dz) { const m = hyp(dx, dz); return { x: dx / m, z: dz / m }; }
  // Джойстик (аналогово: модуль вектора = сила нажатия)
  if (stick.active) {
    const mag = hyp(stick.jx, stick.jy);
    if (mag > 0.14) return { x: -stick.jx, z: -stick.jy };
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
  if (ball.owner) ball.lastTeam = ball.owner.team; // кто последним коснулся
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
  const loft = SHOT_MIN_LOFT + f * f * (SHOT_MAX_LOFT - SHOT_MIN_LOFT);
  kick(speed, dx / d, dz / d, loft);
}

// Общее направление передачи — используется и пасом, и навесом, чтобы они
// вели себя одинаково. Возвращает единичный вектор, партнёра-цель и дистанцию.
function passDirection(p) {
  const attackDir = p.team === 0 ? 1 : -1;

  // Прицел. У активного игрока — джойстик/клавиши (куда целишься),
  // иначе (в т.ч. ИИ) — куда смотрит игрок, в крайнем случае вперёд к воротам.
  let aimx = 0, aimz = 0;
  {
    const iv = inputVectorFor(p);   // джойстик того, кто управляет этим игроком
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

  // Никого в секторе прицела — передача в направлении прицела (в свободную зону).
  if (!best) return { x: aimx, z: aimz, target: null, dist: 0 };
  const lx = best.x + aimx * 18, lz = best.z + aimz * 18; // небольшой вынос под ход
  const dx = lx - p.x, dz = lz - p.z, d = hyp(dx, dz) || 1;
  return { x: dx / d, z: dz / d, target: best, dist: d };
}

function doPass(p, f) {
  if (!p || ball.owner !== p) return;
  if (f == null) f = 0.7;
  const dir = passDirection(p);
  kick(PASS_MIN + f * (PASS_MAX - PASS_MIN), dir.x, dir.z, 0);
}

// Навес: пас с подъёмом мяча от земли. Направление — как у паса (по прицелу/
// партнёру), сила и высота растут с зарядом f.
function doLob(p, f) {
  if (!p || ball.owner !== p) return;
  if (f == null) f = 0.7;
  const dir = passDirection(p);            // направление — как у обычного паса
  let speed = LOB_MIN_SPEED + f * (LOB_MAX_SPEED - LOB_MIN_SPEED);
  const loft = LOB_MIN_LOFT + f * (LOB_MAX_LOFT - LOB_MIN_LOFT);
  // Если целимся в партнёра — не перебрасываем его: время полёта 2·loft/GRAV,
  // значит нужная скорость ≈ дистанция / время (+ поправка на трение воздуха).
  if (dir.target) {
    const flight = 2 * loft / GRAV;
    speed = Math.min(speed, (dir.dist / flight) * 1.12);
  }
  kick(speed, dir.x, dir.z, loft);
}

// Отбор/перехват: рывок к мячу и захват при сближении.
function doTackle(p) {
  if (!p || ball.owner === p) return;
  const dx = ball.x - p.x, dz = ball.z - p.z, d = hyp(dx, dz) || 1;
  p.vx += dx / d * 90; p.vz += dz / d * 90; // рывок делает отбор отзывчивым
  if (d < TACKLE_STEAL_R) {
    if (ball.owner && ball.owner.team !== p.team) {
      ball.owner = p; ball.lastTeam = p.team; ball.cooldown = 0.05; // отбор у соперника
    } else if (!ball.owner) {
      ball.owner = p; ball.lastTeam = p.team; ball.cooldown = 0;     // перехват свободного мяча
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
    const fr = Math.exp(-1.05 * dt); // трение о газон (мяч катится дальше на большом поле)
    ball.vx *= fr; ball.vz *= fr;
  } else {
    const fr = Math.exp(-0.14 * dt); // почти нет сопротивления в полёте => навес несётся дальше
    ball.vx *= fr; ball.vz *= fr;
  }
  const sp = hyp(ball.vx, ball.vz);
  if (sp < 4 && ball.h === 0) { ball.vx = 0; ball.vz = 0; }

  // Лицевые линии: гол, либо аут за линию ворот (удар от ворот / угловой)
  if (ball.x <= 0) {
    if (ball.z > MOUTH_LO && ball.z < MOUTH_HI && ball.h < GOAL_DEPTH_H) { scoreGoal("cpu"); return; }
    goalLineOut(0); return;
  } else if (ball.x >= PITCH_L) {
    if (ball.z > MOUTH_LO && ball.z < MOUTH_HI && ball.h < GOAL_DEPTH_H) { scoreGoal("you"); return; }
    goalLineOut(PITCH_L); return;
  }
  // Боковые линии: аут => вброс
  if (ball.z <= 0 || ball.z >= PITCH_W) { throwInOut(); return; }

  if (ball.cooldown > 0) ball.cooldown -= dt;
}

/* =========================================================================
   Ауты: вброс из-за боковой, удар от ворот, угловой
   ========================================================================= */
function nearestFieldOfTeam(team, x, z) {
  let best = null, bd = 1e9;
  for (const p of players) {
    if (p.team !== team || p.isGK) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// Поставить мяч и игрока на точку возобновления, отдать владение.
function placeRestart(player, x, z) {
  if (!player) return;
  const attackDir = player.team === 0 ? 1 : -1;
  player.x = clamp(x, PLR_R, PITCH_L - PLR_R);
  player.z = clamp(z, PLR_R, PITCH_W - PLR_R);
  player.vx = 0; player.vz = 0; player.dirx = attackDir; player.dirz = 0;
  ball.x = player.x; ball.z = player.z; ball.h = 0;
  ball.vx = 0; ball.vz = 0; ball.vh = 0;
  ball.owner = player; ball.lastTeam = player.team; ball.cooldown = 0.35;
  camX = camClamp(player.x);
  camZ = clamp(player.z, PITCH_W * 0.05, PITCH_W * 0.95);
}

function throwInOut() {
  const side = ball.z <= 0 ? 0 : PITCH_W;         // какая бровка
  const x = clamp(ball.x, 60, PITCH_L - 60);
  const team = ball.lastTeam === 0 ? 1 : 0;        // вбрасывает соперник
  const p = nearestFieldOfTeam(team, x, side);
  placeRestart(p, x, side);
  restartMsg = "Вброс"; restartMsgT = 1.4; restartCode = 1;
}

function goalLineOut(goalX) {
  // Ворота x=0 атакует team1 (бьёт влево); x=PITCH_L атакует team0.
  const attackTeam = goalX === 0 ? 1 : 0;
  const defendTeam = attackTeam === 0 ? 1 : 0;
  if (ball.lastTeam === attackTeam) {
    // Атакующие выбили за линию => удар от ворот защищающимся вратарём.
    const dir = goalX === 0 ? 1 : -1;
    const gk = players.find((p) => p.team === defendTeam && p.isGK);
    placeRestart(gk, goalX + dir * 120, PITCH_W / 2);
    restartMsg = "Удар от ворот"; restartMsgT = 1.4; restartCode = 2;
  } else {
    // Защищающиеся выбили => угловой атакующим.
    const cz = ball.z < PITCH_W / 2 ? 30 : PITCH_W - 30;
    const p = nearestFieldOfTeam(attackTeam, goalX, cz);
    placeRestart(p, goalX + (goalX === 0 ? 20 : -20), cz);
    restartMsg = "Угловой"; restartMsgT = 1.4; restartCode = 3;
  }
}

function resolvePossession(dt) {
  if (ball.owner) {
    // Попытки отбора соперниками
    const owner = ball.owner;
    for (const o of players) {
      if (o.team === owner.team) continue;
      if (dist(o, owner) < TACKLE_R) {
        if (nrand(F * 1.7 + o.id * 3.1) < STEAL_RATE * dt) {
          ball.owner = o; ball.lastTeam = o.team; ball.cooldown = 0.05;
          break;
        }
      }
    }
  } else if (ball.cooldown <= 0 && ball.h < 24) {
    // Свободный мяч у земли — ближайший в радиусе получает контроль
    // (высоко летящий навес не «ловится» из-под ног).
    let best = null, bd = CTRL_R;
    for (const p of players) {
      const d = dist(p, ball);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { ball.owner = best; ball.lastTeam = best.team; }
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
  const central = Math.abs(p.z - PITCH_W / 2) < 340;
  const pressured = anyOpponentWithin(p, 48);

  if (distGoal < 520 && central) { doShoot(p, 0.7); return; }
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
    const tx = ownGoalX + attackDir * 40;
    const tz = clamp(ball.z, MOUTH_LO + 8, MOUTH_HI - 8);
    // выходит чуть вперёд, если мяч близко к воротам
    const rush = Math.abs(ball.x - ownGoalX) < 320 ? attackDir * 70 : 0;
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

const manualHoldOf = [0, 0]; // сек, в течение которых уважаем ручной выбор

// Команда управляется человеком? В режиме с ИИ — только наша.
function isHumanTeam(team) {
  return netMode === "ai" ? team === myTeam : true;
}

function pickActiveFor(team) {
  const cur = activeOf[team];
  // Владеем мячом — управляем владельцем всегда.
  if (ball.owner && ball.owner.team === team) {
    activeOf[team] = ball.owner; manualHoldOf[team] = 0; return;
  }
  const [n] = nearestFieldToBall(team);
  if (!cur || cur.isGK || cur.team !== team) { activeOf[team] = n; return; }
  // Игрок вручную выбрал игрока — не перехватываем управление автоматически.
  if (manualHoldOf[team] > 0) return;
  if (n && n !== cur && dist(n, ball) + 14 < dist(cur, ball)) activeOf[team] = n;
  if (!activeOf[team]) activeOf[team] = n;
}

// Ручная смена управляемого игрока (кнопка «Смена»).
function cycleActiveFor(team) {
  if (ball.owner && ball.owner.team === team) return; // владеем — смена не нужна
  const field = players.filter((p) => p.team === team && !p.isGK);
  field.sort((a, b) => dist(a, ball) - dist(b, ball));
  if (!field.length) return;
  const idx = field.indexOf(activeOf[team]);
  activeOf[team] = field[(idx + 1) % field.length];
  manualHoldOf[team] = 1.6;
}

// Ввод, управляющий этим игроком: мой джойстик или присланный соперником.
function inputVectorFor(p) {
  if (p && p === activeOf[myTeam]) return inputVector();
  if (netMode === "host" && p && p === activeOf[1 - myTeam]) return remote.vec;
  return { x: 0, z: 0 };
}
function sprintFor(p) {
  if (p && p === activeOf[myTeam]) return sprintHeld();
  if (netMode === "host" && p && p === activeOf[1 - myTeam]) return remote.sprint;
  return false;
}

function userMove(p, dt) {
  const v = inputVectorFor(p);
  const speed = sprintFor(p) ? SPRINT : SPEED;
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
  ball.lastTeam = kickTeam;
  // Начинающая команда получает мяч: ставим её нападающего в центр
  const fwd = players.find((p) => p.team === kickTeam && !p.isGK && p.home.x === (kickTeam === 0 ? 0.66 * PITCH_L : (1 - 0.66) * PITCH_L));
  const starter = fwd || players.find((p) => p.team === kickTeam && !p.isGK);
  if (starter) { starter.x = PITCH_L / 2; starter.z = PITCH_W / 2 + 6; }
  camX = camClamp(PITCH_L / 2); // камера в центр без долгой прокрутки
  camZ = PITCH_W / 2;
  resetCharge();
}

function scoreGoal(who) {
  if (who === "you") scoreYou++; else scoreCpu++;
  updateScoreHud();
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

  if (paused) {
    dt = 0; // сцена рисуется, но матч стоит, пока открыты настройки
  } else if (netMode === "guest") {
    guestFrame(dt); // гость физику не считает — только шлёт ввод и рисует
  } else if (state === "playing") {
    F++;
    timeLeft -= dt;
    if (celebrate > 0) celebrate -= dt;
    if (timeLeft <= 0) { timeLeft = 0; endMatch(); }
    else step(dt);
  } else if (state === "intro") {
    stepIntro(dt);
  } else if (celebrate > 0) {
    celebrate -= dt;
  }

  draw(dt);
  requestAnimationFrame(frame);
}

// Применить действие (пас/удар/навес/отбор/смена) к активному игроку команды.
function applyAction(a, team) {
  const p = activeOf[team];
  if (a === "switch" || a.type === "switch") { cycleActiveFor(team); return; }
  if (a.type === "tackle") doTackle(p);
  else if (a.type === "pass") doPass(p, a.power);
  else if (a.type === "lob") doLob(p, a.power);
  else if (a.type === "shoot") doShoot(p, a.power);
}

function step(dt) {
  if (manualHoldOf[0] > 0) manualHoldOf[0] -= dt;
  if (manualHoldOf[1] > 0) manualHoldOf[1] -= dt;
  if (restartMsgT > 0) restartMsgT -= dt;

  // Кого прессинговать
  const n0 = nearestFieldToBall(0), n1 = nearestFieldToBall(1);
  chaser[0] = n0[0]; chaser2[0] = n0[1];
  chaser[1] = n1[0]; chaser2[1] = n1[1];

  pickActiveFor(myTeam);
  if (netMode !== "ai") pickActiveFor(1 - myTeam);
  active = activeOf[myTeam];

  // Накопление заряда усилия, пока держим ПАС/УДАР.
  if (charge.action) {
    // Если по какой-то причине потеряли мяч во время заряда — отменяем.
    if (!active || ball.owner !== active) resetCharge();
    else {
      charge.t = Math.min(CHARGE_TIME, charge.t + dt);
      showPowerBar(charge.action, charge.t / CHARGE_TIME);
    }
  }

  // Мои действия
  while (actionQueue.length) applyAction(actionQueue.shift(), myTeam);
  // Действия соперника, пришедшие по сети (только у хоста)
  if (netMode === "host") {
    while (remote.queue.length) applyAction(remote.queue.shift(), 1 - myTeam);
  }

  // Ход всех игроков
  for (const p of players) {
    if (p === activeOf[0] && isHumanTeam(0)) userMove(p, dt);
    else if (p === activeOf[1] && isHumanTeam(1)) userMove(p, dt);
    else if (ball.owner === p) aiWithBall(p, dt);
    else aiControl(p, dt);
  }

  // Мяч
  if (!ball.owner) updateFreeBall(dt);
  resolvePossession(dt);
  if (ball.owner) glueBall();

  separatePlayers();

  followCamera(dt);
  updateClock();
  if (netMode === "host") maybeSendSnapshot(dt);
}

// Камера едет за мячом по длине поля (плавно) и мягко следит по ширине.
// Вызывается и хостом, и гостем — гость ведёт её по присланному мячу.
function followCamera(dt) {
  const target = camClamp(ball.x);
  camX += (target - camX) * Math.min(1, 2.6 * dt);
  // Камера доезжает почти до бровок — тогда за линией виден кусок газона.
  const tz = clamp(ball.z, PITCH_W * 0.05, PITCH_W * 0.95);
  camZ += (tz - camZ) * Math.min(1, 2.0 * dt);
}

function updateClock() {
  const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
  el.clock.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* =========================================================================
   Сеть: хост шлёт снимки состояния, гость шлёт ввод и рисует присланное
   ========================================================================= */
const SNAP_HZ = 20, INPUT_HZ = 30;
let snapAcc = 0, inputAcc = 0;
const RESTART_TEXT = ["", "Вброс", "Удар от ворот", "Угловой"];
let restartCode = 0;
const STATES = ["menu", "intro", "playing", "over"];

function r1(v) { return Math.round(v * 10) / 10; }

function maybeSendSnapshot(dt) {
  snapAcc += dt;
  if (snapAcc < 1 / SNAP_HZ) return;
  snapAcc = 0;
  const a = [
    STATES.indexOf(state), scoreYou, scoreCpu, r1(timeLeft),
    r1(ball.x), r1(ball.z), r1(ball.h),
    ball.owner ? ball.owner.id : -1,
    activeOf[0] ? activeOf[0].id : -1,
    activeOf[1] ? activeOf[1].id : -1,
    r1(celebrate), lastGoal === "you" ? 0 : 1,
    restartMsgT > 0 ? restartCode : 0,
    r1(introT),
  ];
  for (const p of players) { a.push(r1(p.x), r1(p.z)); }
  Net.send({ t: "s", a });
}

function applySnapshot(a) {
  const st = STATES[a[0]] || "playing";
  if (st !== state) setStateFromNet(st);
  scoreYou = a[1]; scoreCpu = a[2]; timeLeft = a[3];
  ball.tx = a[4]; ball.tz = a[5]; ball.h = a[6];
  ball.owner = a[7] >= 0 ? players[a[7]] : null;
  activeOf[0] = a[8] >= 0 ? players[a[8]] : null;
  activeOf[1] = a[9] >= 0 ? players[a[9]] : null;
  active = activeOf[myTeam];
  celebrate = a[10];
  lastGoal = a[11] === 0 ? "you" : "cpu";
  const rc = a[12];
  if (rc > 0) { restartMsg = RESTART_TEXT[rc]; restartMsgT = 1.0; }
  introT = a[13];
  let k = 14;
  for (const p of players) { p.tx = a[k++]; p.tz = a[k++]; }
  updateScoreHud();
}

// Гость не считает физику: он подтягивает позиции к присланным и по разнице
// вычисляет скорость, чтобы работала анимация бега.
function smoothToTargets(dt) {
  const k = Math.min(1, 14 * dt);
  for (const p of players) {
    if (p.tx == null) continue;
    const ox = p.x, oz = p.z;
    p.x += (p.tx - p.x) * k;
    p.z += (p.tz - p.z) * k;
    p.vx = dt > 0 ? (p.x - ox) / dt : 0;
    p.vz = dt > 0 ? (p.z - oz) / dt : 0;
    const sp = hyp(p.vx, p.vz);
    if (sp > 10) { p.dirx = p.vx / sp; p.dirz = p.vz / sp; p.runPhase += sp * dt * 0.06; }
  }
  if (ball.tx != null) {
    ball.x += (ball.tx - ball.x) * k;
    ball.z += (ball.tz - ball.z) * k;
  }
}

function maybeSendInput(dt) {
  inputAcc += dt;
  if (inputAcc < 1 / INPUT_HZ) return;
  inputAcc = 0;
  const v = inputVector();
  Net.send({ t: "i", v: [Math.round(v.x * 100) / 100, Math.round(v.z * 100) / 100], s: sprintHeld() ? 1 : 0 });
}

function guestFrame(dt) {
  maybeSendInput(dt);
  while (actionQueue.length) {
    const a = actionQueue.shift();
    Net.send({ t: "a", a: a === "switch" ? { type: "switch" } : a });
  }
  // Заряд усилия ведём локально — шкала должна отзываться сразу.
  if (charge.action) {
    if (!active || ball.owner !== active) resetCharge();
    else {
      charge.t = Math.min(CHARGE_TIME, charge.t + dt);
      showPowerBar(charge.action, charge.t / CHARGE_TIME);
    }
  }
  smoothToTargets(dt);
  followCamera(dt);
  if (celebrate > 0) celebrate -= dt;
  if (restartMsgT > 0) restartMsgT -= dt;
  updateClock();
}

function onNetMessage(m) {
  if (!m) return;
  if (m.t === "s" && netMode === "guest") applySnapshot(m.a);
  else if (m.t === "i" && netMode === "host") {
    remote.vec = { x: m.v[0], z: m.v[1] }; remote.sprint = !!m.s;
  } else if (m.t === "a" && netMode === "host") {
    remote.queue.push(m.a);
  } else if (m.t === "start" && netMode === "guest") {
    // Прячем лобби; само состояние матча приедет со снимками.
    el.overlay.classList.remove("show");
    if (el.netPanel) el.netPanel.hidden = true;
  }
}

function setStateFromNet(st) {
  state = st;
  if (st === "playing" || st === "intro") {
    el.overlay.classList.remove("show");
    if (el.netPanel) el.netPanel.hidden = true;
    document.body.classList.toggle("playing", st === "playing");
  } else if (st === "over") {
    document.body.classList.remove("playing");
    showResult();
  }
}

function updateScoreHud() {
  const mine = myTeam === 0 ? scoreYou : scoreCpu;
  const theirs = myTeam === 0 ? scoreCpu : scoreYou;
  el.scoreYou.textContent = mine;
  el.scoreCpu.textContent = theirs;
}

/* =========================================================================
   Отрисовка
   ========================================================================= */
function draw(dt) {
  Scene3D.render({
    players, ball, camX, camZ, active, state,
    introActive: state === "intro" && introT < INTRO_END - 0.1,
  }, dt || 0);
  updateOverlays();
}

// DOM-оверлеи поверх 3D: кинематографичный текст и вспышка гола.
let _lastBig = "";
function updateOverlays() {
  let bigText = "", bigCls = "", subText = "";
  if (state === "intro") {
    if (introT < INTRO_WALK) { subText = "ВЫХОД КОМАНД ⚽ · тап — пропустить"; }
    else if (introT < INTRO_GO_AT) {
      const stp = INTRO_CD / 3;
      bigText = String(Math.max(1, 3 - Math.floor((introT - INTRO_WALK) / stp)));
      bigCls = "cd";
    } else { bigText = "GO!"; bigCls = "go"; }
  } else if (celebrate > 0) {
    bigText = "ГОЛ!"; bigCls = "goal";
  } else if (state === "playing" && restartMsgT > 0) {
    subText = restartMsg;
  }
  if (el.cineBig && bigText !== _lastBig) {
    _lastBig = bigText;
    el.cineBig.textContent = bigText;
    el.cineBig.className = "";
    void el.cineBig.offsetWidth; // рестарт CSS-анимации
    if (bigText) el.cineBig.className = "show " + bigCls;
  }
  if (el.cineSub) {
    el.cineSub.style.opacity = subText ? "1" : "0";
    if (subText) el.cineSub.textContent = subText;
  }
  if (el.flash) {
    if (celebrate > 0) {
      el.flash.style.opacity = String(Math.min(0.5, celebrate * 0.45));
      el.flash.style.background = lastGoal === "you" ? "#ffe14d" : "#ff8f6b";
    } else el.flash.style.opacity = "0";
  }
}

/* =========================================================================
   Заставка перед матчем: выход из тоннеля, салюты, отсчёт, свисток, GO
   ========================================================================= */
const INTRO_WALK = 2.8;                     // выход команд из тоннеля
const INTRO_CD = 1.5;                       // обратный отсчёт 3-2-1
const INTRO_GO_AT = INTRO_WALK + INTRO_CD;  // момент свистка + «GO»
const INTRO_END = INTRO_GO_AT + 0.9;
const tunnel = { x: PITCH_L / 2, z: PITCH_W - 6 };
let introT = 0, introWhistled = false;

// Звук свистка через Web Audio (контекст создаём по жесту — клику «Играть»).
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (_) {}
}
function whistle() {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    [0, 0.24].forEach((off) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(2050, t0 + off);
      o.frequency.setValueAtTime(2320, t0 + off + 0.05);
      o.frequency.setValueAtTime(2050, t0 + off + 0.10);
      g.gain.setValueAtTime(0.0001, t0 + off);
      g.gain.exponentialRampToValueAtTime(0.28, t0 + off + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.20);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0 + off); o.stop(t0 + off + 0.22);
    });
  } catch (_) {}
}

function stepIntro(dt) {
  introT += dt;
  // Выход игроков из тоннеля к своим позициям (со стаггером — по одному).
  if (introT < INTRO_WALK) {
    for (const p of players) {
      const delay = (p.id / players.length) * (INTRO_WALK * 0.35);
      const prog = clamp((introT - delay) / (INTRO_WALK * 0.6), 0, 1);
      const e = prog * prog * (3 - 2 * prog); // smoothstep
      p.x = tunnel.x + (p.home.x - tunnel.x) * e;
      p.z = tunnel.z + (p.home.z - tunnel.z) * e;
      const moving = prog > 0.001 && prog < 0.999;
      p.vx = moving ? 30 : 0; p.vz = 0;
      if (moving) p.runPhase += 7 * dt;
      p.dirx = p.team === 0 ? 1 : -1; p.dirz = 0;
    }
  } else {
    for (const p of players) { p.x = p.home.x; p.z = p.home.z; p.vx = 0; p.vz = 0; }
  }
  camX = camClamp(PITCH_L / 2);
  camZ = PITCH_W / 2;
  // Салюты рисует 3D-сцена (по флагу introActive).

  if (!introWhistled && introT >= INTRO_GO_AT) { introWhistled = true; whistle(); }
  if (introT >= INTRO_END) beginPlay();
}

function beginPlay() {
  kickoffReset(0);            // чистое вбрасывание в центр
  active = null;
  state = "playing";
  document.body.classList.add("playing");
}

// Тап во время заставки — пропустить к свистку.
canvas.addEventListener("pointerdown", () => {
  if (state === "intro" && introT < INTRO_GO_AT) introT = INTRO_GO_AT;
});

/* =========================================================================
   Потоки: меню / матч / итог
   ========================================================================= */
function startMatch() {
  scoreYou = 0; scoreCpu = 0; timeLeft = MATCH_SECONDS; celebrate = 0; F = 0;
  updateScoreHud();
  const mm = Math.floor(MATCH_SECONDS / 60), ss = MATCH_SECONDS % 60;
  el.clock.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  kickoffReset(0);
  active = null; activeOf[0] = activeOf[1] = null;
  remote.queue.length = 0; remote.vec = { x: 0, z: 0 }; remote.sprint = false;
  ensureAudio();
  introT = 0; introWhistled = false;
  state = "intro";
  el.overlay.classList.remove("show");
  if (el.netPanel) el.netPanel.hidden = true;
  document.body.classList.remove("playing"); // геймпад скрыт во время заставки
  if (netMode === "host") Net.send({ t: "start" });
}

function endMatch() {
  state = "over";
  document.body.classList.remove("playing");
  resetCharge();
  pad.sprint = false;
  showResult();
}

function showResult() {
  const mine = myTeam === 0 ? scoreYou : scoreCpu;
  const theirs = myTeam === 0 ? scoreCpu : scoreYou;
  let title;
  if (mine > theirs) title = "Победа! 🏆";
  else if (mine < theirs) title = "Поражение 😔";
  else title = "Ничья 🤝";
  el.overlayText.innerHTML =
    `<b style="font-size:20px">${title}</b><br />Счёт ${mine} : ${theirs}<br /><br />Ещё разок?`;
  el.startBtn.textContent = netMode === "guest" ? "В меню" : "Играть снова";
  el.overlay.classList.add("show");
}

el.startBtn.addEventListener("click", () => {
  // Гость не запускает матч сам — только хост. Гостю кнопка возвращает в меню.
  if (netMode === "guest") { leaveNet(); return; }
  startMatch();
});

/* =========================================================================
   Лобби сетевой игры
   ========================================================================= */
function setMode(mode, team) {
  netMode = mode;
  myTeam = team;
  active = activeOf[myTeam];
  updateScoreHud();
  const label = document.getElementById("teamCpu");
  if (label) label.textContent = mode === "ai" ? "ИИ" : "СОПЕРНИК";
}

function netSay(text) { if (el.netStatus) el.netStatus.textContent = text; }

// Человеческие пояснения к кодам ошибок PeerJS.
function netErrorText(code) {
  if (/network|socket|server-error/i.test(code))
    return "Не удалось связаться с сервером PeerJS. Возможно, его блокирует ваша сеть — попробуйте мобильный интернет вместо Wi-Fi.";
  if (/peer-unavailable/i.test(code))
    return "Хост не найден. Проверьте код или пусть соперник подключится первым.";
  if (/browser-incompatible/i.test(code))
    return "Браузер не поддерживает WebRTC.";
  if (/ssl/i.test(code))
    return "Нужен HTTPS. Откройте игру по https-ссылке.";
  if (/не отвеча|брокер/i.test(code)) return code;
  return "Не удалось подключиться: " + code;
}

function openNetPanel() {
  if (!el.netPanel) return;
  const url = new URL(location.href);
  const fromUrl = (url.searchParams.get("room") || "").toUpperCase();
  el.netCodeInput.value = fromUrl || Net.makeCode();
  el.netPanel.hidden = false;
  el.netGo.hidden = false;
  el.netStart.hidden = true;
  el.netCopy.hidden = true;
  netSay("Оба игрока вводят один код и жмут «Подключиться»");
}

function connectNet() {
  const code = (el.netCodeInput.value || "").trim().toUpperCase();
  if (code.length < 3) { netSay("Код слишком короткий"); return; }
  const transport = el.netLocal && el.netLocal.checked ? "local" : "peerjs";
  el.netGo.hidden = true;
  netSay("Соединение…");

  Net.on("status", netSay);
  Net.on("log", (text) => {
    if (!el.netLog) return;
    el.netLog.hidden = false;
    el.netLog.textContent = text;
    el.netLog.scrollTop = el.netLog.scrollHeight;
  });
  Net.on("message", onNetMessage);
  Net.on("open", () => {
    if (Net.role === "host") {
      netSay("Соперник подключился — можно начинать");
      el.netStart.hidden = false;
    } else {
      netSay("Подключено. Ждём, когда хост начнёт матч");
    }
  });
  Net.on("close", onNetClose);

  Net.connect(code, transport).then((role) => {
    setMode(role, role === "host" ? 0 : 1);
    el.netCopy.hidden = false;
    el.netCopy.dataset.link = location.origin + location.pathname + "?room=" + code;
    if (role === "host") netSay("Вы хост. Ожидание соперника…");
    else netSay("Вы гость. Подключение к хосту…");
  }).catch((err) => {
    netSay(netErrorText((err && err.message) || String(err)));
    el.netGo.hidden = false;
  });
}

function onNetClose() {
  if (netMode === "host") {
    // Соперник отключился — матч продолжается против ИИ.
    setMode("ai", 0);
    restartMsg = "Соперник отключился"; restartMsgT = 3;
  } else if (netMode === "guest") {
    leaveNet();
  }
}

function leaveNet() {
  Net.close();
  setMode("ai", 0);
  state = "menu";
  document.body.classList.remove("playing");
  if (el.netPanel) el.netPanel.hidden = true;
  el.startBtn.textContent = "Играть с ИИ";
  el.overlay.classList.add("show");
}

if (el.netBtn) el.netBtn.addEventListener("click", openNetPanel);
if (el.netGo) el.netGo.addEventListener("click", connectNet);
if (el.netStart) el.netStart.addEventListener("click", () => { el.netPanel.hidden = true; startMatch(); });
if (el.netCancel) el.netCancel.addEventListener("click", leaveNet);
if (el.netCopy) el.netCopy.addEventListener("click", () => {
  const link = el.netCopy.dataset.link || "";
  if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => netSay("Ссылка скопирована"), () => netSay(link));
  else netSay(link);
});

// Пришли по ссылке с кодом — сразу открываем лобби.
if (new URL(location.href).searchParams.get("room")) {
  setTimeout(openNetPanel, 100);
}

if (!window.matchMedia("(display-mode: standalone)").matches) {
  el.installHint.hidden = false;
}

Scene3D.init(canvas, { PITCH_L, PITCH_W, GOAL_HALF, MOUTH_LO, MOUTH_HI });
loadCamSettings();
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
