/**
 * worker.mjs — minidev 执行器子进程
 *
 * 通过 stdin/stdout 的行式 JSON 协议与父进程(MCP 服务器)通信:
 *   请求: { id, op, args }
 *   响应: { id, ok, result } | { id, ok:false, error }
 *   事件: { id, stream: 'event', name, data }
 *
 * minidev 所有调用都在本进程内执行，其控制台噪音不会污染父进程的 MCP 流；
 * 本进程输出的每一行若无法解析为本协议信封，将被父进程安全忽略。
 */
import readline from 'node:readline';

// ---- minidev 导入（CJS 互操作：真实 API 位于 default 命名空间的 .minidev 字段）----
const mod = await import('minidev');
const ns = mod.default ?? mod;
const minidev = ns.minidev ?? ns;

try { ns.setSilent?.(true); } catch {}
try { ns.setSpinnerEnabled?.(false); } catch {}
try { ns.setLogLevelVerboseEnabled?.(false); } catch {}

/** 活动会话: devServer / remoteDebug / loginTask / webSimulator */
const sessions = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitEvent(id, name, data) {
  send({ id, stream: 'event', name, data });
}

function toError(e) {
  return {
    message: e?.message ?? String(e),
    code: e?.code,
    stack: e?.stack ? String(e.stack).split('\n').slice(0, 8).join('\n') : undefined,
  };
}

/** 统一参数裁剪：去掉 undefined，避免 minidev 内部误判；并剥离本协议的控制字段 */
function clean(obj = {}, { strip = ['sessionId', 'timeoutMs', 'caseLimit'] } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (strip.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** 安全 JSON 化：循环引用/大对象防护 */
function safeJson(value, depth = 0) {
  try {
    if (depth > 4) return '[depth-limit]';
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => safeJson(v, depth + 1));
    if (typeof value === 'function') return '[function]';
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('_')) continue;
      out[k] = safeJson(v, depth + 1);
    }
    return out;
  } catch {
    return '[unserializable]';
  }
}

// ---------------- 操作实现 ----------------

