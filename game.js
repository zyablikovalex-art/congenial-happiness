"use strict";

/* Версия сборки. Увеличивается на каждый релиз и показывается в углу меню.
   Держать её и CACHE в sw.js одним и тем же числом: по нему же обновляется
   офлайновый кэш, иначе игрок увидит новый номер поверх старых файлов. */
const APP_VERSION = 58;

/* =========================================================================
   Футбол 11 на 11 — 3D (Three.js), альбомная ориентация.
   Этот файл — только СИМУЛЯЦИЯ (мир, физика, ИИ, ввод) в мировых координатах
   (x вдоль поля от ворот к воротам, z — ширина от ближней бровки к дальней,
   h — высота мяча). Весь рендер — в scene.js (window.Scene3D).
   ========================================================================= */

// ---- Мир ----
/* ДВОРОВАЯ КОРОБКА.

   Масштаб задан моделью игрока: 86.7 мировых единиц от земли до макушки —
   это «185 см», значит 1 единица = 2.13 см, 1 метр = 46.86 единиц.

   Размер площадки взят у режима Rush из серии EA FC — 63.7 x 46.6 м, 5 на 5,
   ворота стандартные. Но по ширине площадка Rush почти квадратная (1.37) и
   даёт 297 м² на игрока — почти как большой футбол (325) и в 3.7 раза больше
   настоящего мини-футбола. Играть на ней просторно, поэтому ширину сузили до
   40 м: соотношение сторон становится 1.59, как у обычного футбольного поля,
   а простора остаётся 255 м² на игрока. Длина оставлена ровно по Rush.
     коробка          63.7 x 40 м      2985 x 1875
     скругление углов 8.5 м            398   (как у хоккейной коробки 60x30)
     борта            1.2 м            56
     ворота           7.32 x 2.44 м    полуствор 172, перекладина 114
   Разметка мини-футбольная, увеличенная в 1.59 раза вслед за площадкой:
   штрафная — четверть круга радиусом 9.6 м от стойки, точка пенальти 9.6 м,
   вторая отметка 15.9 м, центральный круг 4.8 м.

   Главное отличие от поля: аутов нет. По периметру идут борта, мяч от них
   отскакивает, розыгрышей из-за боковой и от ворот не бывает. Единственный
   проём в бортах — створ ворот, и в нём борта нет вообще: иначе мяч
   отражался бы за 8 единиц до линии и гол не засчитывался. */
const PITCH_L = 2985;     // длина коробки (ось x) — «63.7 м»
const PITCH_W = 1875;     // ширина коробки (ось z) — «40 м»
const CORNER_R = 398;     // радиус скругления углов — «8.5 м»
const BOARD_H = 56;       // высота борта — «1.2 м»
const BOARD_BOUNCE = 0.55;// доля скорости, сохраняемая при ударе о борт
const GOAL_HALF = 172;    // половина створа — ворота 7.32 м
const GOAL_DEPTH_H = 114; // высота перекладины — 2.44 м; выше — мяч в сетку за воротами
const GOAL_DEPTH = 75;    // глубина ворот за линией — «1.6 м», как рама в scene.js
const VIS_NEAR = 1400;    // сколько длины видно за раз — камера едет за мячом
const PLR_R = 15;         // радиус игрока (мир)
const BALL_R = 8;

const MOUTH_LO = PITCH_W / 2 - GOAL_HALF;
const MOUTH_HI = PITCH_W / 2 + GOAL_HALF;
// Докуда ищется адресат паса низом. Пропорция от длины поля: игроки в составе
// расставлены долями от неё, поэтому фиксированный радиус на большом поле
// переставал доставать до партнёров и пасы уходили в пустоту.
const PASS_RANGE = PITCH_L / 5;

// ---- Тюнинг ----
// Длительность матча задаётся перед стартом (экран заданий / лобби сетевой игры).
const MATCH_MIN_DEF = 2, MATCH_MIN_LO = 0.5, MATCH_MIN_HI = 60;
let matchMinutes = MATCH_MIN_DEF;
let MATCH_SECONDS = matchMinutes * 60;

/* Все настраиваемые числа физики живут в physics.js — там и только там их
   правят «навсегда». Здесь они лишь раскладываются по переменным, которые
   симуляция читает каждый кадр (ползунки админки пишут прямо в них).
   Сила паса/удара зависит от заряда шкалы усилия (min при тапе, max при полном).
   Подброс удара растёт как f² — почти весь диапазон это резкий низкий удар.
   Дальность навеса ≈ speed · (2·loft/GRAV) − потери на трении. */
const PHYSICS = window.PHYSICS;
let SPEED = PHYSICS.SPEED;
let SPRINT = PHYSICS.SPRINT;
let GK_SPEED = PHYSICS.GK_SPEED;
let GK_OUT_MAX = PHYSICS.GK_OUT_MAX;
let GK_RUSH_R = PHYSICS.GK_RUSH_R;
let GK_DIVE_SPEED = PHYSICS.GK_DIVE_SPEED;
let GK_REACH = PHYSICS.GK_REACH;
const GK_DIVE_TIME = 0.5;    // сколько длится сам бросок
const GK_GETUP_TIME = 0.55;  // и сколько вратарь поднимается после него
let ACCEL = PHYSICS.ACCEL;
let CTRL_R = PHYSICS.CTRL_R;
let TACKLE_R = PHYSICS.TACKLE_R;
let TACKLE_STEAL_R = PHYSICS.TACKLE_STEAL_R;
let STEAL_RATE = PHYSICS.STEAL_RATE;
let DRIBBLE_AHEAD = PHYSICS.DRIBBLE_AHEAD;
let PASS_MIN = PHYSICS.PASS_MIN, PASS_MAX = PHYSICS.PASS_MAX;
let SHOT_MIN = PHYSICS.SHOT_MIN, SHOT_MAX = PHYSICS.SHOT_MAX;
let SHOT_MIN_LOFT = PHYSICS.SHOT_MIN_LOFT, SHOT_MAX_LOFT = PHYSICS.SHOT_MAX_LOFT;
let LOB_MIN_SPEED = PHYSICS.LOB_MIN_SPEED, LOB_MAX_SPEED = PHYSICS.LOB_MAX_SPEED;
let LOB_MIN_LOFT = PHYSICS.LOB_MIN_LOFT, LOB_MAX_LOFT = PHYSICS.LOB_MAX_LOFT;
let CHARGE_TIME = PHYSICS.CHARGE_TIME;
let CHARGE_MIN = PHYSICS.CHARGE_MIN;
let GRAV = PHYSICS.GRAV;
let BOUNCE = PHYSICS.BOUNCE;
let GROUND_FRICTION = PHYSICS.GROUND_FRICTION;
let AIR_FRICTION = PHYSICS.AIR_FRICTION;

/* =========================================================================
   Где разрешён мультиплеер.
   Сетевая игра ходит к внешнему брокеру PeerJS, а игровые площадки
   (Яндекс Игры, VK Play) режут внешние запросы своей политикой CSP. Поэтому
   на «своих» доменах мультиплеер есть, на чужих — только матч с ИИ.
   Чтобы включить его ещё где-то, достаточно дописать хост сюда.
   Для проверки: ?mp=1 включает принудительно, ?mp=0 выключает.
   ========================================================================= */
const MP_HOSTS = [
  "zyablikovalex-art.github.io",  // боевой адрес
  "localhost", "127.0.0.1",       // локальная разработка
];

function multiplayerAllowed() {
  try {
    const force = new URL(location.href).searchParams.get("mp");
    if (force === "1") return true;
    if (force === "0") return false;
    return MP_HOSTS.indexOf(location.hostname) !== -1;
  } catch (_) { return false; }
}

const canvas = document.getElementById("pitch");
let camX = PITCH_L / 2; // центр камеры по длине поля (едет за мячом)
let camZ = PITCH_W / 2; // фокус камеры по ширине (мягко следует за мячом)

function resize() {
  if (window.Scene3D) Scene3D.resize();
  fitMenuStage();
}
window.addEventListener("resize", resize);

// Макет меню нарисован под 1280×720 — целиком вписываем его в экран.
function fitMenuStage() {
  const st = document.getElementById("mstage");
  if (!st) return;
  const s = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  st.style.transform = "translate(-50%, -50%) scale(" + s + ")";
}

// Допустимый диапазон камеры: у ближней бровки не выходим за пределы поля.
// wide=true — празднование: камере разрешено доехать вплотную к воротам,
// иначе она встаёт в 15 м от них и сетка остаётся у самого края кадра.
function camClamp(x, wide) {
  const half = wide ? 120 : VIS_NEAR / 2;
  return clamp(x, half, PITCH_L - half);
}

