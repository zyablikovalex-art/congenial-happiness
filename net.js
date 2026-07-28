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

  let impl = null;
  let role = null;                  // 'host' | 'guest'
  let connected = false;
  const handlers = { message: null, open: null, close: null, status: null };

  function emit(name, arg) { const h = handlers[name]; if (h) h(arg); }
  function status(text) { emit("status", text); }

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
      let settled = false;

      // Пытаемся занять имя комнаты — кто занял, тот хост.
      const host = new Peer(roomId, { debug: 0 });

      host.on("open", () => {
        if (settled) return;
        settled = true; role = "host";
        status("Ожидание соперника…");
        host.on("connection", (conn) => {
          conn.on("open", () => { connected = true; emit("open"); });
          conn.on("data", (d) => emit("message", d));
          conn.on("close", () => { connected = false; emit("close"); });
          resolveWith(conn);
        });
        resolve({
          send(obj) { if (activeConn && activeConn.open) activeConn.send(obj); },
          close() { try { host.destroy(); } catch (_) {} },
        });
      });

      let activeConn = null;
      function resolveWith(conn) { activeConn = conn; }

      host.on("error", (err) => {
        if (settled) return;
        if (err && err.type === "unavailable-id") {
          // Комната уже занята — значит хост есть, подключаемся гостем.
          settled = true; role = "guest";
          try { host.destroy(); } catch (_) {}
          status("Подключение к сопернику…");
          const guest = new Peer({ debug: 0 });
          guest.on("open", () => {
            const conn = guest.connect(roomId, { reliable: false });
            conn.on("open", () => { activeConn = conn; connected = true; emit("open"); });
            conn.on("data", (d) => emit("message", d));
            conn.on("close", () => { connected = false; emit("close"); });
            conn.on("error", () => { status("Не удалось соединиться"); });
          });
          guest.on("error", (e) => status("Ошибка сети: " + (e && e.type ? e.type : "")));
          resolve({
            send(obj) { if (activeConn && activeConn.open) activeConn.send(obj); },
            close() { try { guest.destroy(); } catch (_) {} },
          });
        } else {
          reject(err);
        }
      });
    });
  }

  /* ------------------------------ API ------------------------------------ */
  return {
    // transport: 'peerjs' | 'local'
    connect(code, transport) {
      role = null; connected = false;
      const p = transport === "local" ? localTransport(code) : peerTransport(code);
      return p.then((t) => { impl = t; return role; });
    },
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
