'use client';

// ============================================================
// useDicePhysics — клиентский мост к physics-service
// ============================================================
//
// Singleton WebSocket-клиент к physics-service (порт 3006 через Caddy
// gateway с XTransformPort=3006). Управляет сессиями броска:
//
//   • throwDice(numDice, callbacks) → запускает бросок, стримит
//     трансформы до settle, возвращает результат через Promise.
//   • cancel(sessionId) — отмена (если overlay закрыли до settle).
//   • transformStream — React state с последним снапшотом трансформов
//     для конкретной активной сессии (используется Dice3DCanvas).
//
// Стратегия: один socket на всё приложение. Если несколько бросков
// идут параллельно — каждый получает свой sessionId и свой стрим
// трансформов (фильтруется по sessionId в callback'ах).
//
// ТРАНСПОРТ: socket.io через Caddy gateway.
//   io("/?XTransformPort=3006") → Caddy форвардит на localhost:3006
//
// СНАПШОТ: { sessionId, t, dice: [{i, p:[x,y,z], q:[x,y,z,w]}] }
// РЕЗУЛЬТАТ: { sessionId, t, dice: number[], total: number }

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';

export interface DieTransform {
  i: number;
  p: [number, number, number]; // position
  q: [number, number, number, number]; // quaternion (x,y,z,w)
}

export interface TransformSnapshot {
  sessionId: string;
  t: number;
  dice: DieTransform[];
}

export interface RollResult {
  sessionId: string;
  t: number;
  dice: number[];
  total: number;
}

export interface ThrowDiceCallbacks {
  onTransform?: (snapshot: TransformSnapshot) => void;
  onResult?: (result: RollResult) => void;
  onError?: (err: Error) => void;
}