// ---- Мелкие утилиты ----
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hyp(a, b) { return Math.hypot(a, b); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
// Детерминированный псевдослучай (Math.random в этом окружении недоступен).
function nrand(n) { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }

// ---- Состав 5 на 5 (вратарь + 4 в поле, схема 2-2, как в мини-футболе) ----
// Доли коробки: fx от своих ворот, fz по ширине.
// Компактная: четверо полевых на 5 на 5 держатся близко друг к другу,
// иначе на площадке Rush между ними по десять метров и играть просторно.
const FORMATION = [
  { fx: 0.07, fz: 0.50, gk: true }, // вратарь
  { fx: 0.32, fz: 0.38 },           // защитники
  { fx: 0.32, fz: 0.62 },
  { fx: 0.50, fz: 0.42 },           // нападающие
  { fx: 0.50, fz: 0.58 },
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
const CELEBRATE_TIME = 10;   // секунд празднования после гола
let celebrateTeam = 0;       // кто забил — у них подняты руки
let pendingKick = 0;         // кто начнёт с центра, когда празднование кончится
let goalSeq = 0;             // номер гола: по нему сцена качает сетку один раз
let goalAt = null;           // где мяч пересёк линию
let scorer = null;           // кто забил — на нём держится камера в празднование
let netHitSeq = 0;           // счётчик касаний задней сетки
let netHitAt = null;         // где и с какой силой мяч попал в сетку
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
  netBtn: document.getElementById("mNet"),
  menuUI: document.getElementById("menuUI"),
  mstage: document.getElementById("mstage"),
  mPlay: document.getElementById("mPlay"),
  mBack: document.getElementById("mBack"),
  mTasks: document.getElementById("mTasks"),
  mCards: document.getElementById("mCards"),
  mLen: document.getElementById("mLen"),
  mVersion: document.getElementById("mVersion"),
  freezeOpp: document.getElementById("freezeOpp"),
  trainBadge: document.getElementById("trainBadge"),
  netLenRow: document.getElementById("netLenRow"),
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
const CAM_DEFAULTS = { angle: 35, height: 14 };
// v1 мерил высоту от старой точки взгляда, v2 — от футбольного поля,
// v3 — от коробки 40x20. Все три на площадке Rush дают не тот план,
// поэтому выбрасываем: иначе сохранённая настройка молча перекрывает новый
// дефолт и правка камеры до игрока просто не доезжает.
const CAM_STORE_V = 5;
let paused = false;
// Демо-режим: пока открыта панель физики, играют оба ИИ (только в матче с ИИ —
// в сетевой игре командой соперника управляет живой человек).
let autoPlay = false;
// Тренировочный режим: команда соперника стоит на месте и не отбирает мяч.
// Только в матче с ИИ — в сетевой игре той командой играет живой человек.
let freezeOpp = false;

function isFrozen(p) { return freezeOpp && netMode === "ai" && p.team !== myTeam; }

function applyCamSettings(s, save) {
  Scene3D.setCamera(s);
  const cur = Scene3D.getCamera();
  if (el.angleRange) el.angleRange.value = cur.angle;
  if (el.heightRange) el.heightRange.value = cur.height;
  if (el.angleVal) el.angleVal.textContent = Math.round(cur.angle) + "°";
  if (el.heightVal) el.heightVal.textContent = cur.height;
  if (save) {
    try { localStorage.setItem("cam", JSON.stringify({ v: CAM_STORE_V, angle: cur.angle, height: cur.height })); } catch (_) {}
  }
}

function loadCamSettings() {
  let s = null;
  try {
    const raw = localStorage.getItem("cam");
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.v === CAM_STORE_V && p.angle != null) s = p;
      else localStorage.removeItem("cam");
    }
  } catch (_) {}
  applyCamSettings(s || CAM_DEFAULTS, false);
}

/* =========================================================================
   Админка физики: живые ползунки. Значения пишутся прямо в переменные,
   которые симуляция читает каждый кадр, поэтому эффект виден сразу.
   ========================================================================= */
/* Живой расчёт траектории навеса — иначе два ползунка, произведение которых
   даёт дальность, приходится подбирать вслепую.
   время полёта  = 2·loft/GRAV        (вертикаль тормозит только гравитация)
   вершина       = loft²/(2·GRAV)
   дальность     = ∫ speed·e^(−AIR·t) = speed/AIR · (1 − e^(−AIR·flight)) */
function lobFlight(f) {
  const speed = LOB_MIN_SPEED + f * (LOB_MAX_SPEED - LOB_MIN_SPEED);
  const loft = LOB_MIN_LOFT + f * (LOB_MAX_LOFT - LOB_MIN_LOFT);
  const time = 2 * loft / GRAV;
  return { speed, loft, time, apex: loft * loft / (2 * GRAV), dist: speed * airReach(time) };
}

// Путь, который мяч проходит по горизонтали за время t на единичной скорости.
// При нулевом трении это просто t.
function airReach(t) {
  return AIR_FRICTION > 1e-6 ? (1 - Math.exp(-AIR_FRICTION * t)) / AIR_FRICTION : t;
}

function lobPreview() {
  const row = (label, f) => {
    const r = lobFlight(f);
    return `${label}: вершина <b>${Math.round(r.apex)}</b> · дальность <b>${Math.round(r.dist)}</b> · ${r.time.toFixed(1)} с`;
  };
  return row("Полный заряд", 1) + "<br>" + row("Короткий тап", CHARGE_MIN) +
    `<br>Для масштаба: поле 1800 в ширину, игрок бежит ${Math.round(SPEED)} в секунду.`;
}

const PHYS_GROUPS = [
  { title: "Бег", items: [
    { k: "SPEED",  label: "Скорость бега", min: 40, max: 260, step: 2, get: () => SPEED,  set: (v) => SPEED = v },
    { k: "SPRINT", label: "Спринт",        min: 60, max: 320, step: 2, get: () => SPRINT, set: (v) => SPRINT = v },
    { k: "ACCEL",  label: "Ускорение (отклик)", min: 300, max: 4000, step: 50, get: () => ACCEL, set: (v) => ACCEL = v },
    { k: "GK_SPEED", label: "Скорость вратаря", min: 40, max: 220, step: 2, get: () => GK_SPEED, set: (v) => GK_SPEED = v },
  ]},
  { title: "Вратарь", items: [
    { k: "GK_SPEED", label: "Скорость", min: 60, max: 400, step: 2, get: () => GK_SPEED, set: (v) => GK_SPEED = v },
    { k: "GK_OUT_MAX", label: "Максимальный выход", min: 40, max: 700, step: 10, get: () => GK_OUT_MAX, set: (v) => GK_OUT_MAX = v },
    { k: "GK_RUSH_R", label: "Дистанция выхода на мяч", min: 100, max: 1200, step: 10, get: () => GK_RUSH_R, set: (v) => GK_RUSH_R = v },
    { k: "GK_DIVE_SPEED", label: "Скорость броска", min: 200, max: 1200, step: 10, get: () => GK_DIVE_SPEED, set: (v) => GK_DIVE_SPEED = v },
    { k: "GK_REACH", label: "Радиус приёма мяча", min: 30, max: 220, step: 5, get: () => GK_REACH, set: (v) => GK_REACH = v },
  ]},
  { title: "Мяч", items: [
    { k: "GRAV",   label: "Гравитация",    min: 200, max: 1400, step: 20, get: () => GRAV,   set: (v) => GRAV = v },
    { k: "BOUNCE", label: "Отскок от газона", min: 0, max: 0.9, step: 0.05, get: () => BOUNCE, set: (v) => BOUNCE = v },
    { k: "GROUND_FRICTION", label: "Трение о газон", min: 0.2, max: 3, step: 0.05, get: () => GROUND_FRICTION, set: (v) => GROUND_FRICTION = v },
    { k: "AIR_FRICTION",    label: "Сопротивление воздуха", min: 0, max: 1, step: 0.02, get: () => AIR_FRICTION, set: (v) => AIR_FRICTION = v },
  ]},
  { title: "Пас", items: [
    { k: "PASS_MIN", label: "Сила: короткий тап", min: 100, max: 700, step: 10, get: () => PASS_MIN, set: (v) => PASS_MIN = v },
    { k: "PASS_MAX", label: "Сила: полный заряд", min: 300, max: 1400, step: 10, get: () => PASS_MAX, set: (v) => PASS_MAX = v },
  ]},
  { title: "Удар", items: [
    { k: "SHOT_MIN", label: "Сила: минимум", min: 200, max: 900, step: 10, get: () => SHOT_MIN, set: (v) => SHOT_MIN = v },
    { k: "SHOT_MAX", label: "Сила: максимум", min: 400, max: 1600, step: 10, get: () => SHOT_MAX, set: (v) => SHOT_MAX = v },
    { k: "SHOT_MIN_LOFT", label: "Вверх: минимум", min: 0, max: 200, step: 5, get: () => SHOT_MIN_LOFT, set: (v) => SHOT_MIN_LOFT = v },
    { k: "SHOT_MAX_LOFT", label: "Вверх: максимум", min: 100, max: 900, step: 10, get: () => SHOT_MAX_LOFT, set: (v) => SHOT_MAX_LOFT = v },
  ]},
  { title: "Навес", note: lobPreview, items: [
    // «минимум» — это конец шкалы при нулевом заряде, а не то, что даёт тап:
    // CHARGE_MIN не даёт f опуститься ниже 0.32. Реальные значения для тапа
    // и для полного заряда показывает расчёт под группой.
    { k: "LOB_MIN_SPEED", label: "Вперёд: минимум", min: 60, max: 800, step: 10, get: () => LOB_MIN_SPEED, set: (v) => LOB_MIN_SPEED = v },
    { k: "LOB_MAX_SPEED", label: "Вперёд: максимум", min: 300, max: 1800, step: 10, get: () => LOB_MAX_SPEED, set: (v) => LOB_MAX_SPEED = v },
    { k: "LOB_MIN_LOFT", label: "Вверх: минимум", min: 20, max: 500, step: 10, get: () => LOB_MIN_LOFT, set: (v) => LOB_MIN_LOFT = v },
    { k: "LOB_MAX_LOFT", label: "Вверх: максимум", min: 100, max: 1000, step: 10, get: () => LOB_MAX_LOFT, set: (v) => LOB_MAX_LOFT = v },
  ]},
  { title: "Шкала усилия", items: [
    { k: "CHARGE_TIME", label: "Время до максимума, с", min: 0.2, max: 2, step: 0.05, get: () => CHARGE_TIME, set: (v) => CHARGE_TIME = v },
    { k: "CHARGE_MIN",  label: "Доля силы при тапе", min: 0.05, max: 1, step: 0.01, get: () => CHARGE_MIN, set: (v) => CHARGE_MIN = v },
  ]},
  { title: "Борьба за мяч", items: [
    { k: "CTRL_R", label: "Радиус подбора", min: 10, max: 70, step: 1, get: () => CTRL_R, set: (v) => CTRL_R = v },
    { k: "TACKLE_STEAL_R", label: "Радиус моего отбора", min: 15, max: 120, step: 1, get: () => TACKLE_STEAL_R, set: (v) => TACKLE_STEAL_R = v },
    { k: "TACKLE_R", label: "Радиус отбора ИИ", min: 10, max: 70, step: 1, get: () => TACKLE_R, set: (v) => TACKLE_R = v },
    { k: "STEAL_RATE", label: "Частота отбора ИИ, 1/с", min: 0, max: 8, step: 0.1, get: () => STEAL_RATE, set: (v) => STEAL_RATE = v },
    { k: "DRIBBLE_AHEAD", label: "Вынос мяча при ведении", min: 5, max: 60, step: 1, get: () => DRIBBLE_AHEAD, set: (v) => DRIBBLE_AHEAD = v },
  ]},
];

