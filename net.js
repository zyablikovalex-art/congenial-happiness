"use strict";
/* =========================================================================
   Net — тонкий сетевой слой поверх сменного транспорта.

   Роли определяются автоматически: оба игрока открывают одну ссылку с кодом
   комнаты, кто первым «захватил» имя комнаты — тот host, второй — guest.

   Транспорты:
     peerjs — P2P между устройствами через публичный брокер PeerJS;
     local  — BroadcastChannel между вкладками одного браузера (для проверки
              и для игры вдвоём на одном компьютере).
   Наружу оба отдают один и тот же интерфейс, игра о транспорте не знает.
   ========================================================================= */
window.Net = (function () {
  const PREFIX = "mfb3d-";          // префикс, чтобы не пересечься с чужими комнатами
  const CLAIM_WAIT = 400;           // мс ожидания ответа хоста при захвате комнаты

  const OPEN_TIMEOUT = 12000;       // мс ожидания ответа брокера
  const CONN_TIMEOUT = 18000;       // мс ожидания прямого канала между устройствами

  // Публичные STUN-серверы: чем больше, тем выше шанс пробить NAT.
  const ICE = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
  };

  let impl = null;
  let role = null;                  // 'host' | 'guest'
  let connected = false;
  const handlers = { message: null, open: null, close: null, status: null, log: null };
  const logBuf = [];

  function emit(name, arg) { const h = handlers[name]; if (h) h(arg); }
  function status(text) { emit("status", text); }

  // Журнал соединения — виден в панели, чтобы можно было понять, где встало.
  function log(line) {
    const t = Math.round(performance.now() / 100) / 10;
    const s = t + "s  " + line;
    logBuf.push(s);
    if (logBuf.length > 40) logBuf.shift();
    try { console.log("[net]", line); } catch (_) {}
    emit("log", logBuf.join("\n"));
  }

  /* ---------------- Транспорт: BroadcastChannel (одна машина) ------------- */
  function localTransport(code) {
    const chan = new BroadcastChannel(PREFIX + code);
    const myId = String(Math.floor(performance.now() * 1000) % 1e9) + "-" + (performance.now() | 0);
    let claimed = false, decided = false, peerSeen = false;

    return new Promise((resolve, reject) => {
      const finish = (r) => {
        if (decided) return;
        decided = true;
        role = r;
        resolve({
          send(obj) { chan.postMessage({ t: "d", from: myId, d: obj }); },
          close() { try { chan.postMessage({ t: "bye", from: myId }); chan.close(); } catch (_) {} },
        });
      };

      chan.onmessage = (e) => {
        const m = e.data;
        if (!m || m.from === myId) return;
        if (m.t === "claim") {
          peerSeen = true;
          if (claimed) chan.postMessage({ t: "host-here", from: myId });   // я уже хост
          else if (!decided && m.from < myId) finishGuest();                // меньший id — хост
        } else if (m.t === "host-here") {
          if (!decided) finishGuest();
        } else if (m.t === "hello") {
          peerSeen = true;
          if (role === "host") { connected = true; emit("open"); }
        } else if (m.t === "d") {
          if (!connected) { connected = true; emit("open"); }
          emit("message", m.d);
        } else if (m.t === "bye") {
          connected = false; emit("close");
        }
      };

      function finishGuest() {
        finish("guest");
        chan.postMessage({ t: "hello", from: myId });
        connected = true;
        setTimeout(() => emit("open"), 0);
      }

      chan.postMessage({ t: "claim", from: myId });
      status("Подключение…");
      setTimeout(() => {
        if (decided) return;
        claimed = true;
        finish("host");
        status("Ожидание соперника…");
      }, CLAIM_WAIT);
    });
  }

  /* ---------------- Транспорт: PeerJS (разные устройства) ---------------- */
  function peerTransport(code) {
    const roomId = PREFIX + code;
    return new Promise((resolve, reject) => {
      if (typeof Peer === "undefined") { reject(new Error("PeerJS не загружен")); return; }
      let settled = false, activeConn = null, peer = null;
      log("комната " + roomId + ", пробую занять имя (стать хостом)");

      const openTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        log("брокер не ответил за " + (OPEN_TIMEOUT / 1000) + "с");
        reject(new Error("брокер PeerJS не отвечает — возможно, сеть его блокирует"));
      }, OPEN_TIMEOUT);

      function attach(conn, who) {
        activeConn = conn;
        let opened = false;
        const t = setTimeout(() => {
          if (opened) return;
          log("канал не открылся за " + (CONN_TIMEOUT / 1000) + "с — похоже, NAT не пробился");
          status("Прямое соединение не установилось. Попробуйте, чтобы оба устройства были в одной сети Wi-Fi.");
        }, CONN_TIMEOUT);
        conn.on("open", () => {
          opened = true; clearTimeout(t);
          connected = true; log("канал открыт (" + who + ")"); emit("open");
        });
        conn.on("data", (d) => emit("message", d));
        conn.on("close", () => { connected = false; log("канал закрыт"); emit("close"); });
        conn.on("error", (e) => log("ошибка канала: " + (e && e.type ? e.type : e)));
      }

      const api = {
        send(obj) { if (activeConn && activeConn.open) activeConn.send(obj); },
        close() { try { if (peer) peer.destroy(); } catch (_) {} },
      };

      // 1) Пытаемся занять имя комнаты — кто занял, тот хост.
      peer = new Peer(roomId, Object.assign({ debug: 0 }, { config: ICE }));

      peer.on("open", () => {
        if (settled) return;
        settled = true; clearTimeout(openTimer); role = "host";
        log("имя занято — я ХОСТ, жду соперника");
        status("Ожидание соперника…");
        peer.on("connection", (conn) => { log("соперник постучался"); attach(conn, "хост"); });
        resolve(api);
      });

      peer.on("disconnected", () => log("связь с брокером потеряна, переподключаюсь"));
      peer.on("error", (err) => {
        const type = (err && err.type) || "unknown";
        log("ошибка: " + type);

        if (!settled && type === "unavailable-id") {
          // 2) Имя занято — значит хост уже есть, идём гостем.
          settled = true; clearTimeout(openTimer); role = "guest";
          try { peer.destroy(); } catch (_) {}
          log("комната занята — я ГОСТЬ, подключаюсь к хосту");
          status("Подключение к сопернику…");

          peer = new Peer(Object.assign({ debug: 0 }, { config: ICE }));
          const guestTimer = setTimeout(() => {
            log("брокер не выдал свой id за " + (OPEN_TIMEOUT / 1000) + "с");
            status("Брокер не отвечает. Проверьте интернет и попробуйте снова.");
          }, OPEN_TIMEOUT);

          peer.on("open", (id) => {
            clearTimeout(guestTimer);
            log("свой id получен, соединяюсь с " + roomId);
            attach(peer.connect(roomId, { reliable: true }), "гость");
          });
          peer.on("error", (e) => {
            const t2 = (e && e.type) || "unknown";
            log("ошибка гостя: " + t2);
            if (t2 === "peer-unavailable") {
              status("Хост не найден. Проверьте код комнаты — или пусть соперник подключится первым.");
            } else {
              status("Ошибка сети: " + t2);
            }
          });
          resolve(api);
          return;
        }

        if (!settled) {
          settled = true; clearTimeout(openTimer);
          reject(new Error(type));
        } else {
          status("Ошибка сети: " + type);
        }
      });
    });
  }

  /* ------------------------------ API ------------------------------------ */
  return {
    // transport: 'peerjs' | 'local'
    connect(code, transport) {
      role = null; connected = false; logBuf.length = 0;
      log("транспорт: " + (transport === "local" ? "вкладки (BroadcastChannel)" : "PeerJS"));
      const p = transport === "local" ? localTransport(code) : peerTransport(code);
      return p.then((t) => { impl = t; return role; });
    },
    get logText() { return logBuf.join("\n"); },
    send(obj) { if (impl) impl.send(obj); },
    close() {
      if (impl) { try { impl.close(); } catch (_) {} }
      impl = null; connected = false; role = null;
    },
    on(name, fn) { handlers[name] = fn; },
    get role() { return role; },
    get connected() { return connected; },
    // Короткий код комнаты из 4 символов (без похожих букв).
    makeCode() {
      const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let s = "";
      for (let i = 0; i < 4; i++) {
        const r = Math.floor((performance.now() * (i + 7) * 9301 + 49297) % A.length);
        s += A[r];
      }
      return s;
    },
  };
})();