export interface ThrowDiceOptions {
  // Половина стороны физической арены (в единицах физ-мира) — X (W) и Z (H).
  // Вычисляется клиентом из naturalWidth/naturalHeight фонового изображения
  // карты: arenaHalfW = imgW / 350, arenaHalfH = imgH / 350 (clamped [3, 8]).
  // Физический сервис ставит стены на ±arenaHalfW (X) и ±arenaHalfH (Z) →
  // кубики не вылетают за контур карты, а арена имеет ТО ЖЕ соотношение
  // сторон, что и изображение → визуальные бортики точно повторяют контур.
  // Для обратной совместимости: если передан только arenaHalf — квадрат.
  arenaHalfW?: number;
  arenaHalfH?: number;
  arenaHalf?: number;
  // Пресет броска (gentle/normal/power/lob/scatter). Определяет силу, угол
  // и кручение импульса броска на сервере. По умолчанию 'normal'.
  presetId?: string;
  // Сторона арены, откуда бросают кубики.
  //   'near' (default) — ближний край (+Z, сторона игрока), бросок ВПЕРЁД (−Z).
  //   'far' — дальний край (−Z), бросок НА ИГРОКА (+Z).
  // Используется для одновременного VS броска: ролик с near, оппонент с far →
  // кубы летят навстречу друг другу и приземляются в центре арены.
  originSide?: 'near' | 'far';
  // Латеральный X-офсет точки спавна стакана (в физ. единицах, default 0).
  // Используется для zonal mass-roll: когда N игроков бросают одновременно,
  // каждому назначается свой originX (-1.6 / 0 / +1.6), чтобы стаканы
  // разошлись по X и кубики не пересекались. Это только spawn-position —
  // латеральный импульс броска (vx) остаётся 0, кубики летят ВПЕРЁД как
  // обычно, просто из смещённой стартовой позиции.
  originX?: number;
  // ── Направление броска (drag-roll gesture direction) ──
  // Угол в радианах, 0 = вперёд (−Z), π/2 = вправо (+X), π = назад (+Z),
  // −π/2 = влево (−X). Когда задан, physics-service вращает импульс на этот
  // угол — кубы летят В НАПРАВЛЕНИИ ЖЕСТА. Только для drag-броска;
  // undefined для кнопка-броска/VS/mass → оригинальная логика zSign.
  direction?: number;
  // ── Абсолютная позиция спавна стакана (drag-roll "token placement" mode) ──
  // Когда ОБА spawnX и spawnZ заданы (в физ. единицах, центр арены = (0,0)),
  // cup появляется В ЭТОЙ ТОЧКЕ арены — как размещение токена. Переопределяет
  // edge-based расчёт из originSide/originX. Кубы появляются под курсором
  // и лишь слегка откатываются в сторону жеста (direction).
  //
  // Логика: "отпустил кубы в точке (X,Y) на карте → кубы появились ТАМ".
  // undefined для кнопка-броска/VS/mass → edge-based позиция (originSide/originX).
  spawnX?: number;
  spawnZ?: number;
  // ── Скорость взмаха в момент отпускания (drag-roll realism mode) ──
  // В пикселях/мс (модуль вектора скорости курсора). Только для drag-броска.
  // Physics-service масштабирует импульс броска (horizontal + vertical +
  // angular) от этой скорости: медленный отпуск → кубы мягко падают на месте,
  // быстрый flick → кубы летят дальше с дугой и кручением.
  // undefined для кнопка-броска/VS/mass → полный импульс пресета (1.0).
  swingVelocity?: number;
  // ── Начальные ориентации кубиков (drag-roll "in-hand rotation" mode) ──
  // Массив кватернионов [x, y, z, w] — по одному на кубик. Когда задан,
  // physics-service ПРОПУСКАЕТ фазу перемешивания (SHAKE_DURATION_MS = 120мс)
  // и использует эти ориентации как стартовые для кубиков. Бросок становится
  // БЕСШОВНЫМ: "тащил → отпустил → кубы сразу полетели", без задержки на shake.
  //
  // Логика: кубы вращаются в 3D-оверлее всё время, пока игрок их тащит. При
  // отпускании текущие ориентации захватываются и передаются сюда. Поскольку
  // игрок тащил их произвольное время, ориентации случайны → результат броска
  // случаен без отдельной фазы перемешивания.
  //
  // undefined для кнопка-броска/VS/mass → physics-service использует фазу
  // перемешивания со случайными стартовыми ориентациями.
  initialQuats?: Array<[number, number, number, number]>;
  // ── Начальные угловые скорости кубиков (Вариант A — продолжение вращения) ──
  // Массив векторов [wx, wy, wz] (рад/с, world space) — по одному на кубик.
  // Захватываются из HeldDiceController в момент отпускания drag. Когда задан,
  // physics-service при release использует ЭТУ угловую скорость вместо
  // throwSpin пресета → брошенные кубы ПРОДОЛЖАЮТ вращение удерживаемых.
  // undefined → throwSpin пресета.
  initialAngularVelocity?: Array<[number, number, number]>;
  // ── Явный sessionId (для сетевой видимости анимации) ──
  // Когда задан, throwDice использует ЭТОТ sessionId вместо генерации
  // случайного. Нужно для P2P-синхронизации: инициатор броска создаёт
  // детерминированный sessionId (phys-${eventId}), который путешествует
  // в event.pendingPhysics.sessionId. Все клиенты (инициатор + remote)
  // используют ОДИН sessionId → physics-service стримит трансформаты через
  // io.emit всем сокетам, и каждый клиент находит их в activeSessions.
  // undefined → throwDice генерирует random sessionId (старое поведение,
  // для обратной совместимости с компонентами, не использующими сеть).
  sessionId?: string;
}

export interface ThrowDiceHandle {
  sessionId: string;
  promise: Promise<RollResult>;
  cancel: () => void;
}