const PHYS_ITEMS = PHYS_GROUPS.reduce((a, g) => a.concat(g.items), []);
// Значения «из кода» — то, что записано в physics.js. Ползунки хранят только
// отличия от них, поэтому правка physics.js доезжает до игрока даже после того,
// как он что-то покрутил: перетираются лишь реально сдвинутые параметры.
const PHYS_DEFAULTS = {};
PHYS_ITEMS.forEach((it) => { PHYS_DEFAULTS[it.k] = it.get(); });

function physFmt(it) {
  const v = it.get();
  return it.step < 1 ? v.toFixed(2).replace(/0$/, "") : String(Math.round(v));
}

function physChanged(it) { return Math.abs(it.get() - PHYS_DEFAULTS[it.k]) > 1e-9; }

// Пересчёт живых подсказок под группами (гравитация и трение влияют на навес,
// поэтому обновляем все, а не только ту группу, где двигали ползунок).
function refreshPhysNotes() {
  document.querySelectorAll("#physList .phys-live").forEach((el2) => {
    const g = PHYS_GROUPS[+el2.dataset.note];
    if (g && g.note) el2.innerHTML = g.note();
  });
}

function buildPhysUI() {
  const host = document.getElementById("physList");
  if (!host) return;
  host.innerHTML = PHYS_GROUPS.map((g, gi) =>
    `<div class="phys-group">${g.title}</div>` + g.items.map((it) =>
      `<label class="prow">
         <span class="prow-top"><span>${it.label}</span><b data-v="${it.k}" class="${physChanged(it) ? "changed" : ""}">${physFmt(it)}</b></span>
         <input type="range" data-k="${it.k}" min="${it.min}" max="${it.max}" step="${it.step}" value="${it.get()}" />
       </label>`).join("") +
    (g.note ? `<div class="phys-live" data-note="${gi}">${g.note()}</div>` : "")
  ).join("");

  host.querySelectorAll("input[type=range]").forEach((inp) => {
    const it = PHYS_ITEMS.find((x) => x.k === inp.dataset.k);
    inp.addEventListener("input", () => {
      it.set(parseFloat(inp.value));
      const b = host.querySelector(`b[data-v="${it.k}"]`);
      b.textContent = physFmt(it);
      b.classList.toggle("changed", physChanged(it));
      refreshPhysNotes();
      savePhys();
    });
    // после отпускания снимаем фокус — иначе стрелки будут двигать ползунок, а не игрока
    inp.addEventListener("change", () => inp.blur());
  });
}

// В localStorage кладём ТОЛЬКО отличия от physics.js. Иначе один раз тронутая
// панель заморозила бы у игрока весь набор чисел, и правки в коде до него бы не дошли.
const PHYS_STORE_V = 2;   // v1 хранил все 25 чисел целиком — такие записи выбрасываем

function savePhys() {
  const d = {};
  PHYS_ITEMS.forEach((it) => { if (physChanged(it)) d[it.k] = it.get(); });
  try {
    if (Object.keys(d).length) localStorage.setItem("phys", JSON.stringify({ v: PHYS_STORE_V, d }));
    else localStorage.removeItem("phys");
  } catch (_) {}
}

function loadPhys() {
  try {
    const raw = localStorage.getItem("phys");
    if (!raw) return;
    const o = JSON.parse(raw);
    if (!o || o.v !== PHYS_STORE_V) { localStorage.removeItem("phys"); return; }
    PHYS_ITEMS.forEach((it) => { if (typeof o.d[it.k] === "number") it.set(o.d[it.k]); });
  } catch (_) {}
}

function resetPhys() {
  PHYS_ITEMS.forEach((it) => it.set(PHYS_DEFAULTS[it.k]));
  savePhys();
  buildPhysUI();
}

// Готовое содержимое physics.js с текущими значениями — заменить файл в репозитории,
// и подобранная физика становится общей для всех запусков и всех игроков.
function physAsCode() {
  const num = (it) => (it.step < 1 ? +it.get().toFixed(3) : Math.round(it.get()));
  const pad = (s, n) => s + " ".repeat(Math.max(1, n - s.length));
  const body = PHYS_GROUPS.map((g) =>
    "  // " + g.title + "\n" + g.items.map((it) =>
      "  " + pad(it.k + ": " + num(it) + ",", 26) + "// " + it.label
    ).join("\n")
  ).join("\n\n");
  return '"use strict";\n' +
    "/* =========================================================================\n" +
    "   Настройки физики — единственное место, где живут числа.\n\n" +
    "   Менять можно двумя способами:\n" +
    "     1) прямо здесь руками — это просто числа, математики тут нет;\n" +
    "     2) ползунками в игре (⚙ → «Физика»), а потом нажать «Экспорт» —\n" +
    "        кнопка отдаёт готовое содержимое ЭТОГО файла, останется заменить.\n\n" +
    "   Значения отсюда — общие для всех запусков и всех игроков. Ползунки в игре\n" +
    "   переопределяют их только в текущем браузере и только те параметры, которые\n" +
    "   реально двигали: всё остальное продолжает браться отсюда.\n" +
    "   ========================================================================= */\n" +
    "window.PHYSICS = {\n" + body + "\n};\n";
}

/* ---- Тренировочный режим ---- */
function applyFreezeOpp(on, save) {
  freezeOpp = !!on;
  if (el.freezeOpp) {
    el.freezeOpp.checked = freezeOpp;
    // В сетевой игре той командой играет человек — замораживать нечего.
    el.freezeOpp.disabled = netMode !== "ai";
  }
  // Режим переживает закрытие панели, поэтому о нём напоминает плашка в HUD.
  if (el.trainBadge) el.trainBadge.hidden = !(freezeOpp && netMode === "ai");
  if (save) { try { localStorage.setItem("freezeOpp", freezeOpp ? "1" : "0"); } catch (_) {} }
}