const ops = {
  /** 环境检查 */
  async 'env.check'() {
    const info = { node: process.version, minidev: undefined, platform: process.platform };
    try {
      const pkg = (await import('minidev/package.json', { with: { type: 'json' } })).default;
      info.minidev = pkg.version;
    } catch {
      info.minidev = 'unknown';
    }
    // 授权探测：getList 需要有效授权，失败即视为未授权
    try {
      const list = await minidev.app.getList({});
      info.authenticated = true;
      info.appCount = Array.isArray(list) ? list.length : undefined;
    } catch (e) {
      info.authenticated = false;
      info.authError = toError(e).message;
    }
    return info;
  },

  /** 工具授权（扫码登录） */
  async 'auth.login'(args, ctx) {
    const timeoutMs = args.timeoutMs ?? 180_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('登录超时：请在时限内用支付宝 App 扫码确认')); }
      }, timeoutMs);
      const done = (fn, val) => {
        if (settled) return;
        settled = true; clearTimeout(timer); fn(val);
      };
      minidev.login({}, (loginTask) => {
        loginTask.on('qrcode-generated', (qrCodeUrl) => emitEvent(ctx.id, 'login-qrcode', { qrCodeUrl }));
        loginTask.on('scan', () => emitEvent(ctx.id, 'login-scan', {}));
        loginTask.on('success', () => {
          emitEvent(ctx.id, 'login-success', {});
          done(resolve, { success: true });
        });
      }).catch((e) => done(reject, e));
    });
  },

  /** 本地构建 */
  async 'build.run'(args) {
    const opts = clean(args);
    const t0 = Date.now();
    const r = await minidev.build(opts);
    return {
      durationMs: Date.now() - t0,
      project: r.project,
      dist: r.dist,
      buildTarget: r.buildTarget,
      result: safeJson(r.result),
    };
  },

  /** 启动 DevServer（长驻，日志经事件流出） */
  async 'dev.start'(args, ctx) {
    const sessionId = args.sessionId ?? `dev-${ctx.id}`;
    const opts = clean(args);
    const build = await minidev.dev(opts);
    const server = build.devServer;
    sessions.set(sessionId, { type: 'dev', server, project: build.project, dist: build.dist, startedAt: Date.now() });

    server.on('log', (data) => emitEvent(ctx.id, 'dev-log', { sessionId, data: String(data) }));
    server.on('error', (e) => emitEvent(ctx.id, 'dev-error', { sessionId, message: e?.message, stack: e?.stack }));
    server.on('hmr-error', (e) => emitEvent(ctx.id, 'dev-hmr-error', { sessionId, message: e?.message, stack: e?.stack }));
    server.on('done', (r) => emitEvent(ctx.id, 'dev-done', { sessionId, success: r?.success }));
    server.on('exit', (code) => emitEvent(ctx.id, 'dev-exit', { sessionId, code }));

    return {
      sessionId,
      devServerId: server.id,
      project: build.project,
      dist: build.dist,
    };
  },

  async 'dev.stop'(args) {
    const s = sessions.get(args.sessionId);
    if (!s || s.type !== 'dev') throw new Error(`DevServer 会话不存在: ${args.sessionId}`);
    const server = s.server;
    const stop = server.close ?? server.stop ?? server.kill;
    if (typeof stop === 'function') await stop.call(server);
    sessions.delete(args.sessionId);
    return { stopped: true };
  },

  /** 真机预览 */
  async 'preview.run'(args) {
    const opts = clean(args);
    const r = await minidev.preview(opts);
    return { qrcodeUrl: r.qrcodeUrl, qrcodeSchema: r.qrcodeSchema, version: r.version };
  },

  /** 真机调试（长驻，可停止） */
  async 'remoteDebug.start'(args, ctx) {
    const sessionId = args.sessionId ?? `rdebug-${ctx.id}`;
    const opts = clean(args);
    const r = await minidev.remoteDebug(opts);
    sessions.set(sessionId, { type: 'remote-debug', stopServer: r.stopServer, startedAt: Date.now() });
    return { sessionId, qrcodeUrl: r.qrcodeUrl, qrcodeSchema: r.qrcodeSchema, version: r.version, debugUrl: r.debugUrl };
  },

  async 'remoteDebug.stop'(args) {
    const s = sessions.get(args.sessionId);
    if (!s || s.type !== 'remote-debug') throw new Error(`真机调试会话不存在: ${args.sessionId}`);
    await s.stopServer?.();
    sessions.delete(args.sessionId);
    return { stopped: true };
  },

  /** Web 模拟器（浏览器里调试，无需真机） */
  async 'webSimulator.start'(args, ctx) {
    const sessionId = args.sessionId ?? `websim-${ctx.id}`;
    const opts = clean(args);
    const launcher = await minidev.devWebSimulator(opts);
    sessions.set(sessionId, { type: 'web-simulator', launcher, startedAt: Date.now() });
    return safeJson(launcher);
  },

  /** 上传 */
  async 'upload.run'(args, ctx) {
    const opts = clean(args);
    const hooks = {
      onLog: (data) => emitEvent(ctx.id, 'upload-log', { data: String(data) }),
      onTaskCreated: (taskId) => emitEvent(ctx.id, 'upload-task', { taskId }),
      onVersionCreated: (version) => emitEvent(ctx.id, 'upload-version', { version }),
    };
    const r = await minidev.upload(opts, hooks);
    return safeJson(r);
  },

  /** 小程序管理 */
  async 'app.list'(args) {
    return safeJson(await minidev.app.getList(clean(args)));
  },
  async 'app.versions'(args) {
    return safeJson(await minidev.app.getUploadedVersionList(clean(args)));
  },
  async 'app.latestVersion'(args) {
    return { version: await minidev.app.getUploadedVersion(clean(args)) };
  },
  async 'app.setExperience'(args) {
    return safeJson(await minidev.app.setExperience(clean(args)));
  },
  async 'app.cancelExperience'(args) {
    await minidev.app.cancelExperience(clean(args));
    return { done: true };
  },
  async 'app.deleteVersion'(args) {
    await minidev.app.deleteVersion(clean(args));
    return { done: true };
  },

  /** IDE */
  async 'ide.open'(args) {
    await minidev.startIde(clean(args));
    return { launched: true };
  },

  /** 清理构建缓存 */
  async 'build.cleanCache'() {
    await minidev.cleanBuildCache();
    return { cleaned: true };
  },
};

// ---------------- 协议循环 ----------------

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; } // 忽略混入的非协议行
  if (!req || typeof req.id === 'undefined' || !req.op) return;
  const fn = ops[req.op];
  if (!fn) {
    send({ id: req.id, ok: false, error: { message: `未知操作: ${req.op}` } });
    return;
  }
  try {
    const result = await fn(req.args ?? {}, { id: req.id });
    send({ id: req.id, ok: true, result });
  } catch (e) {
    send({ id: req.id, ok: false, error: toError(e) });
  }
});

process.stderr.write('[alipay-miniprogram-mcp worker] ready\n');