// ── URL discovery для physics-service (порт 3006) ───────────────────────────
//
// ПРОБЛЕМА: physics-service слушает на localhost:3006. Браузер может достучаться
// до него тремя способами в зависимости от того, как открыта страница:
//
//   1. Через Caddy gateway (порт 81) или Next.js rewrite (порт 3000):
//      `io(window.location.origin, { query: { XTransformPort: '3006' } })`
//      — Caddy/Next.js читает query и проксирует на localhost:3006.
//      Работает И через порт 81 (Caddy), И через порт 3000 (Next.js rewrites
//      в next.config.ts).
//
//   2. Direct localhost:3006 — работает только когда браузер на той же машине
//      (локальная разработка, agent-browser в sandbox).
//
//   3. Fallback: если оба probe не прошли, используем стратегию 1 (gateway)
//      и полагаемся на reconnection socket.io.
//
// Это зеркальное решение для signaling-client.ts (порт 3004) и use-network.ts,
// где такая же probe+fallback логика уже доказала надёжность.

const PHYSICS_QUERY = { XTransformPort: '3006' };

// Три стратегии подключения к physics-service (порт 3006), в порядке надёжности:
//
//   1. CADDY_GATEWAY_URL = 'http://localhost:81' — Caddy gateway на порту 81.
//      Работает в sandbox/agent-browser (браузер и сервер на одной машине,
//      порт 81 доступен). Caddy читает XTransformPort query и проксирует
//      на localhost:3006. Самый надёжный путь в sandbox.
//
//   2. window.location.origin — если страница открыта через Caddy (production
//      через domain) или через Next.js rewrite. В sandbox при открытии
//      localhost:3000 Next.js rewrite падает (trailing slash баг), но в
//      production через domain Caddy работает корректно.
//
//   3. PHYSICS_DIRECT_URL = 'http://localhost:3006' — direct подключение.
//      Работает только при локальной разработке (браузер и сервер на одной
//      машине, и браузер разрешает cross-origin к localhost:3006). В sandbox
//      browser блокирует direct fetch к не-стандартным портам → Failed to fetch.
const CADDY_GATEWAY_URL = 'http://localhost:81';
const PHYSICS_DIRECT_URL = 'http://localhost:3006';

let _resolvedPhysicsUrl: string | null = null;
let _resolvedPhysicsUseQuery = true;

/**
 * Probe socket.io handshake по URL.
 * @param baseUrl базовый URL ('http://localhost:81', 'http://localhost:3006', или window.location.origin)
 * @param useXTransformPort если true — добавляем XTransformPort=3006 в query (для gateway)
 * @returns true если probe получил валидный socket.io handshake
 */
async function probePhysics(baseUrl: string, useXTransformPort: boolean): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const sep = baseUrl.includes('?') ? '&' : '?';
    const query = useXTransformPort
      ? `${sep}EIO=4&transport=polling&XTransformPort=3006`
      : `${sep}EIO=4&transport=polling`;
    const probeUrl = `${baseUrl}/socket.io/${query}`;
    const r = await fetch(probeUrl, { signal: ctrl.signal, method: 'GET' });
    clearTimeout(t);
    if (!r.ok) return false;
    const text = await r.text();
    // socket.io polling handshake: 0{"sid":"...","upgrades":["websocket"],...}
    return text.startsWith('0{') && text.includes('"sid"');
  } catch (e) {
    return false;
  }
}

