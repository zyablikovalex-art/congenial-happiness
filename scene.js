"use strict";
/* =========================================================================
   Scene3D — 3D-рендер (Three.js) для футбольного матча.
   Симуляция живёт в game.js в мировых координатах (x — длина, z — ширина,
   h — высота мяча). Здесь строим сцену и каждый кадр синхронизируем меши.
   Мир -> сцена:  tx = (x - L/2)*S,  ty = h*S,  tz = (z - W/2)*S
   ========================================================================= */
window.Scene3D = (function () {
  const T = window.THREE;
  const S = 0.02; // мир -> три единицы

  const RUNOFF = 420; // мировых единиц газона за каждой линией (видно, когда камера у бровки)

  // Настройки камеры (меняются из UI). angle — наклон к горизонту (0..90),
  // height — высота камеры в единицах сцены. Дистанция выводится из них.
  const camCfg = { angle: 40, height: 8.5 };
  // Смотрим почти на сам мяч, а не поверх голов — иначе он висит в нижней
  // трети кадра. Высота по умолчанию снижена так, чтобы дистанция
  // (height − CAM_LOOK_Y)/tan(angle) осталась прежней и поле не отъехало.
  const CAM_LOOK_Y = 0.3;      // высота точки, на которую смотрит камера в игре
  const CAM_LOOK_INTRO = 3.0;  // на заставке смотрим выше — видно трибуны и тоннель
  const CAM_AHEAD = 1.0;       // фокус чуть впереди мяча
  const CAM_MAX_DIST = 70;  // ограничение на очень пологих углах
  const BALL_R = 0.14;      // радиус мяча в единицах сцены (чисто визуальный)

  function setCamera(opts) {
    if (!opts) return;
    if (opts.angle != null) camCfg.angle = Math.max(0, Math.min(90, +opts.angle || 0));
    if (opts.height != null) camCfg.height = Math.max(3, Math.min(30, +opts.height || 0));
  }
  function getCamera() { return { angle: camCfg.angle, height: camCfg.height }; }

  let cfg, renderer, scene, camera;
  let L, W, halfL, halfW, MOUTH_LO, MOUTH_HI, GOAL_HALF;
  let groundHalfX, groundHalfZ; // половина размера газона в единицах сцены
  let ballMesh, ballGroup;
  let camLookY = CAM_LOOK_INTRO;   // сглаженная высота точки взгляда
  const playerMeshes = []; // индекс = id игрока
  let sceneTime = 0;

  // Фейерверки
  let fwPoints, fwPos, fwCol, fwParts = [], fwTimer = 0, fwSeed = 1;
  const FW_MAX = 900;
  const FW_COLORS = [
    [1.0, 0.88, 0.30], [1.0, 0.42, 0.42], [0.35, 0.78, 0.98],
    [0.49, 0.99, 0.6], [1.0, 1.0, 1.0], [1.0, 0.56, 0.42],
  ];

  const COL = {
    skin: 0xe8b48c, boot: 0x15171c,
    team: [
      { shirt: 0x2f7bff, shorts: 0xffffff, socks: 0x2f7bff },
      { shirt: 0xe8443c, shorts: 0x20232b, socks: 0xe8443c },
    ],
    gk: [
      { shirt: 0x2fbf71, shorts: 0x186b3f, socks: 0x2fbf71 },
      { shirt: 0xffcf40, shorts: 0x8a6a00, socks: 0xffcf40 },
    ],
  };

  function nr(n) { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); }
  function mat(color, rough) {
    return new T.MeshStandardMaterial({ color, roughness: rough == null ? 0.85 : rough, metalness: 0.0 });
  }

  // ---- Текстура газона (вид сверху) ----
  function pitchTexture() {
    const TW = 2560, TH = 2048;   // пропорция близка к газону с раннофом
    // Марджины пропорциональны RUNOFF, чтобы разметка ложилась ровно на
    // логические границы поля (0..L, 0..W), а за ними оставался газон.
    const Mx = TW * RUNOFF / (L + 2 * RUNOFF);
    const My = TH * RUNOFF / (W + 2 * RUNOFF);
    const c = document.createElement("canvas");
    c.width = TW; c.height = TH;
    const g = c.getContext("2d");
    const px = (wx) => Mx + (wx / L) * (TW - 2 * Mx);
    const py = (wz) => My + (wz / W) * (TH - 2 * My);
    const lx = (w) => (w / L) * (TW - 2 * Mx);   // длина по x в пикселях текстуры
    const lz = (w) => (w / W) * (TH - 2 * My);   // длина по z в пикселях текстуры
    // Толщина линий и точки задаются в мировых единицах: иначе при изменении
    // размера поля разметка становилась бы толще или тоньше относительно игроков.
    const LINE_W = 10, SPOT_R = 13;

    // Полосатый газон (вертикальные полосы вдоль длины)
    const stripes = 14;
    for (let i = 0; i < stripes; i++) {
      g.fillStyle = i % 2 ? "#2f9d4e" : "#279247";
      g.fillRect((i / stripes) * TW, 0, TW / stripes + 1, TH);
    }
    // Тёмная окантовка (за линиями — газон-раннофф уже нарисован полосами)
    g.strokeStyle = "rgba(255,255,255,0.92)";
    g.lineWidth = Math.max(2, lx(LINE_W));
    // Границы
    g.strokeRect(px(0), py(0), px(L) - px(0), py(W) - py(0));
    // Средняя линия
    g.beginPath(); g.moveTo(px(L / 2), py(0)); g.lineTo(px(L / 2), py(W)); g.stroke();
    // Центральный круг + точка
    g.beginPath();
    g.ellipse(px(L / 2), py(W / 2), lx(190), lz(190), 0, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = "#fff";
    g.beginPath(); g.arc(px(L / 2), py(W / 2), lx(SPOT_R), 0, Math.PI * 2); g.fill();
    // Штрафные + вратарские + точки пенальти
    const boxD = 300, boxHalf = 430, gaD = 110, gaHalf = 240, penX = 220;
    [0, 1].forEach((side) => {
      const s = side === 0 ? 1 : -1;
      const gx = side === 0 ? 0 : L;
      g.strokeRect(px(gx), py(W / 2 - boxHalf), s * (px(boxD) - px(0)), py(W / 2 + boxHalf) - py(W / 2 - boxHalf));
      g.strokeRect(px(gx), py(W / 2 - gaHalf), s * (px(gaD) - px(0)), py(W / 2 + gaHalf) - py(W / 2 - gaHalf));
      g.fillStyle = "#fff";
      g.beginPath(); g.arc(px(side === 0 ? penX : L - penX), py(W / 2), lx(SPOT_R * 0.85), 0, Math.PI * 2); g.fill();
    });

    const tex = new T.CanvasTexture(c);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
    tex.encoding = T.sRGBEncoding;
    return tex;
  }

  function crowdTexture() {
    const c = document.createElement("canvas");
    c.width = 256; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#181d27"; g.fillRect(0, 0, 256, 128);
    for (let y = 6; y < 128; y += 8) {
      for (let x = 4; x < 256; x += 7) {
        const v = nr(x * 1.7 + y * 3.1);
        const pal = ["#c94f4f", "#4f7fc9", "#e0c24f", "#57b06a", "#b8c0cc", "#d98a52"];
        g.fillStyle = pal[Math.floor(v * pal.length) % pal.length];
        g.globalAlpha = 0.5 + v * 0.5;
        g.fillRect(x, y, 4, 4);
      }
    }
    g.globalAlpha = 1;
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.repeat.set(10, 3);
    return tex;
  }

  function ballTexture() {
    const c = document.createElement("canvas");
    c.width = 128; c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 128, 128);
    g.fillStyle = "#1c1c1c";
    // несколько «пятиугольников»
    const spots = [[64, 40], [30, 80], [98, 80], [64, 112], [20, 30], [108, 34]];
    for (const [x, y] of spots) {
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        const r = 13;
        const xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(xx, yy); else g.lineTo(xx, yy);
      }
      g.closePath(); g.fill();
    }
    const tex = new T.CanvasTexture(c);
    tex.encoding = T.sRGBEncoding;
    return tex;
  }

  // ---- Человечек из примитивов ----
  function cyl(r1, r2, h, color) {
    const m = new T.Mesh(new T.CylinderGeometry(r1, r2, h, 6), mat(color));
    return m;
  }
  function makeLimb(len, r, color) {
    // группа с осью вращения сверху; меш свисает вниз
    const grp = new T.Group();
    const m = cyl(r, r * 0.9, len, color);
    m.position.y = -len / 2;
    grp.add(m);
    return grp;
  }

  function makePlayer(team, isGK) {
    const kit = isGK ? COL.gk[team] : COL.team[team];
    const g = new T.Group();
    const parts = {};

    const HIP = 0.72, THIGH = 0.36, SHIN = 0.34, TORSO = 0.52;
    const shoulderY = HIP + TORSO;

    // Тень-блоб
    const shadow = new T.Mesh(new T.CircleGeometry(0.34, 14),
      new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28 }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.012;
    g.add(shadow);

    // Кольцо активного игрока
    const ring = new T.Mesh(new T.RingGeometry(0.30, 0.40, 20),
      new T.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.95, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02; ring.visible = false;
    g.add(ring); parts.ring = ring;

    // Ноги (бедро = кожа, голень = гетры, бутса)
    function leg(sx) {
      const hip = new T.Group(); hip.position.set(sx, HIP, 0);
      const thigh = cyl(0.085, 0.08, THIGH, COL.skin); thigh.position.y = -THIGH / 2; hip.add(thigh);
      const knee = new T.Group(); knee.position.y = -THIGH;
      const shin = cyl(0.075, 0.06, SHIN, kit.socks); shin.position.y = -SHIN / 2; knee.add(shin);
      const boot = new T.Mesh(new T.BoxGeometry(0.13, 0.08, 0.26), mat(COL.boot, 0.6));
      boot.position.set(0, -SHIN - 0.02, 0.07); knee.add(boot);
      hip.add(knee);
      g.add(hip);
      return { hip, knee };
    }
    const L1 = leg(-0.12), R1 = leg(0.12);
    parts.legL = L1.hip; parts.kneeL = L1.knee;
    parts.legR = R1.hip; parts.kneeR = R1.knee;

    // Шорты
    const shorts = new T.Mesh(new T.BoxGeometry(0.4, 0.24, 0.28), mat(kit.shorts));
    shorts.position.y = HIP + 0.04; g.add(shorts);

    // Торс (футболка)
    const torso = new T.Mesh(new T.BoxGeometry(0.42, TORSO, 0.26), mat(kit.shirt));
    torso.position.y = HIP + TORSO / 2 + 0.06; g.add(torso);
    // небольшие «плечи»
    const shoulders = new T.Mesh(new T.BoxGeometry(0.5, 0.14, 0.28), mat(kit.shirt));
    shoulders.position.y = shoulderY + 0.02; g.add(shoulders);

    // Руки
    function arm(sx) {
      const sh = new T.Group(); sh.position.set(sx, shoulderY + 0.02, 0);
      const up = cyl(0.055, 0.05, 0.3, kit.shirt); up.position.y = -0.15; sh.add(up);
      const elbow = new T.Group(); elbow.position.y = -0.3;
      const fore = cyl(0.05, 0.045, 0.28, COL.skin); fore.position.y = -0.14; elbow.add(fore);
      sh.add(elbow);
      g.add(sh);
      return sh;
    }
    parts.armL = arm(-0.3); parts.armR = arm(0.3);

    // Шея + голова
    const neck = cyl(0.05, 0.05, 0.08, COL.skin); neck.position.y = shoulderY + 0.12; g.add(neck);
    const head = new T.Mesh(new T.SphereGeometry(0.16, 12, 10), mat(COL.skin, 0.7));
    head.position.y = shoulderY + 0.3; g.add(head);
    // волосы
    const hair = new T.Mesh(new T.SphereGeometry(0.165, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      mat(0x2a1c12, 0.9));
    hair.position.y = shoulderY + 0.31; g.add(hair);

    parts.bodyBits = [shorts, torso, shoulders, neck, head, hair];
    g.userData.parts = parts;
    return g;
  }

  // ---- Ворота ----
  function makeGoal(gx, faceIn) {
    const grp = new T.Group();
    const white = mat(0xffffff, 0.5);
    const zLo = (MOUTH_LO - W / 2) * S, zHi = (MOUTH_HI - W / 2) * S;
    const H = 2.2, R = 0.07, depth = 0.9 * faceIn;
    const tx = (gx - L / 2) * S;
    // стойки
    [zLo, zHi].forEach((z) => {
      const post = new T.Mesh(new T.CylinderGeometry(R, R, H, 10), white);
      post.position.set(tx, H / 2, z); grp.add(post);
      const backPost = new T.Mesh(new T.CylinderGeometry(R * 0.7, R * 0.7, H, 8), white);
      backPost.position.set(tx + depth, H / 2, z); grp.add(backPost);
    });
    // перекладина
    const bar = new T.Mesh(new T.CylinderGeometry(R, R, zHi - zLo, 10), white);
    bar.rotation.x = Math.PI / 2; bar.position.set(tx, H, (zLo + zHi) / 2); grp.add(bar);
    // сетка (полупрозрачные плоскости)
    const netMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, side: T.DoubleSide });
    const back = new T.Mesh(new T.PlaneGeometry(zHi - zLo, H), netMat);
    back.position.set(tx + depth, H / 2, (zLo + zHi) / 2); back.rotation.y = Math.PI / 2; grp.add(back);
    const top = new T.Mesh(new T.PlaneGeometry(zHi - zLo, Math.abs(depth)), netMat);
    top.position.set(tx + depth / 2, H, (zLo + zHi) / 2); top.rotation.x = Math.PI / 2; grp.add(top);
    return grp;
  }

  // ---- Трибуны ----
  // Четыре наклонённые назад стены-«чаши», вынесенные за газон, чтобы камера,
  // опускаясь к ближней бровке, не упиралась в них.
  function makeStands() {
    const grp = new T.Group();
    const standMat = new T.MeshStandardMaterial({ map: crowdTexture(), roughness: 1, side: T.DoubleSide });
    const H = 9, TILT = 0.42, GAP = 1.2;
    const ex = groundHalfX + GAP, ez = groundHalfZ + GAP;

    function wall(width, x, z, yaw) {
      const m = new T.Mesh(new T.PlaneGeometry(width, H), standMat);
      m.rotation.order = "YXZ";       // сперва наклон, затем разворот
      m.rotation.y = yaw;
      m.rotation.x = TILT;
      m.position.set(x, H * 0.5 * Math.cos(TILT), z);
      return m;
    }
    grp.add(wall(ex * 2 + 4, 0, -ez, 0));            // ближняя (за нижней бровкой)
    grp.add(wall(ex * 2 + 4, 0, ez, Math.PI));       // дальняя
    grp.add(wall(ez * 2 + 4, -ex, 0, Math.PI / 2));  // левая (за воротами)
    grp.add(wall(ez * 2 + 4, ex, 0, -Math.PI / 2));  // правая
    return grp;
  }

  // ---- Тоннель ----
  function makeTunnel() {
    const grp = new T.Group();
    const dark = mat(0x0a0d12, 1);
    const tz = (W / 2 - W / 2) * 0 + (W - W / 2) * S; // дальняя бровка
    const tx = 0;
    const box = new T.Mesh(new T.BoxGeometry(2.4, 1.2, 1.2), dark);
    box.position.set(tx, 0.6, (W / 2) * S + 0.6);
    grp.add(box);
    const mouth = new T.Mesh(new T.PlaneGeometry(1.6, 1.0),
      new T.MeshBasicMaterial({ color: 0x02040a }));
    mouth.position.set(tx, 0.55, (W / 2) * S + 0.01);
    grp.add(mouth);
    return grp;
  }

  // ---- Фейерверки ----
  function initFireworks() {
    const geo = new T.BufferGeometry();
    fwPos = new Float32Array(FW_MAX * 3);
    fwCol = new Float32Array(FW_MAX * 3);
    geo.setAttribute("position", new T.BufferAttribute(fwPos, 3));
    geo.setAttribute("color", new T.BufferAttribute(fwCol, 3));
    geo.setDrawRange(0, 0);
    const m = new T.PointsMaterial({
      size: 0.28, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, blending: T.AdditiveBlending, sizeAttenuation: true,
    });
    fwPoints = new T.Points(geo, m);
    fwPoints.frustumCulled = false;
    scene.add(fwPoints);
  }
  function spawnBurst() {
    const cx = -22 + nr(fwSeed * 2.3 + 1) * 44;
    const cy = 8 + nr(fwSeed * 3.7 + 2) * 7;
    const cz = -10 + nr(fwSeed * 4.9 + 3) * 26;
    const col = FW_COLORS[Math.floor(nr(fwSeed * 5.1) * FW_COLORS.length) % FW_COLORS.length];
    const n = 24 + Math.floor(nr(fwSeed * 1.9) * 14);
    for (let i = 0; i < n && fwParts.length < FW_MAX; i++) {
      const a = nr(fwSeed * 7.7 + i) * Math.PI * 2;
      const b = nr(fwSeed * 9.3 + i) * Math.PI - Math.PI / 2;
      const sp = 1.4 + nr(fwSeed * 6.1 + i) * 2.2;
      fwParts.push({
        x: cx, y: cy, z: cz,
        vx: Math.cos(a) * Math.cos(b) * sp,
        vy: Math.sin(b) * sp + 0.6,
        vz: Math.sin(a) * Math.cos(b) * sp,
        life: 0.8 + nr(fwSeed * 2.2 + i) * 0.7, max: 1.5,
        r: col[0], g: col[1], b: col[2],
      });
    }
    fwSeed++;
  }
  function updateFireworks(dt, active) {
    fwTimer -= dt;
    if (active && fwTimer <= 0) { spawnBurst(); fwTimer = 0.28 + nr(fwSeed * 1.3) * 0.3; }
    let n = 0;
    for (let i = fwParts.length - 1; i >= 0; i--) {
      const p = fwParts[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy -= 2.6 * dt; p.life -= dt;
      if (p.life <= 0) { fwParts.splice(i, 1); continue; }
    }
    for (let i = 0; i < fwParts.length; i++) {
      const p = fwParts[i], k = Math.max(0, p.life / p.max);
      fwPos[n * 3] = p.x; fwPos[n * 3 + 1] = p.y; fwPos[n * 3 + 2] = p.z;
      fwCol[n * 3] = p.r * k; fwCol[n * 3 + 1] = p.g * k; fwCol[n * 3 + 2] = p.b * k;
      n++;
    }
    fwPoints.geometry.setDrawRange(0, n);
    fwPoints.geometry.attributes.position.needsUpdate = true;
    fwPoints.geometry.attributes.color.needsUpdate = true;
    fwPoints.visible = n > 0;
  }

  // ---- Инициализация ----
  function init(canvasEl, config) {
    cfg = config;
    L = cfg.PITCH_L; W = cfg.PITCH_W; GOAL_HALF = cfg.GOAL_HALF;
    MOUTH_LO = cfg.MOUTH_LO; MOUTH_HI = cfg.MOUTH_HI;
    halfL = (L / 2) * S; halfW = (W / 2) * S;
    groundHalfX = (L / 2 + RUNOFF) * S;
    groundHalfZ = (W / 2 + RUNOFF) * S;

    renderer = new T.WebGLRenderer({ canvas: canvasEl, antialias: true, powerPreference: "high-performance" });
    // Ограничиваем pixel ratio: на телефонах с DPR 3 это в разы меньше пикселей => выше FPS.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputEncoding = T.sRGBEncoding;

    scene = new T.Scene();
    scene.background = new T.Color(0x74a9dc);
    scene.fog = new T.Fog(0x74a9dc, 70, 160);

    camera = new T.PerspectiveCamera(50, 1, 0.1, 300);

    // Свет
    scene.add(new T.HemisphereLight(0xbad7ff, 0x3f6a33, 0.95));
    const sun = new T.DirectionalLight(0xffffff, 0.75);
    sun.position.set(6, 14, 4);
    scene.add(sun);

    // Тёмная база под всем + газон с разметкой (шире поля на RUNOFF с каждой стороны)
    const base = new T.Mesh(new T.PlaneGeometry(groundHalfX * 2 + 8, groundHalfZ * 2 + 8), mat(0x1f6b39, 1));
    base.rotation.x = -Math.PI / 2; base.position.y = -0.02; scene.add(base);

    const pitch = new T.Mesh(new T.PlaneGeometry(groundHalfX * 2, groundHalfZ * 2),
      new T.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95 }));
    pitch.rotation.x = -Math.PI / 2;
    scene.add(pitch);

    scene.add(makeStands());
    scene.add(makeTunnel());
    scene.add(makeGoal(0, 1));
    scene.add(makeGoal(L, -1));

    // Мяч
    ballGroup = new T.Group();
    const ballShadow = new T.Mesh(new T.CircleGeometry(0.112, 16),
      new T.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.3 }));
    ballShadow.rotation.x = -Math.PI / 2; ballShadow.position.y = 0.012;
    ballGroup.add(ballShadow); ballGroup.userData.shadow = ballShadow;
    ballMesh = new T.Mesh(new T.SphereGeometry(BALL_R, 16, 12),
      new T.MeshStandardMaterial({ map: ballTexture(), roughness: 0.55 }));
    ballGroup.add(ballMesh);
    scene.add(ballGroup);

    initFireworks();
    resize();
  }

  function buildPlayers(players) {
    for (const p of players) {
      const g = makePlayer(p.team, p.isGK);
      playerMeshes[p.id] = g;
      scene.add(g);
    }
  }

  function resize() {
    if (!renderer) return;
    const w = renderer.domElement.clientWidth || window.innerWidth;
    const h = renderer.domElement.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  // ---- Обновление игрока ----
  function lerp(a, b, t) { return a + (b - a) * t; }
  function updatePlayer(g, p, active, playing) {
    const parts = g.userData.parts;
    const tx = (p.x - L / 2) * S, tz = (p.z - W / 2) * S;
    g.position.x = tx; g.position.z = tz;

    const spd = Math.hypot(p.vx, p.vz);
    const moving = spd > 12;
    // Ориентация по направлению
    const dl = Math.hypot(p.dirx, p.dirz) || 1;
    const yaw = Math.atan2(p.dirx / dl, p.dirz / dl);
    // плавный поворот
    let d = yaw - g.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    g.rotation.y += d * 0.25;

    const ph = p.runPhase;
    if (moving) {
      const amp = Math.min(1.1, 0.5 + spd / 130);
      parts.legL.rotation.x = Math.sin(ph) * amp;
      parts.legR.rotation.x = Math.sin(ph + Math.PI) * amp;
      parts.kneeL.rotation.x = Math.max(0, -Math.sin(ph)) * 1.2;
      parts.kneeR.rotation.x = Math.max(0, -Math.sin(ph + Math.PI)) * 1.2;
      parts.armL.rotation.x = Math.sin(ph + Math.PI) * amp * 0.7;
      parts.armR.rotation.x = Math.sin(ph) * amp * 0.7;
      g.position.y = Math.abs(Math.sin(ph)) * 0.05;
    } else {
      const s = Math.sin(sceneTime * 2 + p.id) * 0.05;
      parts.legL.rotation.x = lerp(parts.legL.rotation.x, 0, 0.2);
      parts.legR.rotation.x = lerp(parts.legR.rotation.x, 0, 0.2);
      parts.kneeL.rotation.x = lerp(parts.kneeL.rotation.x, 0.05, 0.2);
      parts.kneeR.rotation.x = lerp(parts.kneeR.rotation.x, 0.05, 0.2);
      parts.armL.rotation.x = lerp(parts.armL.rotation.x, s, 0.15);
      parts.armR.rotation.x = lerp(parts.armR.rotation.x, -s, 0.15);
      g.position.y = lerp(g.position.y, 0, 0.2);
    }
    parts.ring.visible = playing && active === p;
  }

  // ---- Кадр ----
  function render(gs, dt) {
    if (!renderer) return;
    sceneTime += dt;
    if (!playerMeshes.length) buildPlayers(gs.players);

    for (const p of gs.players) updatePlayer(playerMeshes[p.id], p, gs.active, gs.state === "playing");

    // Мяч
    const b = gs.ball;
    const bx = (b.x - L / 2) * S, bz = (b.z - W / 2) * S, by = b.h * S;
    ballGroup.position.set(bx, 0, bz);
    ballMesh.position.y = by + BALL_R;
    ballGroup.userData.shadow.material.opacity = Math.max(0.05, 0.3 - b.h * 0.002);
    const sc = Math.max(0.4, 1 - b.h * 0.004);
    ballGroup.userData.shadow.scale.set(sc, sc, sc);
    // качение
    ballMesh.rotation.x += b.vz * dt * S * 5;
    ballMesh.rotation.z -= b.vx * dt * S * 5;

    // Салюты во время заставки
    updateFireworks(dt, gs.state === "intro" && gs.introActive);

    // Камера: угол к горизонту и высота задаются настройками, дистанция
    // выводится из них (height / tan(angle)). Следит за мячом по X и Z.
    const ang = Math.max(3, Math.min(88, camCfg.angle)) * Math.PI / 180;
    const camY = Math.max(camCfg.height, CAM_LOOK_Y + 0.5);
    const horiz = Math.min((camY - CAM_LOOK_Y) / Math.tan(ang), CAM_MAX_DIST);

    const fx = (gs.camX - L / 2) * S;
    const fz = ((gs.camZ != null ? gs.camZ : W / 2) - W / 2) * S;
    const lookZ = fz + CAM_AHEAD;
    // Не заезжаем за газон/трибуны, когда камера опускается к ближней бровке.
    const cz = Math.max(lookZ - horiz, -(groundHalfZ - 1));

    // На заставке камера с того же места смотрит выше — в кадр попадают
    // тоннель, трибуны и салюты. К свистку взгляд плавно съезжает на мяч.
    const targetLook = gs.state === "intro" ? CAM_LOOK_INTRO : CAM_LOOK_Y;
    camLookY += (targetLook - camLookY) * Math.min(1, 2.5 * dt);

    camera.position.set(fx, camY, cz);
    camera.lookAt(fx, camLookY, lookZ);

    renderer.render(scene, camera);
  }

  return { init, resize, render, setCamera, getCamera };
})();
