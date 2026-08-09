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

  const RUNOFF = 130;   // асфальт вокруг коробки, «2.8 м»
  let CORNER_R, BOARD_H, GOAL_H;   // скругление углов, высота борта, высота ворот

  // Настройки камеры (меняются из UI). angle — наклон к горизонту (0..90),
  // height — высота камеры в единицах сцены. Дистанция выводится из них.
  // Камера едет за мячом. Высота задаёт, сколько площадки видно за раз:
  // 9.5 даёт около 32 м длины в кадре — как «Rush Broadcast», где план
  // ближе обычного, потому что площадка меньше.
  const camCfg = { angle: 40, height: 9.5 };
  // Смотрим почти на сам мяч, а не поверх голов — иначе он висит в нижней
  // трети кадра.
  const CAM_LOOK_Y = 0.3;      // высота точки, на которую смотрит камера в игре
  const CAM_LOOK_INTRO = 3.0;  // на заставке смотрим выше — видно калитку и сетку
  const CAM_AHEAD = 1.0;       // фокус чуть впереди мяча
  const CAM_MAX_DIST = 70;  // ограничение на очень пологих углах
  const BALL_R = 0.14;      // радиус мяча в единицах сцены (чисто визуальный)

  function setCamera(opts) {
    if (!opts) return;
    if (opts.angle != null) camCfg.angle = Math.max(0, Math.min(90, +opts.angle || 0));
    if (opts.height != null) camCfg.height = Math.max(3, Math.min(40, +opts.height || 0));
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

  /* Контур коробки: скруглённый прямоугольник в мировых координатах, обход по
     часовой. Прямые участки разбиты на точки, иначе в них нельзя вырезать
     проёмы под ворота. Тот же контур используют и покрытие, и борта, и сетка. */
  function boxOutline(inset, cornerSteps, straightSteps) {
    const r = Math.max(1, CORNER_R - inset);
    const x0 = inset, x1 = L - inset, z0 = inset, z1 = W - inset;
    const pts = [];
    const line = (ax, az, bx, bz) => {
      for (let i = 0; i < straightSteps; i++) {
        const t = i / straightSteps;
        pts.push([ax + (bx - ax) * t, az + (bz - az) * t]);
      }
    };
    const arc = (cx, cz, a0, a1) => {
      for (let i = 0; i < cornerSteps; i++) {
        const a = a0 + (a1 - a0) * (i / cornerSteps);
        pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
    };
    line(x0 + r, z0, x1 - r, z0);
    arc(x1 - r, z0 + r, -Math.PI / 2, 0);
    line(x1, z0 + r, x1, z1 - r);
    arc(x1 - r, z1 - r, 0, Math.PI / 2);
    line(x1 - r, z1, x0 + r, z1);
    arc(x0 + r, z1 - r, Math.PI / 2, Math.PI);
    line(x0, z1 - r, x0, z0 + r);
    arc(x0 + r, z0 + r, Math.PI, Math.PI * 1.5);
    return pts;
  }

  // Точка приходится на проём ворот? Там борта нет.
  function inMouth(x, z) {
    return (x < CORNER_R * 0.1 || x > L - CORNER_R * 0.1) && Math.abs(z - W / 2) < GOAL_HALF;
  }

  // ---- Текстура покрытия (вид сверху) ----
  function pitchTexture() {
    const TW = 2048, TH = 1024;
    // Марджины пропорциональны RUNOFF, чтобы разметка ложилась ровно на
    // границы коробки (0..L, 0..W), а за ними оставался асфальт двора.
    const Mx = TW * RUNOFF / (L + 2 * RUNOFF);
    const My = TH * RUNOFF / (W + 2 * RUNOFF);
    const c = document.createElement("canvas");
    c.width = TW; c.height = TH;
    const g = c.getContext("2d");
    const px = (wx) => Mx + (wx / L) * (TW - 2 * Mx);
    const py = (wz) => My + (wz / W) * (TH - 2 * My);
    const lx = (w) => (w / L) * (TW - 2 * Mx);
    const lz = (w) => (w / W) * (TH - 2 * My);
    // Мини-футбольная разметка, увеличенная в 1.59 раза вслед за площадкой
    // (46.86 ед на метр): линия 8 см, круг 4.8 м, штрафная — четверть круга
    // 9.6 м от стойки, точка пенальти 9.6 м, вторая отметка 15.9 м.
    const LINE_W = 5, CIRCLE_R = 224, AREA_R = 448, PEN_X = 448, PEN2_X = 746;
    const SPOT_R = 7;

    // Ломаная по мировым точкам — так круг на неквадратной текстуре
    // остаётся кругом в мире, а не превращается в эллипс.
    const stroke = (pts, close) => {
      g.beginPath();
      pts.forEach(([x, z], i) => (i ? g.lineTo(px(x), py(z)) : g.moveTo(px(x), py(z))));
      if (close) g.closePath();
      g.stroke();
    };
    const arcPts = (cx, cz, r, a0, a1, n) => {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n);
        out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
      }
      return out;
    };
    const spot = (x, z, r) => {
      g.beginPath(); g.ellipse(px(x), py(z), lx(r), lz(r), 0, 0, Math.PI * 2); g.fill();
    };

    // Асфальт двора, поверх — резиновое покрытие коробки
    g.fillStyle = "#3b3f45"; g.fillRect(0, 0, TW, TH);
    g.fillStyle = "#2b7a48";
    g.beginPath();
    boxOutline(0, 10, 1).forEach(([x, z], i) => (i ? g.lineTo(px(x), py(z)) : g.moveTo(px(x), py(z))));
    g.closePath(); g.fill();
    // Крошка: редкие точки, чтобы покрытие не выглядело заливкой
    for (let i = 0; i < 9000; i++) {
      const x = nr(i * 1.7) * TW, y = nr(i * 3.3 + 5) * TH;
      g.fillStyle = nr(i * 5.9) > 0.5 ? "rgba(255,255,255,0.045)" : "rgba(0,0,0,0.05)";
      g.fillRect(x, y, 3, 3);
    }

    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = Math.max(2, lx(LINE_W));
    g.lineJoin = "round";
    // Контур коробки, средняя линия, центральный круг
    stroke(boxOutline(0, 10, 1), true);
    stroke([[L / 2, 0], [L / 2, W]]);
    stroke(arcPts(L / 2, W / 2, CIRCLE_R, 0, Math.PI * 2, 48));
    g.fillStyle = "#fff";
    spot(L / 2, W / 2, SPOT_R);

    // Штрафная мини-футбола: две четверти круга от стоек, соединённые прямой
    [0, 1].forEach((side) => {
      const gx = side === 0 ? 0 : L;
      const s = side === 0 ? 1 : -1;                 // куда «внутрь» коробки
      const lo = W / 2 - GOAL_HALF, hi = W / 2 + GOAL_HALF;
      const a = side === 0 ? 0 : Math.PI;            // направление внутрь по x
      stroke([
        ...arcPts(gx, lo, AREA_R, a - Math.PI / 2 * s, a, 16),
        ...arcPts(gx, hi, AREA_R, a, a + Math.PI / 2 * s, 16),
      ]);
      g.fillStyle = "#fff";
      spot(gx + s * PEN_X, W / 2, SPOT_R);
      spot(gx + s * PEN2_X, W / 2, SPOT_R);
    });

    const tex = new T.CanvasTexture(c);
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
    tex.encoding = T.sRGBEncoding;
    return tex;
  }

  function fenceTexture() {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    g.strokeStyle = "rgba(214,228,238,0.9)";
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(-4, -4); g.lineTo(68, 68); g.moveTo(68, -4); g.lineTo(-4, 68);
    g.stroke();
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    return t;
  }

  /* Стенка по контуру коробки: борт или сетка. Строим одним мешем — полоса
     треугольников вдоль контура, поэтому десятки сегментов не превращаются
     в десятки вызовов отрисовки. Высоты — функции от мировой x, чтобы сетка
     за воротами была выше, чем по бокам. */
  function wallStrip(pts, yBottom, yTop, opts) {
    const skip = opts && opts.skipMouth;
    const tile = (opts && opts.tile) || 100;   // мировых единиц на клетку текстуры
    const pos = [], uv = [];
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u0 = run / tile, u1 = (run + seg) / tile;
      run += seg;
      if (skip && inMouth((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) continue;
      const ax = (a[0] - L / 2) * S, az = (a[1] - W / 2) * S;
      const bx = (b[0] - L / 2) * S, bz = (b[1] - W / 2) * S;
      const ay0 = yBottom(a[0]), by0 = yBottom(b[0]);
      const ay1 = yTop(a[0]), by1 = yTop(b[0]);
      const va = (ay1 - ay0) / S / tile, vb = (by1 - by0) / S / tile;
      pos.push(ax, ay0, az, bx, by0, bz, bx, by1, bz);
      uv.push(u0, 0, u1, 0, u1, vb);
      pos.push(ax, ay0, az, bx, by1, bz, ax, ay1, az);
      uv.push(u0, 0, u1, vb, u0, va);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    geo.computeVertexNormals();
    return geo;
  }

  // ---- Борта ----
  function makeBoards() {
    const grp = new T.Group();
    const pts = boxOutline(0, 14, 6);
    const hTop = BOARD_H * S, rail = hTop * 0.85;
    grp.add(new T.Mesh(wallStrip(pts, () => 0, () => rail, { skipMouth: true }),
      new T.MeshStandardMaterial({ color: 0x2f6fae, roughness: 0.8, side: T.DoubleSide })));
    grp.add(new T.Mesh(wallStrip(pts, () => rail, () => hTop, { skipMouth: true }),
      new T.MeshStandardMaterial({ color: 0xe8eef5, roughness: 0.6, side: T.DoubleSide })));
    return grp;
  }

  // ---- Сетка над бортами: по бокам «3 м», за воротами «5 м» ----
  function fenceTopY(wx) {
    const t = Math.min(1, Math.max(0, (Math.abs(wx - L / 2) / (L / 2) - 0.55) / 0.4));
    return (141 + t * t * (234 - 141)) * S;   // «3 м» по бокам, «5 м» за воротами
  }
  function makeFence() {
    const geo = wallStrip(boxOutline(0, 14, 6), () => BOARD_H * S, fenceTopY, { tile: 47 });
    return new T.Mesh(geo, new T.MeshBasicMaterial({
      map: fenceTexture(), transparent: true, opacity: 0.5,
      side: T.DoubleSide, depthWrite: false,
    }));
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
    // Ворота выступают за пределы коробки: сетка позади линии, а не на поле.
    const H = GOAL_H * S, R = 0.06, depth = -0.8 * faceIn;
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

  // ---- Калитка в дальнем борту (через неё команды выходят на заставке) ----
  function makeTunnel() {
    const grp = new T.Group();
    const w = 1.5, h = BOARD_H * S * 1.2, z = (W / 2) * S;
    const frame = new T.Mesh(new T.BoxGeometry(w, h, 0.1), mat(0xd8dee6, 0.6));
    frame.position.set(0, h / 2, z + 0.05);
    grp.add(frame);
    const mouth = new T.Mesh(new T.PlaneGeometry(w * 0.8, h * 0.78),
      new T.MeshBasicMaterial({ color: 0x1b2028 }));
    mouth.position.set(0, h * 0.42, z + 0.11);
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
    CORNER_R = cfg.CORNER_R; BOARD_H = cfg.BOARD_H; GOAL_H = cfg.GOAL_H;
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
    const base = new T.Mesh(new T.PlaneGeometry(groundHalfX * 2 + 60, groundHalfZ * 2 + 60), mat(0x3b3f45, 1));
    base.rotation.x = -Math.PI / 2; base.position.y = -0.02; scene.add(base);

    const pitch = new T.Mesh(new T.PlaneGeometry(groundHalfX * 2, groundHalfZ * 2),
      new T.MeshStandardMaterial({ map: pitchTexture(), roughness: 0.95 }));
    pitch.rotation.x = -Math.PI / 2;
    scene.add(pitch);

    scene.add(makeBoards());
    scene.add(makeFence());
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
    // Раньше камеру не пускали за газон, чтобы она не влезала в трибуны.
    // Трибун нет, а коробка маленькая: с этим ограничителем камера не могла
    // отъехать настолько, чтобы вся коробка попала в кадр.
    const cz = lookZ - horiz;

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