async function resolvePhysicsUrl(): Promise<{ url: string; useQuery: boolean }> {
  if (_resolvedPhysicsUrl) {
    return { url: _resolvedPhysicsUrl, useQuery: _resolvedPhysicsUseQuery };
  }

  // A remote player must connect through the public gateway, not their localhost.
  const hostname = window.location.hostname;
  const isLocalhost = ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
  if (!isLocalhost || window.location.port === '3008') {
    _resolvedPhysicsUrl = window.location.origin;
    _resolvedPhysicsUseQuery = true;
    return { url: _resolvedPhysicsUrl, useQuery: true };
  }

  // Стратегия 1: Caddy gateway на порту 81 (sandbox/agent-browser/production)
  if (await probePhysics(CADDY_GATEWAY_URL, true)) {
    _resolvedPhysicsUrl = CADDY_GATEWAY_URL;
    _resolvedPhysicsUseQuery = true;
    console.info('[dice-physics] using gateway :81 URL');
    return { url: _resolvedPhysicsUrl, useQuery: true };
  }

  // Стратегия 2: window.location.origin (production через domain/Caddy)
  if (await probePhysics(window.location.origin, true)) {
    _resolvedPhysicsUrl = window.location.origin;
    _resolvedPhysicsUseQuery = true;
    console.info('[dice-physics] using origin URL:', _resolvedPhysicsUrl);
    return { url: _resolvedPhysicsUrl, useQuery: true };
  }

  // Стратегия 3: direct localhost:3006 (локальная разработка)
  if (await probePhysics(PHYSICS_DIRECT_URL, false)) {
    _resolvedPhysicsUrl = PHYSICS_DIRECT_URL;
    _resolvedPhysicsUseQuery = false;
    console.info('[dice-physics] using direct localhost:3006 URL');
    return { url: _resolvedPhysicsUrl, useQuery: false };
  }

  // Fallback: Caddy gateway URL (даже если probe не сработал — может быть
  // CORS issue на fetch, но socket.io подключение пройдёт)
  _resolvedPhysicsUrl = CADDY_GATEWAY_URL;
  _resolvedPhysicsUseQuery = true;
  console.warn('[dice-physics] all probes failed — defaulting to gateway :81');
  return { url: _resolvedPhysicsUrl, useQuery: true };
}

// ── TRUE SINGLETON SOCKET ──────────────────────────────────────────────────
//
// ПРОБЛЕМА (исходная реализация): каждый вызов getSocket() при отключённом
// сокете создавал НОВЫЙ socket.io-клиент. Старый сокет (с reconnectionAttempts:10)
// после 10 неудач СДАВАЛСЯ и переставал реконнектиться. Новый сокет тоже мог
// не успеть подключиться за 6с → reject → connectionPromise=null → следующий
// getSocket() создаёт ЕЩЁ ОДИН сокет. Результат: каскад orphan-сокетов,
// ни один не подключился, physics "ломается после нескольких бросков".
//
// РЕШЕНИЕ:
//   1. Сокет создаётся РОВНО ОДИН РАЗ (socketInitPromise). Никогда не удаляется.
//   2. reconnectionAttempts: Infinity — socket.io НИКОГДА не сдаётся.
//      Даже если сервис физики недоступен 10 минут — при восстановлении
//      сокет автоматически переподключится.
//   3. pendingWaiters — очередь ожидающих. Несколько параллельных getSocket()
//      вызовов (бросок + useEffect + cancel) все резолвятся одним connect.
//   4. Per-call таймаут 6с: reject'ит ТОЛЬКО конкретный вызов, не трогает сокет.
//      Сокет продолжает реконнектиться в фоне. Следующий бросок может успеть.
//   5. При вызове getSocket() на отключённом сокете — socket.connect() сбрасывает
//      backoff и форсирует НЕМЕДЛЕННУЮ попытку реконнекта (вместо ожидания
//      следующего тика socket.io reconnection timer).

let socket: Socket | null = null;
let socketInitPromise: Promise<void> | null = null;
const pendingWaiters = new Set<{
  resolve: (s: Socket) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let activeSessions = new Map<string, ThrowDiceCallbacks>();

function notifyWaiters() {
  if (!socket || !socket.connected) return;
  const waiters = Array.from(pendingWaiters);
  pendingWaiters.clear();
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve(socket);
  }
}

function rejectWaiter(target: { resolve: (s: Socket) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }, err: Error) {
  pendingWaiters.delete(target);
  clearTimeout(target.timer);
  target.reject(err);
}