if (el.freezeOpp) el.freezeOpp.addEventListener("change", () => applyFreezeOpp(el.freezeOpp.checked, true));
try { applyFreezeOpp(localStorage.getItem("freezeOpp") === "1", false); } catch (_) { applyFreezeOpp(false, false); }

/* ---- Вкладки панели ---- */
let settingsTab = "cam";

function setSettingsTab(tab) {
  settingsTab = tab;
  document.querySelectorAll(".stab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const cam = document.getElementById("paneCam"), phys = document.getElementById("panePhys");
  if (cam) cam.hidden = tab !== "cam";
  if (phys) phys.hidden = tab !== "phys";
  const copy = document.getElementById("settingsCopy");
  if (copy) copy.hidden = tab !== "phys";
  // На вкладке физики матч продолжается и панель не перекрывает игру,
  // чтобы можно было двигать ползунок и сразу видеть результат.
  const live = tab === "phys";
  el.settings.classList.toggle("live", live);
  paused = !live && state === "playing";
  // На вкладке физики отдаём обе команды ИИ — смотрим игру со стороны.
  autoPlay = live && netMode === "ai";
}

document.querySelectorAll(".stab").forEach((b) =>
  b.addEventListener("click", () => setSettingsTab(b.dataset.tab)));

const copyBtn = document.getElementById("settingsCopy");
if (copyBtn) copyBtn.addEventListener("click", () => {
  const text = physAsCode();
  const flash = (msg) => { copyBtn.textContent = msg; setTimeout(() => copyBtn.textContent = "Экспорт", 1600); };
  // Запасной путь: скрытая textarea + execCommand — работает там, где нет
  // clipboard API (http-страница, старый WebView).
  const legacy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
    flash(ok ? "Скопировано" : "См. консоль");
    if (!ok) console.log(text);
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => flash("Скопировано"), legacy);
  else legacy();
});

function openSettings() {
  if (!el.settings) return;
  resetCharge();
  pad.sprint = false;
  stickReset();
  keyHeld.clear();
  el.settings.hidden = false;
  setSettingsTab(settingsTab);   // паузу решает вкладка
}
function closeSettings() {
  if (!el.settings) return;
  el.settings.hidden = true;
  el.settings.classList.remove("live");
  paused = false;
  autoPlay = false;   // управление возвращается игроку
}

if (el.settingsBtn) el.settingsBtn.addEventListener("click", openSettings);
if (el.settingsClose) el.settingsClose.addEventListener("click", closeSettings);
if (el.settingsReset) el.settingsReset.addEventListener("click", () => {
  if (settingsTab === "phys") resetPhys();
  else applyCamSettings(CAM_DEFAULTS, true);
});
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

/* Клавишу опознаём по e.code — это физическая позиция на клавиатуре, она не
   зависит от раскладки. e.key в русской раскладке отдаёт «ы», «в», «ф»
   вместо s, d, a, из-за чего пас, удар и навес просто не срабатывали.
   Приводим к прежним обозначениям, чтобы остальной код не менялся. */
function keyId(e) {
  const c = e.code;
  if (c) {
    if (c.length === 4 && c.startsWith("Key")) return c[3].toLowerCase();
    if (c === "Space") return " ";
    if (c === "ShiftLeft" || c === "ShiftRight") return "shift";
    if (c.startsWith("Arrow")) return c.toLowerCase();
  }
  const k = (e.key || "").toLowerCase();   // запасной путь для старых браузеров
  return k === "spacebar" ? " " : k;
}

window.addEventListener("keydown", (e) => {
  const k = keyId(e);
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
  const k = keyId(e);
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
  clampInsideBoards(p, PLR_R);
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
  if (ball.owner) { ball.lastTeam = ball.owner.team; ball.lastTouch = ball.owner; }
  ball.owner = null;
  ball.cooldown = 0.2;
  ball.vx = dx * power;
  ball.vz = dz * power;
  ball.vh = loft || 0;
  if (loft > 0) ball.h = Math.max(ball.h, 1);
}

// f — доля усилия [0..1]. Для ИИ по умолчанию берём среднюю силу.
/* Удар. Прицел по створу задаётся боковой составляющей ввода: держишь
   джойстик к дальней бровке — бьёшь в дальний угол. Раньше здесь стояла
   константа «центр ворот», поэтому все удары шли в одну точку — ровно туда,
   где стоит вратарь. Без ввода (и у ИИ) целимся в дальний от вратаря угол.
   Точность падает с силой: пушечный удар уходит от прицела заметнее. */
function shotAimZ(p) {
  const inner = GOAL_HALF * 0.8;                 // полный прицел — не в штангу, а рядом с ней
  const iv = inputVectorFor(p);
  let aim;
  if (Math.abs(iv.z) > 0.25) {
    aim = clamp(iv.z, -1, 1);
  } else {
    const gk = players.find((g) => g.isGK && g.team !== p.team);
    const off = gk ? (gk.z - PITCH_W / 2) / GOAL_HALF : 0;
    aim = clamp(-off, -1, 1);
    // вратарь по центру — выбираем угол, а не бьём ему в руки
    if (Math.abs(aim) < 0.3) aim = (nrand(F * 0.7 + p.id * 3.3) < 0.5 ? -1 : 1) * 0.7;
  }
  return PITCH_W / 2 + aim * inner;
}

function doShoot(p, f) {
  if (!p || ball.owner !== p) return;
  if (f == null) f = 0.85;
  const goalX = p.team === 0 ? PITCH_L : 0;
  // Разброс растёт с силой: на средней силе удар точный, на полной может уйти
  // мимо штанги — иначе каждый удар был бы в створ.
  const spread = (nrand(F * 1.9 + p.id * 7.1) - 0.5) * GOAL_HALF * 0.45 * f;
  const targetZ = shotAimZ(p) + spread;
  const dx = goalX - p.x, dz = targetZ - p.z, d = hyp(dx, dz) || 1;
  const speed = SHOT_MIN + f * (SHOT_MAX - SHOT_MIN);
  const loft = SHOT_MIN_LOFT + f * f * (SHOT_MAX_LOFT - SHOT_MIN_LOFT);
  kick(speed, dx / d, dz / d, loft);
}

// Общее направление передачи — используется и пасом, и навесом, чтобы они
// вели себя одинаково. Возвращает единичный вектор, партнёра-цель и дистанцию.
function passDirection(p, opts) {
  const attackDir = p.team === 0 ? 1 : -1;
  // Докуда вообще искать партнёра и на какой дистанции он предпочтителен.
  // У паса низом — «ближе лучше». У навеса — «ближе к тому месту, куда
  // добьёт текущий заряд», иначе длинный навес всегда цеплялся бы за
  // ближайшего своего и укорачивался до него.
  const maxDist = (opts && opts.maxDist) || PASS_RANGE;
  const preferDist = opts && opts.preferDist;

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
    if (d < 30 || d > maxDist) continue;
    const align = (dx * aimx + dz * aimz) / d;   // -1..1: насколько партнёр в сторону прицела
    if (align < 0.30) continue;                  // не пасуем вбок/назад от прицела
    const off = preferDist ? Math.abs(d - preferDist) : d;
    const score = align * 1.8 - off / 500;       // приоритет — совпадение с прицелом
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
  let r = lobFlight(f);   // скорость, подъём и дальность при этом заряде

  // Адресата ищем на той дистанции, куда бьём: слабый навес найдёт ближнего,
  // сильный — дальнего. Иначе любой свой в двух шагах впереди срезал бы
  // полный заряд до своей дистанции, и шкала усилия меняла бы только высоту.
  const dir = passDirection(p, { maxDist: r.dist * 1.15, preferDist: r.dist });

  // Адресат ближе, чем добьёт заряд — гасим удар целиком, а не одну скорость.
  // Иначе к партнёру в двух шагах ушла бы свеча на всю высоту заряда: подъём
  // остался бы максимальным, а скорость упала бы почти до нуля.
  if (dir.target && r.dist > dir.dist) {
    let lo = 0, hi = f;                       // дальность растёт с зарядом
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (lobFlight(mid).dist > dir.dist) hi = mid; else lo = mid;
    }
    r = lobFlight(hi);
    // Адресат ближе, чем летит даже нулевой заряд — остаётся урезать скорость.
    if (r.dist > dir.dist) r.speed = dir.dist / airReach(r.time);
  }
  kick(r.speed, dir.x, dir.z, r.loft);
}