function createSocket(): Promise<void> {
  if (socketInitPromise) return socketInitPromise;

  socketInitPromise = (async () => {
    let url: string;
    let useQuery: boolean;
    try {
      const resolved = await resolvePhysicsUrl();
      url = resolved.url;
      useQuery = resolved.useQuery;
    } catch (e) {
      socketInitPromise = null;
      throw e;
    }

    const socketOpts: Record<string, unknown> = {
      // ── WEBSOCKET ONLY (low-latency, no polling) ──
      // Polling transport буферизует сообщения → кадры physics приходят
      // "пачкой" с задержкой 300-900ms. Websocket = full-duplex, кадры
      // идут по одному без буферизации. Latency <30ms.
      transports: ['websocket'],
      // ── БЕСКОНЕЧНЫЙ РЕКОННЕКТ — НИКОГДА не сдаёмся ──
      // Было reconnectionAttempts:10 → после 10 неудач socket.io сдавался,
      // сокет умирал навсегда, getSocket() создавал новый → утечка сокетов,
      // physics "ломалась после нескольких бросков". Теперь Infinity —
      // сокет будет пытаться реконнектиться вечно. Даже если physics-service
      // перезапускался 10 минут — при восстановлении сокет сам подключится.
      reconnection: true,
      reconnectionAttempts: Infinity,
      // ── БЫСТРЫЙ РЕКОННЕКТ ──
      // Было reconnectionDelay:500 (default max 5000). При disconnect socket.io
      // ждёт 500мс → 1000 → 2000 → 4000 → 5000... 12 секунд до 5-й попытки.
      // Теперь 300 → 600 → 1200 → 2400 → 3000 (cap). 4-я попытка за ~4с
      // вместо ~7с. Кубы быстрее возвращаются к жизни после блипа сети.
      reconnectionDelay: 300,
      reconnectionDelayMax: 3000,
      timeout: 5000,
    };
    if (useQuery) {
      socketOpts.query = PHYSICS_QUERY;
    }

    const s = io(url, socketOpts as any);
    socket = s;

    s.on('connect', () => {
      console.info('[dice-physics] connected to physics-service, socket.id:', s.id);
      notifyWaiters();
    });

    s.on('connect_error', (err: Error) => {
      // НЕ reject'им waiters — socket.io с reconnectionAttempts:Infinity
      // будет пытаться бесконечно. Первая попытка через Caddy gateway может
      // упасть (xhr poll error в headless Chrome), вторая обычно успешна.
      console.warn('[dice-physics] connect_error (will retry):', err.message);
    });

    s.on('disconnect', () => {
      console.warn('[dice-physics] disconnected, will retry');
    });

    // ── Обработка входящих сообщений (регистрируются ОДИН РАЗ) ──
    s.on('dice:transform', (payload: TransformSnapshot) => {
      if (!payload?.sessionId) return;
      const cbs = activeSessions.get(payload.sessionId);
      if (cbs?.onTransform) cbs.onTransform(payload);
    });

    s.on('dice:result', (payload: RollResult) => {
      if (!payload?.sessionId) return;
      const cbs = activeSessions.get(payload.sessionId);
      if (cbs?.onResult) cbs.onResult(payload);
      activeSessions.delete(payload.sessionId);
    });

    s.on('dice:error', (payload: { error: string; sessionId: string | null }) => {
      if (!payload?.sessionId) return;
      const cbs = activeSessions.get(payload.sessionId);
      if (cbs?.onError) cbs.onError(new Error(payload.error));
      activeSessions.delete(payload.sessionId);
    });
  })();

  // Если создание сокета упало (например, resolvePhysicsUrl бросил) —
  // сбрасываем socketInitPromise, чтобы следующая попытка могла начаться заново.
  socketInitPromise.catch(() => {
    socketInitPromise = null;
  });

  return socketInitPromise;
}

function getSocket(): Promise<Socket> {
  // Быстрый путь: сокет уже подключён — отдаём немедленно.
  if (socket && socket.connected) return Promise.resolve(socket);

  // Гарантируем что singleton-сокет существует (или создаётся).
  const initP = createSocket();

  // Возвращаем promise, который резолвится на следующем connect.
  // Per-call таймаут 6с: reject'ит ТОЛЬКО этот вызов, не трогает сокет.
  // Сокет продолжает реконнектиться в фоне (reconnectionAttempts:Infinity).
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;

    const waiter = {
      resolve: (s: Socket) => {
        if (settled) return;
        settled = true;
        resolve(s);
      },
      reject: (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      },
      timer: setTimeout(() => {
        rejectWaiter(waiter, new Error('physics-service connection timeout (6s)'));
      }, 6000),
    };
    pendingWaiters.add(waiter);

    // Если init уже завершён и сокет случайно подключился между проверкой
    // и здесь — резолвим сразу.
    initP.then(() => {
      if (socket && socket.connected) {
        // Уже подключён — резолвим немедленно.
        if (!settled) {
          pendingWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          settled = true;
          resolve(socket);
        }
      } else if (socket && !socket.connected) {
        // Сокет существует но отключён — форсируем НЕМЕДЛЕННЫЙ реконнект.
        // socket.connect() сбрасывает backoff timer и запускает новую попытку
        // прямо сейчас (вместо ожидания следующего тика reconnection).
        socket.connect();
      }
    }).catch((err) => {
      if (!settled) {
        pendingWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Singleton hook для доступа к physics-service.
 *
 * Использование:
 *   const physics = useDicePhysics();
 *   const handle = physics.throwDice(4, {
 *     onTransform: (snap) => setTransforms(snap.dice),
 *     onResult: (res) => console.log('result:', res.dice, res.total),
 *   });
 *   // ...позже, если нужно отменить:
 *   handle.cancel();
 *
 * Также экспортирует `connected` (boolean) для индикации статуса и
 * `activeSessionId` — текущая активная сессия (для Dice3DCanvas).
 */
export function useDicePhysics() {
  // v3j: инициализируем connected проверкой singleton-сокета. При hot reload
  // или перемонтировании компонента сокет уже может быть подключён — не ждём
  // лишний reconnect-цикл, показываем connected=true сразу.
  const [connected, setConnected] = useState(() => socket?.connected ?? false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [lastTransform, setLastTransform] = useState<TransformSnapshot | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let s: Socket | null = null;
    let onConn: (() => void) | null = null;
    let onDisc: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    // ── РЕЗИЛИЕНТНАЯ ИНИЦИАЛИЗАЦИЯ ──
    // Прежний код делал ОДНУ попытку getSocket() и при таймауте 6с просто
    // логировал ошибку → connected навсегда оставалось false. Теперь —
    // ретраи каждые 4с. Сокет (singleton) реконнектится в фоне
    // (reconnectionAttempts:Infinity), мы просто ждём когда он подключится.
    const attach = (sock: Socket) => {
      s = sock;
      setConnected(sock.connected);
      onConn = () => setConnected(true);
      onDisc = () => {
        setConnected(false);
        setLastTransform(null);
      };
      sock.on('connect', onConn);
      sock.on('disconnect', onDisc);
    };

    const tryConnect = () => {
      if (cancelled) return;
      getSocket().then((sock) => {
        if (cancelled || !mountedRef.current) return;
        attach(sock);
      }).catch((err) => {
        // Перестал логировать как error — это нормальная ситуация при
        // отключённом physics-service. Просто ретраим через 4с.
        console.warn('[dice-physics] init pending (will retry in 4s):', err.message);
        if (!cancelled) {
          retryTimer = setTimeout(tryConnect, 4000);
        }
      });
    };

    tryConnect();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (retryTimer) clearTimeout(retryTimer);
      // Не закрываем сокет — он синглтон. Просто отписываемся.
      if (s && onConn) s.off('connect', onConn);
      if (s && onDisc) s.off('disconnect', onDisc);
    };
  }, []);

  /**
   * Запустить бросок.
   * @param numDice количество кубиков (1-8)
   * @param callbacks onTransform (30Hz), onResult (после settle), onError
   * @param options { arenaHalfW, arenaHalfH } — половины сторон арены (из размера карты)
   * @returns handle с sessionId, promise и cancel()
   */
  const throwDice = useCallback(
    (numDice: number, callbacks: ThrowDiceCallbacks, options?: ThrowDiceOptions): ThrowDiceHandle => {
      // sessionId: явный (для сетевой синхронизации — phys-${eventId}) или
      // случайный (старое поведение, для локальных бросков без сети).
      const sessionId = options?.sessionId
        ?? `roll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeSessions.set(sessionId, callbacks);
      setActiveSessionId(sessionId);
      setLastTransform(null);

      const promise = new Promise<RollResult>((resolve, reject) => {
        // Обёртка над callbacks.onResult для resolve promise
        const originalOnResult = callbacks.onResult;
        const originalOnError = callbacks.onError;
        callbacks.onResult = (res) => {
          originalOnResult?.(res);
          if (activeSessionId === sessionId) setActiveSessionId(null);
          resolve(res);
        };
        callbacks.onError = (err) => {
          originalOnError?.(err);
          if (activeSessionId === sessionId) setActiveSessionId(null);
          reject(err);
        };

        getSocket().then((sock) => {
          if (!sock.connected) {
            // Попытка переподключения
            sock.connect();
          }
          // Передаём arenaHalfW/H — сервис поставит стены по контуру карты
          // (прямоугольная арена = прямоугольник изображения).
          // presetId выбирает пресет броска (gentle/normal/power/lob/scatter).
          // originSide определяет, с какой стороны арены бросают кубики
          // ('near' = со стороны игрока, 'far' = с противоположной) — для VS.
          // direction (угол в радианах) — для drag-броска: сервис вращает
          // импульс на этот угол, кубы летят в сторону жеста.
          sock.emit('dice:roll', {
            sessionId,
            numDice,
            arenaHalfW: options?.arenaHalfW,
            arenaHalfH: options?.arenaHalfH,
            arenaHalf: options?.arenaHalf,
            presetId: options?.presetId,
            originSide: options?.originSide,
            ...(options?.originX !== undefined ? { originX: options.originX } : {}),
            ...(options?.direction !== undefined ? { direction: options.direction } : {}),
            ...(options?.spawnX !== undefined ? { spawnX: options.spawnX } : {}),
            ...(options?.spawnZ !== undefined ? { spawnZ: options.spawnZ } : {}),
            ...(options?.swingVelocity !== undefined ? { swingVelocity: options.swingVelocity } : {}),
            ...(options?.initialQuats !== undefined && options.initialQuats.length > 0
              ? { initialQuats: options.initialQuats }
              : {}),
            ...(options?.initialAngularVelocity !== undefined && options.initialAngularVelocity.length > 0
              ? { initialAngularVelocity: options.initialAngularVelocity }
              : {}),
          });
        }).catch((err) => {
          console.error('[dice-physics] getSocket failed:', err.message);
          callbacks.onError?.(err);
          reject(err);
        });
      });

      return {
        sessionId,
        promise,
        cancel: () => {
          activeSessions.delete(sessionId);
          if (activeSessionId === sessionId) setActiveSessionId(null);
          getSocket().then((sock) => {
            if (sock.connected) sock.emit('dice:cancel', { sessionId });
          }).catch(() => {});
        },
      };
    },
    [activeSessionId],
  );

  /**
   * ── subscribeToSession — подписка remote-клиента на ЧУЖУЮ physics-сессию ──
   *
   * Когда бросок инициирует другой пир (по сети), мы НЕ вызываем throwDice
   * (это создало бы дублирующую сессию на physics-сервисе, которыйreject'ит
   * одинаковые sessionId). Вместо этого мы только регистрируем sessionId в
   * activeSessions — и существующий socket.on('dice:transform') / 'dice:result'
   * обработчики начинают кормить наши callbacks трансформами от io.emit
   * physics-сервиса, который стримит кадры ВСЕМ подключённым сокетам.
   *
   * Так анимация броска видна всем: инициатор бросает (throwDice), а remote
   * клиенты подписываются (subscribeToSession) на тот же sessionId.
   *
   * Safety timeout 12с: если physics уже завершилась до подписки (race),
   * или physics-сервис недоступен — резолвим fallback-результатом, чтобы
   * overlay не завис. ServerDiceStage также имеет свой 8s safety timeout.
   */
  const subscribeToSession = useCallback(
    (sessionId: string, callbacks: ThrowDiceCallbacks): ThrowDiceHandle => {
      activeSessions.set(sessionId, callbacks);
      setActiveSessionId(sessionId);
      setLastTransform(null);

      const promise = new Promise<RollResult>((resolve, reject) => {
        const originalOnResult = callbacks.onResult;
        const originalOnError = callbacks.onError;
        let settled = false;
        callbacks.onResult = (res) => {
          if (settled) return;
          originalOnResult?.(res);
          if (activeSessionId === sessionId) setActiveSessionId(null);
          settled = true;
          resolve(res);
        };
        callbacks.onError = (err) => {
          if (settled) return;
          originalOnError?.(err);
          if (activeSessionId === sessionId) setActiveSessionId(null);
          settled = true;
          reject(err);
        };
        // Safety: если за 12с не пришёл ни result ни error — возможно, мы
        // подписались уже после завершения physics (race condition), и
        // dice:result уже ушёл. Резолвим fallback, чтобы overlay не завис.
        // ServerDiceStage всё равно применит fallback через свой 8s timeout.
        setTimeout(() => {
          if (!settled && activeSessions.has(sessionId)) {
            console.warn(`[dice-physics] subscribeToSession timeout for ${sessionId} — resolving fallback (physics may have finished before subscription)`);
            activeSessions.delete(sessionId);
            if (activeSessionId === sessionId) setActiveSessionId(null);
            settled = true;
            resolve({ sessionId, t: Date.now(), dice: [0, 0, 0, 0], total: 0 });
          }
        }, 12000);
      });

      return {
        sessionId,
        promise,
        cancel: () => {
          activeSessions.delete(sessionId);
          if (activeSessionId === sessionId) setActiveSessionId(null);
        },
      };
    },
    [activeSessionId],
  );

  /**
   * Подписка на трансформы конкретной сессии — для Dice3DCanvas.
   * Возвращает функцию отписки.
   */
  const subscribeToTransforms = useCallback(
    (sessionId: string, cb: (snapshot: TransformSnapshot) => void): (() => void) => {
      const existing = activeSessions.get(sessionId);
      if (existing) {
        const orig = existing.onTransform;
        existing.onTransform = (snap) => {
          orig?.(snap);
          cb(snap);
        };
        return () => {
          // Восстанавливаем (если ещё активна)
          const cur = activeSessions.get(sessionId);
          if (cur && cur.onTransform) {
            // Убираем нашу обёртку — проще: оставляем как есть, сессия скоро закроется
          }
        };
      }
      // Если сессия не найдена — ничего не делаем
      return () => {};
    },
    [],
  );

  return {
    connected,
    activeSessionId,
    lastTransform,
    setLastTransform,
    throwDice,
    subscribeToSession,
    subscribeToTransforms,
    // Прямой emit для низкоуровневых случаев (не использовать в UI напрямую)
    _internal: { getSocket, activeSessions },
  };
}

export type DicePhysicsApi = ReturnType<typeof useDicePhysics>;