// Отбор/перехват: рывок к мячу и захват при сближении.
function doTackle(p) {
  if (!p || ball.owner === p) return;
  const dx = ball.x - p.x, dz = ball.z - p.z, d = hyp(dx, dz) || 1;
  p.vx += dx / d * 90; p.vz += dz / d * 90; // рывок делает отбор отзывчивым
  if (d < TACKLE_STEAL_R) {
    if (ball.owner && ball.owner.team !== p.team) {
      ball.owner = p; ball.lastTeam = p.team; ball.lastTouch = p; ball.cooldown = 0.05; // отбор
    } else if (!ball.owner) {
      ball.owner = p; ball.lastTeam = p.team; ball.lastTouch = p; ball.cooldown = 0;     // перехват
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
    const fr = Math.exp(-GROUND_FRICTION * dt); // трение о газон
    ball.vx *= fr; ball.vz *= fr;
  } else {
    const fr = Math.exp(-AIR_FRICTION * dt);   // сопротивление воздуха в полёте
    ball.vx *= fr; ball.vz *= fr;
  }
  const sp = hyp(ball.vx, ball.vz);
  if (sp < 4 && ball.h === 0) { ball.vx = 0; ball.vz = 0; }

  bounceOffBoards();

  if (ball.cooldown > 0) ball.cooldown -= dt;
}

/* Мяч в проёме ворот? Там борта нет: ни отражения, ни ограничения по x,
   иначе мяч разворачивался бы на радиусе BALL_R, не доходя до линии. */
function ballInMouth() {
  return ball.z > MOUTH_LO && ball.z < MOUTH_HI && ball.h < GOAL_DEPTH_H;
}

/* Гол засчитывается по пересечению линии ворот — независимо от того, летит
   мяч свободно или его завёл игрок. Возвращает true, если матч перезапущен. */
function checkGoal() {
  if (!ballInMouth()) return false;
  if (ball.x <= 0) { scoreGoal("cpu"); return true; }
  if (ball.x >= PITCH_L) { scoreGoal("you"); return true; }
  return false;
}

/* Отскок от бортов коробки. Аутов нет: по периметру глухой борт, мимо ворот
   мяч возвращается в игру. Прямые участки — обычное отражение, в углах борт
   скруглён радиусом CORNER_R, поэтому там отражаем по нормали дуги. */
function bounceOffBoards() {
  const lo = BALL_R, hiX = PITCH_L - BALL_R, hiZ = PITCH_W - BALL_R;
  const openEnd = ballInMouth();   // торцевого борта в створе нет

  // В углу? Тогда ограничивает дуга, а не две прямые.
  const cx = ball.x < CORNER_R ? CORNER_R : ball.x > PITCH_L - CORNER_R ? PITCH_L - CORNER_R : null;
  const cz = ball.z < CORNER_R ? CORNER_R : ball.z > PITCH_W - CORNER_R ? PITCH_W - CORNER_R : null;
  if (cx !== null && cz !== null) {
    const dx = ball.x - cx, dz = ball.z - cz, d = hyp(dx, dz);
    const max = CORNER_R - BALL_R;
    if (d > max && d > 0.001) {
      const nx = dx / d, nz = dz / d;          // нормаль дуги, наружу
      ball.x = cx + nx * max; ball.z = cz + nz * max;
      const vn = ball.vx * nx + ball.vz * nz;  // составляющая скорости в борт
      if (vn > 0) {
        ball.vx -= (1 + BOARD_BOUNCE) * vn * nx;
        ball.vz -= (1 + BOARD_BOUNCE) * vn * nz;
      }
    }
    return;
  }

  if (!openEnd) {
    if (ball.x < lo) { ball.x = lo; if (ball.vx < 0) ball.vx *= -BOARD_BOUNCE; }
    else if (ball.x > hiX) { ball.x = hiX; if (ball.vx > 0) ball.vx *= -BOARD_BOUNCE; }
  }
  if (ball.z < lo) { ball.z = lo; if (ball.vz < 0) ball.vz *= -BOARD_BOUNCE; }
  else if (ball.z > hiZ) { ball.z = hiZ; if (ball.vz > 0) ball.vz *= -BOARD_BOUNCE; }
}

/* Тот же скруглённый прямоугольник, но без отскока — для игроков, а также
   для мяча на ноге. openEnd оставляет открытым створ, чтобы мяч можно было
   завести в ворота с ведения, а не только ударом. */
function clampInsideBoards(o, r, openEnd) {
  const cx = o.x < CORNER_R ? CORNER_R : o.x > PITCH_L - CORNER_R ? PITCH_L - CORNER_R : null;
  const cz = o.z < CORNER_R ? CORNER_R : o.z > PITCH_W - CORNER_R ? PITCH_W - CORNER_R : null;
  if (cx !== null && cz !== null) {
    const dx = o.x - cx, dz = o.z - cz, d = hyp(dx, dz), max = CORNER_R - r;
    if (d > max && d > 0.001) { o.x = cx + dx / d * max; o.z = cz + dz / d * max; }
    return;
  }
  if (!openEnd) o.x = clamp(o.x, r, PITCH_L - r);
  o.z = clamp(o.z, r, PITCH_W - r);
}

function resolvePossession(dt) {
  if (ball.owner) {
    // Попытки отбора соперниками
    const owner = ball.owner;
    for (const o of players) {
      if (o.team === owner.team || isFrozen(o)) continue;
      // Мерим до МЯЧА, а не до соперника. Мяч при ведении вынесен на
      // DRIBBLE_AHEAD вперёд, а игроков разводит separatePlayers, не давая им
      // сойтись ближе PLR_R*1.7 — то есть радиус до соперника меньше этого
      // порога не срабатывал бы никогда, и ИИ вообще не мог бы отобрать мяч.
      // Ручной отбор (doTackle) и так считает по мячу — теперь одинаково.
      if (dist(o, ball) < TACKLE_R) {
        if (nrand(F * 1.7 + o.id * 3.1) < STEAL_RATE * dt) {
          ball.owner = o; ball.lastTeam = o.team; ball.lastTouch = o; ball.cooldown = 0.05;
          break;
        }
      }
    }
  } else if (ball.cooldown <= 0) {
    // Свободный мяч подбирает ближайший, кто до него дотягивается.
    // Полевой берёт только из-под ног, вратарь — руками, дальше и выше.
    let best = null, bd = 1e9;
    for (const p of players) {
      if (isFrozen(p)) continue;   // замороженные не подбирают мяч
      const r = p.isGK ? GK_REACH : CTRL_R;
      const maxH = p.isGK ? GOAL_DEPTH_H : 24;
      if (ball.h > maxH) continue;
      const d = dist(p, ball);
      if (d < r && d < bd) { bd = d; best = p; }
    }
    if (best) { ball.owner = best; ball.lastTeam = best.team; ball.lastTouch = best; }
  }
}

function glueBall() {
  const o = ball.owner;
  let bx = o.x + o.dirx * DRIBBLE_AHEAD;
  let bz = o.z + o.dirz * DRIBBLE_AHEAD;
  ball.x = bx; ball.z = bz;
  clampInsideBoards(ball, BALL_R, ballInMouth());
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
  // Вратарь мяч не ведёт: подержал и выбил вперёд.
  if (p.isGK) {
    p.holdT = (p.holdT || 0) + dt;
    p.dirx = p.team === 0 ? 1 : -1; p.dirz = 0;
    moveTo(p, p.home.x, p.home.z, GK_SPEED * 0.6, dt);
    if (p.holdT > 0.8) { p.holdT = 0; doLob(p, 0.75); }
    return;
  }
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

/* =========================================================================
   Вратарь. Три поведения по приоритету:
     1) бросок — мяч летит в створ и рукой до него не достать стоя;
     2) выход — свободный мяч или соперник с мячом близко к воротам;
     3) позиция — на биссектрисе «мяч — центр ворот», тем дальше от линии,
        чем ближе мяч: так закрывается угол обстрела.
   ========================================================================= */

// Куда и когда мяч пересечёт линию ворот, если никто не вмешается.
// Считаем тем же шагом, что и симуляция, только вперёд по времени.
function predictBallAtGoal(goalX, maxT) {
  if (ball.owner) return null;
  const toward = goalX === 0 ? ball.vx < -60 : ball.vx > 60;
  if (!toward) return null;
  let x = ball.x, z = ball.z, h = ball.h;
  let vx = ball.vx, vz = ball.vz, vh = ball.vh, t = 0;
  const dt = 1 / 120;
  while (t < maxT) {
    x += vx * dt; z += vz * dt; h += vh * dt; vh -= GRAV * dt;
    if (h <= 0) { h = 0; if (vh < 0) vh = -vh * BOUNCE; }
    const fr = Math.exp(-(h > 0 ? AIR_FRICTION : GROUND_FRICTION) * dt);
    vx *= fr; vz *= fr;
    t += dt;
    if (goalX === 0 ? x <= 0 : x >= PITCH_L) return { t, z, h };
  }
  return null;
}

function gkControl(p, dt) {
  const ownGoalX = p.team === 0 ? 0 : PITCH_L;
  const attackDir = p.team === 0 ? 1 : -1;

  // --- бросок в процессе: летим по инерции, рулить нельзя ---
  if (p.dive) {
    p.dive.t += dt;
    if (p.dive.t < GK_DIVE_TIME) {
      p.vx = p.dive.x * GK_DIVE_SPEED;
      p.vz = p.dive.z * GK_DIVE_SPEED;
      p.x += p.vx * dt; p.z += p.vz * dt;
      clampInsideBoards(p, PLR_R);
    } else {
      p.vx *= 0.1; p.vz *= 0.1;   // упал и встаёт
      if (p.dive.t > GK_DIVE_TIME + GK_GETUP_TIME) p.dive = null;
    }
    return;
  }

  const dGoal = hyp(ball.x - ownGoalX, ball.z - PITCH_W / 2);

  // --- решение о броске ---
  const pred = predictBallAtGoal(ownGoalX, 1.3);
  if (pred && pred.t > 0.06 && pred.h < GOAL_DEPTH_H + 40 &&
      pred.z > MOUTH_LO - 80 && pred.z < MOUTH_HI + 80) {
    const gap = Math.abs(pred.z - p.z);
    // Не мгновенный разгон: реально успевает меньше, чем скорость × время.
    const canWalk = GK_SPEED * pred.t * 0.7 + GK_REACH;
    if (gap > canWalk * 0.85) {
      const dz = pred.z - p.z;
      const dx = (ownGoalX + attackDir * 20) - p.x;
      const m = hyp(dx, dz) || 1;
      p.dive = { t: 0, x: dx / m, z: dz / m };
      p.dirx = dx / m; p.dirz = dz / m;
      return;
    }
  }

  // --- выход на мяч ---
  const freeNear = !ball.owner && dGoal < GK_RUSH_R && ball.h < 90;
  const threat = ball.owner && ball.owner.team !== p.team && dGoal < GK_RUSH_R * 0.55;
  if (freeNear || threat) {
    // выбегаем только если мяч реально ближе к нам, чем к чужим
    let oppCloser = false;
    for (const o of players) {
      if (o.team === p.team || o.isGK) continue;
      if (dist(o, ball) < dist(p, ball) - 20) { oppCloser = true; break; }
    }
    if (!oppCloser || threat) {
      moveTo(p, ball.x, ball.z, GK_SPEED * 1.45, dt);
      return;
    }
  }

  // --- позиция: на линии «мяч — центр ворот», выход тем больше, чем ближе мяч ---
  const gx = ownGoalX, gz = PITCH_W / 2;
  let vx = ball.x - gx, vz = ball.z - gz;
  const vm = hyp(vx, vz) || 1; vx /= vm; vz /= vm;
  const near = clamp((GK_RUSH_R * 3 - dGoal) / (GK_RUSH_R * 3 - GK_RUSH_R * 0.8), 0, 1);
  const out = 30 + near * (GK_OUT_MAX - 30);
  const tx = gx + vx * out;
  // По ширине одной биссектрисы мало: стоя у линии, вратарь смещался бы на
  // считанные сантиметры. Подмешиваем прямое слежение за мячом.
  const track = 0.35 + 0.4 * near;
  const tz = clamp(gz + (ball.z - gz) * track, MOUTH_LO - 70, MOUTH_HI + 70);
  moveTo(p, tx, tz, GK_SPEED, dt);
}

function aiControl(p, dt) {
  const team = p.team;
  const attackDir = team === 0 ? 1 : -1;
  const ownGoalX = team === 0 ? 0 : PITCH_L;

  if (p.isGK) { gkControl(p, dt); return; }

  const teamHasBall = ball.owner && ball.owner.team === team;

  // Домашняя позиция, смещённая к мячу (команда двигается как единое целое).
  // На площадке 5 на 5 команда идёт за мячом заметно плотнее, чем ходила бы
  // на большом поле: иначе четверо полевых стоят по своим зонам и между ними
  // остаётся по десять метров.
  let tx = p.home.x + (ball.x - PITCH_L / 2) * 0.55;
  let tz = p.home.z + (ball.z - PITCH_W / 2) * 0.60;

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
// В демо-режиме (открыта панель физики) обе команды ведёт ИИ, чтобы можно
// было наблюдать за игрой, а не играть.
function isHumanTeam(team) {
  if (autoPlay) return false;
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
        clampInsideBoards(a, PLR_R); clampInsideBoards(b, PLR_R);
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
    p.dive = null; p.holdT = 0;
  }
  ball.x = PITCH_L / 2; ball.z = PITCH_W / 2; ball.h = 0;
  ball.vx = 0; ball.vz = 0; ball.vh = 0; ball.owner = null; ball.cooldown = 0.25;
  ball.lastTeam = kickTeam;
  // Начинающая команда получает мяч: ставим её нападающего в центр
  // Начинает самый выдвинутый вперёд полевой игрок стартующей команды.
  const own = players.filter((p) => p.team === kickTeam && !p.isGK);
  const starter = own.reduce((a, b) =>
    (kickTeam === 0 ? b.home.x > a.home.x : b.home.x < a.home.x) ? b : a, own[0]);
  if (starter) { starter.x = PITCH_L / 2; starter.z = PITCH_W / 2 + 6; }
  camX = camClamp(PITCH_L / 2); // камера в центр без долгой прокрутки
  camZ = PITCH_W / 2;
  resetCharge();
}

/* Гол: розыгрыш не начинается сразу. Даём CELEBRATE_TIME на празднование —
   игрок бегает своим футболистом, забившая команда держит руки поднятыми,
   летят салюты, мяч лежит в сетке. Только потом центр поля. */
function scoreGoal(who) {
  if (who === "you") scoreYou++; else scoreCpu++;
  updateScoreHud();
  lastGoal = who;
  celebrateTeam = who === "you" ? 0 : 1;
  pendingKick = who === "you" ? 1 : 0;   // начинает пропустившая
  goalSeq++;
  goalAt = { side: ball.x <= PITCH_L / 2 ? 0 : 1, z: ball.z, h: ball.h };
  scorer = ball.lastTouch || activeOf[celebrateTeam];
  celebrate = CELEBRATE_TIME;
  ball.owner = null;   // скорость НЕ гасим: мяч должен влететь в сетку
  resetCharge();
}

/* Празднование: мяч не считаем, отборов нет, часы стоят. Забившая команда
   бежит к воротам, пропустившая возвращается по местам. Активным игроком
   по-прежнему управляет игрок. */
/* Пока идёт празднование, мяч живёт своей жизнью внутри ворот: влетает,
   гасится о сетку и укатывается. Иначе он замирал ровно на линии створа. */
function updateBallInNet(dt) {
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;
  ball.h += ball.vh * dt;
  ball.vh -= GRAV * dt;
  if (ball.h <= 0) {
    ball.h = 0;
    if (ball.vh < 0) ball.vh = -ball.vh * BOUNCE * 0.6;
    if (Math.abs(ball.vh) < 30) ball.vh = 0;
    const fr = Math.exp(-GROUND_FRICTION * 1.8 * dt);   // в сетке катится хуже
    ball.vx *= fr; ball.vz *= fr;
  } else {
    const fr = Math.exp(-AIR_FRICTION * dt);
    ball.vx *= fr; ball.vz *= fr;
  }
  // Ворота — коробочка за линией: задняя сетка, боковые сетки, линия ворот.
  const right = goalAt && goalAt.side === 1;
  const line = right ? PITCH_L : 0;
  const back = right ? PITCH_L + GOAL_DEPTH - BALL_R : -GOAL_DEPTH + BALL_R;
  // Сетка гасит почти всё: мяч должен остаться лежать в воротах, а не
  // выскочить обратно на площадку и замереть на линии створа.
  const NET_ABSORB = -0.06;
  const hitBack = right ? ball.x > back : ball.x < back;
  if (hitBack) {
    const speed = Math.abs(ball.vx);
    ball.x = back; ball.vx *= NET_ABSORB;
    // Волну пускаем именно здесь: мяч долетает до задней сетки на 1.6 м позже,
    // чем пересекает линию ворот, и качать её раньше — значит качать впустую.
    if (speed > 60) {
      netHitSeq++;
      netHitAt = { side: right ? 1 : 0, z: ball.z, h: ball.h, power: Math.min(1, speed / 900) };
    }
  }
  if (right) { if (ball.x < line + BALL_R) { ball.x = line + BALL_R; ball.vx *= NET_ABSORB; } }
  else { if (ball.x > line - BALL_R) { ball.x = line - BALL_R; ball.vx *= NET_ABSORB; } }
  const zLo = MOUTH_LO + BALL_R, zHi = MOUTH_HI - BALL_R;
  if (ball.z < zLo) { ball.z = zLo; ball.vz *= NET_ABSORB; }
  else if (ball.z > zHi) { ball.z = zHi; ball.vz *= NET_ABSORB; }
  if (ball.h > GOAL_DEPTH_H - BALL_R) { ball.h = GOAL_DEPTH_H - BALL_R; if (ball.vh > 0) ball.vh = 0; }
  if (hyp(ball.vx, ball.vz) < 4 && ball.h === 0) { ball.vx = 0; ball.vz = 0; }
}

function stepCelebrate(dt) {
  updateBallInNet(dt);
  for (const p of players) {
    if (p === activeOf[myTeam] && isHumanTeam(myTeam)) { userMove(p, dt); continue; }
    if (p.isGK) { moveTo(p, p.home.x, p.home.z, GK_SPEED * 0.5, dt); continue; }
    if (p.team === celebrateTeam) {
      // Убегают ОТ ворот к ближней бровке, а не толпятся в сетке: камера
      // держится на авторе гола, и упираться ей в сетку незачем.
      const side = goalAt && goalAt.side === 1 ? 1 : 0;
      const cx = PITCH_L * (side === 1 ? 0.70 : 0.30);
      const cz = PITCH_W * 0.24;
      if (p === scorer) moveTo(p, cx, cz, SPEED * 0.9, dt);
      else moveTo(p, scorer ? scorer.x : cx, (scorer ? scorer.z : cz) + (p.id % 2 ? 80 : -80), SPEED * 0.8, dt);
    } else {
      moveTo(p, p.home.x, p.home.z, SPEED * 0.5, dt);
    }
  }
  separatePlayers();
  followCamera(dt);
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
  } else if (state === "playing" && celebrate > 0) {
    // Празднование: часы стоят, физика мяча не считается
    F++;
    celebrate -= dt;
    if (celebrate <= 0) { celebrate = 0; kickoffReset(pendingKick); }
    else stepCelebrate(dt);
    if (netMode === "host") maybeSendSnapshot(dt);
  } else if (state === "playing") {
    F++;
    timeLeft -= dt;
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
    if (autoPlay || !active || ball.owner !== active) resetCharge();
    else {
      charge.t = Math.min(CHARGE_TIME, charge.t + dt);
      showPowerBar(charge.action, charge.t / CHARGE_TIME);
    }
  }

  // Мои действия (в демо-режиме игрок не вмешивается)
  if (autoPlay) actionQueue.length = 0;
  else while (actionQueue.length) applyAction(actionQueue.shift(), myTeam);
  // Действия соперника, пришедшие по сети (только у хоста)
  if (netMode === "host") {
    while (remote.queue.length) applyAction(remote.queue.shift(), 1 - myTeam);
  }

  // Ход всех игроков
  for (const p of players) {
    if (isFrozen(p)) { p.vx = 0; p.vz = 0; continue; }
    if (p === activeOf[0] && isHumanTeam(0)) userMove(p, dt);
    else if (p === activeOf[1] && isHumanTeam(1)) userMove(p, dt);
    else if (ball.owner === p) aiWithBall(p, dt);
    else aiControl(p, dt);
  }

  // Мяч
  if (!ball.owner) updateFreeBall(dt);
  resolvePossession(dt);
  if (ball.owner) glueBall();
  if (checkGoal()) return;   // гол перезапускает розыгрыш

  separatePlayers();

  followCamera(dt);
  updateClock();
  if (netMode === "host") maybeSendSnapshot(dt);
}

// Камера едет за мячом по длине поля (плавно) и мягко следит по ширине.
// Вызывается и хостом, и гостем — гость ведёт её по присланному мячу.
function followCamera(dt) {
  // Камера едет за мячом по длине и мягко следует по ширине: площадка Rush
  // слишком велика, чтобы держать её в кадре целиком.
  // В празднование камера ведёт автора гола, а не мяч в сетке.
  const focus = (celebrate > 0 && scorer) ? scorer : ball;
  const target = camClamp(focus.x, celebrate > 0);
  camX += (target - camX) * Math.min(1, 2.6 * dt);
  const tz = clamp(focus.z, PITCH_W * 0.12, PITCH_W * 0.88);
  camZ += (tz - camZ) * Math.min(1, 2.0 * dt);
}

function updateClock() {
  const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
  el.clock.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* =========================================================================
   Сеть: хост шлёт снимки состояния, гость шлёт ввод и рисует присланное
   ========================================================================= */
const SNAP_HZ = 30, INPUT_HZ = 30;
let snapAcc = 0, inputAcc = 0, lastSnapAt = 0;
// В коробке возобновлений из аута нет — поле осталось только для совместимости
// протокола снимков с прошлой версией и всегда равно нулю.
const RESTART_TEXT = [""];
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
  const bdt = lastSnapAt ? (performance.now() - lastSnapAt) / 1000 : 0;
  if (bdt > 0.005 && bdt < 0.5 && ball.tx != null) {
    ball.evx = (a[4] - ball.tx) / bdt; ball.evz = (a[5] - ball.tz) / bdt;
  } else { ball.evx = 0; ball.evz = 0; }
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

  // Скорость, подразумеваемая разницей между снимками — по ней экстраполируем
  // движение между приходами пакетов, иначе картинка дёргается.
  const now = performance.now();
  const dtSnap = lastSnapAt ? (now - lastSnapAt) / 1000 : 0;
  lastSnapAt = now;
  const good = dtSnap > 0.005 && dtSnap < 0.5;

  let k = 14;
  for (const p of players) {
    const nx = a[k++], nz = a[k++];
    if (good && p.tx != null) { p.evx = (nx - p.tx) / dtSnap; p.evz = (nz - p.tz) / dtSnap; }
    else { p.evx = 0; p.evz = 0; }
    p.tx = nx; p.tz = nz;
  }
  updateScoreHud();
}

// Гость не считает физику. Чужих игроков ведём к присланным позициям, между
// снимками экстраполируя по последней известной скорости. Своего игрока
// двигаем локально (предсказание) и лишь мягко подтягиваем к позиции хоста —
// иначе управление ощущается с задержкой на круг «ввод → хост → снимок».
function smoothToTargets(dt) {
  const k = Math.min(1, 18 * dt);
  const decay = Math.exp(-3 * dt);   // экстраполяция затухает, если пакеты пропали
  const own = activeOf[myTeam];

  for (const p of players) {
    if (p.tx == null) continue;
    p.evx = (p.evx || 0) * decay; p.evz = (p.evz || 0) * decay;
    p.tx += p.evx * dt; p.tz += p.evz * dt;

    if (p === own) {
      // Свой игрок уже сдвинут локально — только гасим расхождение с хостом.
      const err = hyp(p.tx - p.x, p.tz - p.z);
      const kk = err > 140 ? 1 : Math.min(1, 3 * dt); // сильно разошлись — притянуть сразу
      p.x += (p.tx - p.x) * kk;
      p.z += (p.tz - p.z) * kk;
      continue;
    }

    const ox = p.x, oz = p.z;
    p.x += (p.tx - p.x) * k;
    p.z += (p.tz - p.z) * k;
    p.vx = dt > 0 ? (p.x - ox) / dt : 0;
    p.vz = dt > 0 ? (p.z - oz) / dt : 0;
    const sp = hyp(p.vx, p.vz);
    if (sp > 10) { p.dirx = p.vx / sp; p.dirz = p.vz / sp; p.runPhase += sp * dt * 0.06; }
  }

  // Мяч у своего игрока — ведём локально, чтобы дриблинг не отставал.
  if (own && ball.owner === own) {
    glueBall();
  } else if (ball.tx != null) {
    ball.evx = (ball.evx || 0) * decay; ball.evz = (ball.evz || 0) * decay;
    ball.tx += ball.evx * dt; ball.tz += ball.evz * dt;
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
  // Предсказание: свой игрок реагирует на джойстик сразу, не дожидаясь хоста.
  const own = activeOf[myTeam];
  if (own && state === "playing") {
    const v = inputVector();
    moveActor(own, v.x, v.z, sprintHeld() ? SPRINT : SPEED, dt);
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
    // Длительность матча выбирает хост — у гостя она только для показа часов
    // до первого снимка, дальше время приходит в снимках.
    if (typeof m.secs === "number") setMatchMinutes(m.secs / 60, false);
    // Прячем лобби; само состояние матча приедет со снимками.
    el.overlay.classList.remove("show");
    if (el.netPanel) el.netPanel.hidden = true;
  }
}

function setStateFromNet(st) {
  state = st;
  if (st === "playing" || st === "intro") {
    hideMenu();
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
    celebrating: celebrate > 0, celebrateTeam, netHitSeq, netHitAt,
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
  } else if (celebrate > CELEBRATE_TIME - 2.5) {
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
    if (celebrate > CELEBRATE_TIME - 0.8) {
      el.flash.style.opacity = String(Math.min(0.28, (celebrate - (CELEBRATE_TIME - 0.8)) * 0.35));
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
   Меню: главный экран и экран заданий
   ========================================================================= */
const TASKS = [
  { kicker: "тренировка", title: "Точный удар", desc: "Забей 5 мячей в верхний угол с линии штрафной.", reward: "+250 очков" },
  { kicker: "матч",       title: "Сухой матч",  desc: "Проведи матч и не пропусти ни одного гола.",      reward: "+400 очков" },
  { kicker: "дриблинг",   title: "Обводка",     desc: "Пройди защитника трижды за один тайм.",          reward: "+300 очков", lockBadge: "уровень 14" },
  { kicker: "командное",  title: "Пас в разрез", desc: "Сделай 3 голевые передачи за матч.",             reward: "+500 очков", lockBadge: "уровень 16" },
];
const TASKS_UNLOCKED = 2;

function renderTasks() {
  if (!el.mCards) return;
  el.mCards.innerHTML = TASKS.map((t, i) => {
    const locked = i >= TASKS_UNLOCKED;
    const badge = locked ? (t.lockBadge || "закрыто") : "доступно";
    const badgeStyle = locked
      ? "color:rgba(255,255,255,0.75);background:rgba(255,255,255,0.14)"
      : "color:#221803;background:linear-gradient(150deg,#FFE9A8,#E0AE48)";
    return `
      <div class="mcard">
        <div class="mcard-img">Картинка задания
          ${locked ? '<div class="mcard-veil"></div>' : ""}
          <div class="mcard-badge" style="${badgeStyle}">${badge}</div>
        </div>
        <div class="mcard-body" style="opacity:${locked ? 0.5 : 1}">
          <div>
            <div class="mcard-kicker">${t.kicker}</div>
            <h3 class="mcard-title">${t.title}</h3>
            <p class="mcard-desc">${t.desc}</p>
          </div>
          <div class="mcard-foot">
            <div class="mcard-reward">${t.reward}</div>
            <div class="mcard-cta" style="color:${locked ? "rgba(255,255,255,0.35)" : "#fff"}">${locked ? "Закрыто" : "Начать"}</div>
          </div>
        </div>
      </div>`;
  }).join("");
}

/* =========================================================================
   Длительность матча. Задаётся в минутах перед стартом — на экране заданий
   и в лобби сетевой игры (там её выбирает хост, гостю значение приезжает
   вместе с командой «начали»). Выбор запоминается между запусками.
   ========================================================================= */
const matchLenInputs = Array.from(document.querySelectorAll(".matchmin"));

function setMatchMinutes(v, save) {
  const n = Number(v);
  matchMinutes = isFinite(n) ? clamp(Math.round(n * 2) / 2, MATCH_MIN_LO, MATCH_MIN_HI) : MATCH_MIN_DEF;
  MATCH_SECONDS = Math.round(matchMinutes * 60);
  matchLenInputs.forEach((i) => { i.value = String(matchMinutes); });
  if (save) { try { localStorage.setItem("matchMin", String(matchMinutes)); } catch (_) {} }
}

function loadMatchMinutes() {
  let v = MATCH_MIN_DEF;
  try { const raw = localStorage.getItem("matchMin"); if (raw != null) v = parseFloat(raw); } catch (_) {}
  setMatchMinutes(v, false);
}

matchLenInputs.forEach((inp) => {
  // Клик по полю не должен запускать матч — экран заданий стартует по клику куда угодно.
  ["click", "pointerdown", "touchstart"].forEach((ev) =>
    inp.addEventListener(ev, (e) => e.stopPropagation()));
  // Правим значение по ходу набора, но выравниваем по шагу только когда закончили,
  // иначе «15» не набрать: «1» тут же превратилось бы в минимум.
  inp.addEventListener("input", () => {
    const n = parseFloat(inp.value);
    if (isFinite(n) && n >= MATCH_MIN_LO && n <= MATCH_MIN_HI) {
      matchMinutes = n; MATCH_SECONDS = Math.round(n * 60);
    }
  });
  inp.addEventListener("change", () => { setMatchMinutes(inp.value, true); inp.blur(); });
  inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") inp.blur(); });
});
if (el.mLen) ["click", "pointerdown", "touchstart"].forEach((ev) =>
  el.mLen.addEventListener(ev, (e) => e.stopPropagation()));

// Кнопки ± — на телефоне так быстрее, чем вызывать клавиатуру.
document.querySelectorAll(".mlen-step").forEach((b) =>
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    setMatchMinutes(matchMinutes + parseFloat(b.dataset.d), true);
  }));

loadMatchMinutes();

function showMenu() {
  state = "menu";
  if (el.menuUI) { el.menuUI.classList.add("show"); el.menuUI.classList.remove("tasks"); }
  el.overlay.classList.remove("show");
  if (el.netPanel) el.netPanel.hidden = true;
  document.body.classList.remove("playing");
  fitMenuStage();
}
function hideMenu() { if (el.menuUI) el.menuUI.classList.remove("show"); }

if (el.mPlay) el.mPlay.addEventListener("click", () => el.menuUI.classList.add("tasks"));
if (el.mBack) el.mBack.addEventListener("click", (e) => {
  e.stopPropagation();                       // чтобы не сработал старт матча
  el.menuUI.classList.remove("tasks");
});
// Пока любое место на экране заданий начинает матч.
if (el.mTasks) el.mTasks.addEventListener("click", () => { hideMenu(); startMatch(); });

renderTasks();
if (el.mVersion) el.mVersion.textContent = "v" + APP_VERSION;

/* =========================================================================
   Потоки: меню / матч / итог
   ========================================================================= */
function startMatch() {
  scoreYou = 0; scoreCpu = 0; timeLeft = MATCH_SECONDS; celebrate = 0; F = 0;
  goalAt = null; scorer = null; netHitAt = null;
  updateScoreHud();
  const mm = Math.floor(MATCH_SECONDS / 60), ss = MATCH_SECONDS % 60;
  el.clock.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  kickoffReset(0);
  active = null; activeOf[0] = activeOf[1] = null;
  remote.queue.length = 0; remote.vec = { x: 0, z: 0 }; remote.sprint = false;
  ensureAudio();
  introT = 0; introWhistled = false;
  state = "intro";
  hideMenu();
  el.overlay.classList.remove("show");
  if (el.netPanel) el.netPanel.hidden = true;
  document.body.classList.remove("playing"); // геймпад скрыт во время заставки
  if (netMode === "host") Net.send({ t: "start", secs: MATCH_SECONDS });
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
    `<b style="font-size:20px">${title}</b><br />Счёт ${mine} : ${theirs}`;
  el.startBtn.textContent = "В меню";
  el.overlay.classList.add("show");
}

el.startBtn.addEventListener("click", () => {
  if (netMode === "guest") { leaveNet(); return; }
  showMenu();
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
  applyFreezeOpp(freezeOpp, false);   // в сетевой игре режим недоступен
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
  if (!el.netPanel || !multiplayerAllowed()) return;
  const url = new URL(location.href);
  const fromUrl = (url.searchParams.get("room") || "").toUpperCase();
  el.netCodeInput.value = fromUrl || Net.makeCode();
  el.netPanel.hidden = false;
  el.netGo.hidden = false;
  el.netStart.hidden = true;
  el.netCopy.hidden = true;
  if (el.netLenRow) el.netLenRow.hidden = true;   // длительность выбирает только хост
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
      if (el.netLenRow) el.netLenRow.hidden = false;
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
  showMenu();
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

// На чужих площадках сетевой игры нет — прячем кнопку.
if (!multiplayerAllowed()) {
  if (el.netBtn) el.netBtn.hidden = true;
} else if (new URL(location.href).searchParams.get("room")) {
  // Пришли по ссылке с кодом — сразу открываем лобби.
  setTimeout(openNetPanel, 100);
}

if (!window.matchMedia("(display-mode: standalone)").matches) {
  el.installHint.hidden = false;
}

Scene3D.init(canvas, { PITCH_L, PITCH_W, GOAL_HALF, MOUTH_LO, MOUTH_HI,
                       CORNER_R, BOARD_H, GOAL_H: GOAL_DEPTH_H });
loadCamSettings();
loadPhys();
buildPhysUI();
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
