/**
 * tools.mjs — MCP 工具集定义
 *
 * 每个工具: { name, title, description, inputSchema (JSON Schema), handler(args) }
 * handler 返回 { content: [{type:'text', text}], isError? }
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { analyze, boundaryPayloads, buildTestMatrix } from './analyzer.mjs';

const J = (v) => JSON.stringify(v, null, 2);

const ok = (result, { isError = false } = {}) => ({
  content: [{ type: 'text', text: J(result) }],
  isError,
});

const fail = (message, extra = {}) =>
  ok({ ok: false, error: message, ...extra }, { isError: true });

function detectLevel(text) {
  const s = String(text);
  if (/\b(error|ERROR|Error)\b|失败|异常|fatal/i.test(s)) return 'error';
  if (/\b(warn|WARN|Warn)\b|警告/i.test(s)) return 'warn';
  return 'info';
}

/**
 * @param {object} ctx
 * @param {import('./workerClient.mjs').WorkerClient} ctx.worker
 * @param {import('./state.mjs').LogStore} ctx.logStore
 * @param {import('./state.mjs').SessionRegistry} ctx.sessions
 * @param {(p?:string)=>string} ctx.resolveProject
 * @param {string} ctx.dataDir
 * @param {(level:string,data:string)=>void} ctx.notify  MCP logging 通知
 */
export function buildTools(ctx) {
  const { worker, logStore, sessions, resolveProject, dataDir, notify } = ctx;

  /** 保存二维码图片，返回文件路径 */
  async function saveQrImage(url, name) {
    try {
      const dir = path.join(dataDir, 'qr');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${name}-${crypto.randomBytes(2).toString('hex')}.png`);
      await QRCode.toFile(file, url, { width: 420, margin: 2 });
      return file;
    } catch {
      return null;
    }
  }

  /** 把 worker 事件接入日志存储（按 sessionId 去重登记） */
  worker.onEvent((name, data) => {
    switch (name) {
      case 'dev-log':
        logStore.append(data.sessionId, { message: data.data, level: detectLevel(data.data), source: 'devserver' });
        break;
      case 'dev-error':
        logStore.append(data.sessionId, { message: `[dev-server error] ${data.message}`, level: 'error', source: 'devserver' });
        break;
      case 'dev-hmr-error':
        logStore.append(data.sessionId, { message: `[hmr error] ${data.message}`, level: 'error', source: 'devserver' });
        break;
      case 'dev-done':
        logStore.append(data.sessionId, { message: `[dev] 构建完成 success=${data.success}`, level: data.success ? 'info' : 'error', source: 'devserver' });
        break;
      case 'dev-exit':
        logStore.append(data.sessionId, { message: `[dev] 进程退出 code=${data.code}`, level: 'warn', source: 'devserver' });
        break;
      case 'upload-log':
        logStore.append('upload', { message: data.data, level: detectLevel(data.data), source: 'upload' });
        break;
      default:
        break;
    }
  });

  const tools = [];

  const def = (name, title, description, inputSchema, handler) =>
    tools.push({ name, title, description, inputSchema, handler });

  // ============ 环境与授权 ============

  def('mp_env_check', '环境自检',
    '检查 Node/minidev/IDE/授权状态，给出可执行的修复建议',
    { type: 'object', properties: {} },
    async () => {
      const info = await worker.call('env.check');
      const ideCandidates = [
        'C:\\Program Files\\小程序开发者工具',
        'C:\\Program Files (x86)\\小程序开发者工具',
      ];
      const idePath = ideCandidates.find((p) => fs.existsSync(p)) ?? null;
      const suggestions = [];
      if (!info.authenticated) suggestions.push('未授权：调用 mp_login 扫码完成工具授权');
      if (!idePath) suggestions.push('未找到 IDE 安装目录：mp_ide_open 需要 IDE，可从支付宝开放平台下载');
      suggestions.push('首次构建如提示缺构建资源，可运行 npx minidev setup-build 初始化构建环境');
      return ok({
        ok: true, summary: `minidev ${info.minidev} · 授权${info.authenticated ? '有效' : '缺失'} · IDE ${idePath ?? '未检测到'}`,
        node: info.node, minidevVersion: info.minidev, authenticated: info.authenticated,
        authError: info.authError, idePath, suggestions,
      });
    });

  def('mp_login', '工具授权（扫码登录）',
    '发起 minidev 工具授权，二维码 URL 会通过日志通知推送，成功或超时后返回结果',
    {
      type: 'object',
      properties: { timeoutMs: { type: 'number', description: '等待扫码的超时毫秒数，默认 180000' } },
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? 180_000;
      let qrUrl = null;
      const off = worker.onEvent((name, data, id) => {
        if (name === 'login-qrcode') {
          qrUrl = data.qrCodeUrl;
          notify('info', `请用支付宝 App 扫码授权，二维码链接: ${data.qrCodeUrl}`);
        }
        if (name === 'login-scan') notify('info', '已扫码，请在手机上确认授权…');
      });
      try {
        await worker.call('auth.login', { timeoutMs });
        const qrFile = qrUrl ? await saveQrImage(qrUrl, 'login') : null;
        return ok({ ok: true, summary: '授权成功 ✓', qrCodeUrl: qrUrl, qrImageFile: qrFile });
      } catch (e) {
        const qrFile = qrUrl ? await saveQrImage(qrUrl, 'login') : null;
        return fail(e.message, { qrCodeUrl: qrUrl, qrImageFile: qrFile, hint: '若超时可重新调用 mp_login 获取新二维码' });
      } finally {
        off();
      }
    });

  // ============ 构建与静态验证 ============

  def('mp_build', '编译验证',
    '编译小程序项目，返回结构化的构建结果；失败时包含错误信息。用于代码能否通过编译的第一道验证',
    {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录（含 app.json）。缺省用上次项目' },
        appId: { type: 'string', description: '小程序 AppID（多数构建可省略）' },
        minify: { type: 'boolean', description: '压缩产物' },
        typescript: { type: 'boolean', description: '启用 TypeScript 编译' },
        less: { type: 'boolean', description: '启用 less 编译' },
        sourceMap: { type: 'boolean', description: '产出 sourceMap，默认 true' },
        output: { type: 'string', description: '产物输出路径' },
        parallel: { type: 'boolean', description: '多进程编译' },
      },
    },
    async (args) => {
      const project = resolveProject(args.project);
      const t0 = Date.now();
      try {
        const r = await worker.call('build.run', { ...args, project });
        return ok({
          ok: true, summary: `编译通过 ✓（${((Date.now() - t0) / 1000).toFixed(1)}s）→ ${r.dist}`,
          ...r,
        });
      } catch (e) {
        return fail(`编译失败: ${e.message}`, {
          project, durationMs: Date.now() - t0,
          hint: '检查最近改动文件的语法；也可用 mp_project_analyze 先做静态检查',
        });
      }
    });

  def('mp_project_analyze', '项目静态分析',
    '分析项目结构与配置：页面文件完整性、组件引用、tabBar、分包、体积等，产出分级问题清单（error/warn/info）',
    {
      type: 'object',
      properties: { project: { type: 'string', description: '项目根目录' } },
      required: ['project'],
    },
    async (args) => {
      // 延迟加载避免启动开销
      const { analyzeProject } = await import('./project.mjs');
      const project = resolveProject(args.project);
      const r = analyzeProject(project);
      if (!r.ok && r.error) return fail(r.error);
      return ok({
        ok: true,
        summary: `页面 ${r.stats.pages} 个 · 分包 ${r.stats.subPackages} 个 · 错误 ${r.stats.errors} · 警告 ${r.stats.warnings} · 体积约 ${r.stats.sizeKB}KB`,
        ...r,
      });
    });

  def('mp_validate_pages', '页面验证',
    '对指定页面（默认全部）做文件完整性与配置校验，输出每个页面的检查结果',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        pages: { type: 'array', items: { type: 'string' }, description: '要验证的页面路径，缺省验证全部' },
      },
    },
    async (args) => {
      const { analyzeProject } = await import('./project.mjs');
      const project = resolveProject(args.project);
      const r = analyzeProject(project);
      if (!r.ok && r.error) return fail(r.error);
      let details = r.pageDetails;
      const findings = r.findings;
      if (args.pages?.length) {
        const set = new Set(args.pages);
        details = details.filter((d) => set.has(d.page));
        const picked = findings.filter((f) => set.has(f.file) || f.file === 'app.json');
        const errs = picked.filter((f) => f.severity === 'error');
        return ok({
          ok: errs.length === 0,
          summary: `验证 ${details.length}/${args.pages.length} 个页面：错误 ${errs.length} 个`,
          pages: details, findings: picked,
        });
      }
      return ok({
        ok: r.ok,
        summary: `全部 ${details.length} 个页面验证完成：错误 ${r.stats.errors} 个`,
        pages: details, findings,
      });
    });

  // ============ 预览与调试 ============

  def('mp_preview', '真机预览',
    '构建并发起真机预览，返回预览二维码（含图片文件路径）；可指定入口页面与参数，用于页面级验证',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string', description: '小程序 AppID（必填）' },
        page: { type: 'string', description: '入口页面路径，如 pages/index/index' },
        pageQuery: { type: 'string', description: '页面参数，如 id=1&from=test' },
        query: { type: 'string', description: '全局参数（onLaunch 取得）' },
        scene: { type: 'string', description: '进入场景值' },
        clientType: { type: 'string', description: '端类型，默认 alipay' },
        autoPush: { type: 'boolean', description: '自动推送到客户端，默认 true' },
        ignoreHttpDomainCheck: { type: 'boolean', description: '忽略 http 域名白名单校验' },
        ignoreWebviewDomainCheck: { type: 'boolean', description: '忽略 webview 域名白名单校验' },
        minify: { type: 'boolean' }, typescript: { type: 'boolean' }, less: { type: 'boolean' },
      },
      required: ['appId'],
    },
    async (args) => {
      const project = resolveProject(args.project);
      try {
        const r = await worker.call('preview.run', { ...args, project });
        const qrFile = await saveQrImage(r.qrcodeUrl, 'preview');
        return ok({
          ok: true, summary: `预览已生成（版本 ${r.version ?? '-'}），请用支付宝扫码`,
          qrcodeUrl: r.qrcodeUrl, qrImageFile: qrFile, version: r.version,
          page: args.page, pageQuery: args.pageQuery,
        });
      } catch (e) {
        return fail(`预览失败: ${e.message}`, { hint: '未授权先 mp_login；appid 不存在或无权限也会失败' });
      }
    });

  def('mp_remote_debug', '真机调试',
    '发起真机调试，返回调试二维码与 Chrome DevTools 调试地址 debugUrl；配合 mp_debug_stop 结束',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string', description: '小程序 AppID（必填）' },
        page: { type: 'string' }, pageQuery: { type: 'string' }, query: { type: 'string' },
        autoOpenDevtools: { type: 'boolean', description: '自动打开调试器，默认 true' },
      },
      required: ['appId'],
    },
    async (args) => {
      const project = resolveProject(args.project);
      const sessionId = sessions.create('remote-debug', { summary: `真机调试 ${args.appId}` });
      try {
        const r = await worker.call('remoteDebug.start', { ...args, project, sessionId });
        sessions.set(sessionId, { debugUrl: r.debugUrl, qrcodeUrl: r.qrcodeUrl });
        const qrFile = await saveQrImage(r.qrcodeUrl, 'rdebug');
        return ok({
          ok: true, summary: `真机调试已就绪，调试地址: ${r.debugUrl}`,
          sessionId, qrcodeUrl: r.qrcodeUrl, qrImageFile: qrFile, debugUrl: r.debugUrl, version: r.version,
        });
      } catch (e) {
        sessions.delete(sessionId);
        return fail(`真机调试发起失败: ${e.message}`);
      }
    });

  def('mp_debug_stop', '停止真机调试',
    '停止由 mp_remote_debug 发起的调试服务',
    { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] },
    async (args) => {
      const s = sessions.get(args.sessionId);
      if (!s) return fail(`会话不存在: ${args.sessionId}`);
      await worker.call('remoteDebug.stop', { sessionId: args.sessionId });
      sessions.delete(args.sessionId);
      return ok({ ok: true, summary: '调试服务已停止' });
    });

  def('mp_web_simulator', 'Web 模拟器',
    '启动浏览器端模拟器（无需真机），返回可在浏览器打开的 simulator/devtool 地址，用于页面调试验证',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string' },
        clientType: { type: 'string' },
      },
    },
    async (args) => {
      const project = resolveProject(args.project);
      const sessionId = sessions.create('web-simulator', { summary: 'Web 模拟器' });
      try {
        const r = await worker.call('webSimulator.start', { ...args, project, sessionId });
        const bundled = r.bundled ?? null;
        sessions.set(sessionId, { bundled });
        return ok({
          ok: true, summary: 'Web 模拟器已启动，用浏览器打开 simulator 地址即可调试',
          sessionId,
          simulatorUrl: r.separated?.simulator ?? bundled,
          devtoolUrl: r.separated?.devtool ?? null,
          raw: r,
        });
      } catch (e) {
        sessions.delete(sessionId);
        return fail(`Web 模拟器启动失败: ${e.message}`);
      }
    });

  def('mp_ide_open', '打开 IDE',
    '用支付宝小程序开发者工具打开指定项目（自动探测 Windows 安装路径）',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        lite: { type: 'boolean', description: 'Lite 模式启动，默认 true' },
        appPath: { type: 'string', description: 'IDE 安装路径（探测失败时手动指定）' },
      },
    },
    async (args) => {
      const project = resolveProject(args.project);
      try {
        await worker.call('ide.open', { project, lite: args.lite ?? true, appPath: args.appPath });
        return ok({ ok: true, summary: `IDE 已启动: ${project}` });
      } catch (e) {
        return fail(`IDE 启动失败: ${e.message}`, { hint: '确认已安装 IDE；或用 appPath 参数指定安装目录' });
      }
    });

  // ============ DevServer 与日志 ============

  def('mp_dev_start', '启动开发服务',
    '启动 DevServer 长驻会话并自动收集全部运行日志（编译输出/错误/HMR），返回 sessionId 供日志查询',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string' },
        hmr: { type: 'boolean', description: '开启热更新' },
        port: { type: 'number' }, host: { type: 'string' },
      },
    },
    async (args) => {
      const project = resolveProject(args.project);
      const sessionId = sessions.create('dev', { summary: `DevServer ${path.basename(project)}` });
      try {
        const r = await worker.call('dev.start', { ...args, project, sessionId });
        sessions.set(sessionId, { devServerId: r.devServerId, dist: r.dist });
        return ok({ ok: true, summary: `DevServer 已启动，日志收集开启（sessionId=${sessionId}）`, sessionId, devServerId: r.devServerId, project: r.project, dist: r.dist });
      } catch (e) {
        sessions.delete(sessionId);
        return fail(`DevServer 启动失败: ${e.message}`, { hint: '编译错误会导致启动失败，先跑 mp_build 看详细报错' });
      }
    });

  def('mp_dev_stop', '停止开发服务',
    '停止 DevServer 会话',
    { type: 'object', properties: { sessionId: { type: 'string', description: 'dev.start 返回的 sessionId' } }, required: ['sessionId'] },
    async (args) => {
      try {
        await worker.call('dev.stop', { sessionId: args.sessionId });
        return ok({ ok: true, summary: 'DevServer 已停止' });
      } catch (e) {
        return fail(e.message);
      }
    });

  def('mp_logs_get', '查询日志',
    '查询收集到的运行日志：可按会话/级别/关键字/条数过滤',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '日志会话 id，缺省合并全部' },
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
        keyword: { type: 'string' },
        since: { type: 'string', description: '起始时间 ISO 字符串' },
        tail: { type: 'number', description: '只返回最后 N 条，默认 500' },
      },
    },
    async (args) => {
      const r = logStore.query(args);
      return ok({ ok: true, summary: `命中 ${r.total} 条，返回 ${r.returned} 条`, ...r });
    });

  def('mp_logs_analyze', '日志分析',
    '分析收集的日志（或指定日志文件）：错误分类聚类、时间线、修复建议',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '日志会话 id，缺省合并全部' },
        level: { type: 'string', enum: ['info', 'warn', 'error'], description: '只分析指定级别' },
        keyword: { type: 'string' },
        file: { type: 'string', description: '改为分析指定日志文件（JSONL 或纯文本）' },
      },
    },
    async (args) => {
      let entries;
      if (args.file) {
        if (!fs.existsSync(args.file)) return fail(`文件不存在: ${args.file}`);
        entries = logStore.loadFromFile(args.file);
      } else {
        entries = logStore.query({ sessionId: args.sessionId, level: args.level, keyword: args.keyword, tail: 0 }).entries;
      }
      if (!entries.length) return ok({ ok: true, summary: '暂无日志可分析', ...analyze([]) });
      const r = analyze(entries);
      return ok({
        ok: (r.summary.errorCount ?? 0) === 0,
        summary: `共 ${r.summary.totalEntries} 条 · 错误 ${r.summary.errorCount} 条（${r.summary.distinctErrors} 类）`,
        ...r,
      });
    });

  def('mp_logs_clear', '清空日志',
    '清空内存与磁盘中的日志缓冲',
    { type: 'object', properties: { sessionId: { type: 'string' } } },
    async (args) => {
      const r = logStore.clear(args.sessionId);
      return ok({ ok: true, summary: '日志已清空', ...r });
    });

  // ============ 上传与版本管理 ============

  def('mp_upload', '上传代码',
    '上传小程序代码包，可自动设为体验版；上传过程日志实时收集',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string', description: '小程序 AppID（必填）' },
        version: { type: 'string', description: '版本号，缺省自动 +1 patch' },
        versionDescription: { type: 'string', description: '版本描述（≤200 字）' },
        experience: { type: 'boolean', description: '上传后自动设为体验版' },
        deleteVersion: { type: 'string', description: '同时删除指定旧版本' },
      },
      required: ['appId'],
    },
    async (args) => {
      const project = resolveProject(args.project);
      try {
        const r = await worker.call('upload.run', { ...args, project });
        return ok({ ok: true, summary: '上传成功 ✓', ...r });
      } catch (e) {
        return fail(`上传失败: ${e.message}`, { hint: '检查授权、AppID 权限（开发者身份）、版本号是否重复；详情见 mp_logs_get source=upload' });
      }
    });

  def('mp_app_list', '小程序列表',
    '获取账号下的小程序列表（同时用于验证授权是否有效）',
    { type: 'object', properties: { clientType: { type: 'string' } } },
    async (args) => {
      try {
        const r = await worker.call('app.list', args);
        const list = Array.isArray(r) ? r : r?.apps ?? [];
        return ok({
          ok: true, summary: `共 ${list.length} 个小程序`,
          apps: list.map((a) => ({ appId: a.appId, appName: a.appName, type: a.subApplicationType })),
        });
      } catch (e) {
        return fail(`获取列表失败: ${e.message}`, { hint: '通常表示未授权或授权过期，请先 mp_login' });
      }
    });

  def('mp_app_versions', '版本列表',
    '获取小程序已上传的版本列表',
    { type: 'object', properties: { appId: { type: 'string' }, clientType: { type: 'string' } }, required: ['appId'] },
    async (args) => {
      try {
        const r = await worker.call('app.versions', args);
        return ok({ ok: true, summary: `共 ${Array.isArray(r) ? r.length : 0} 个版本`, versions: r });
      } catch (e) {
        return fail(`获取版本失败: ${e.message}`);
      }
    });

  def('mp_set_experience', '设置体验版',
    '将指定版本设为体验版，返回体验二维码',
    { type: 'object', properties: { appId: { type: 'string' }, version: { type: 'string' } }, required: ['appId', 'version'] },
    async (args) => {
      try {
        const r = await worker.call('app.setExperience', args);
        const qrFile = r?.qrCodeUrl ? await saveQrImage(r.qrCodeUrl, 'experience') : null;
        return ok({ ok: true, summary: `已设为体验版: ${args.version}`, ...r, qrImageFile: qrFile });
      } catch (e) {
        return fail(`设置体验版失败: ${e.message}`);
      }
    });

  // ============ 测试验证（页面/功能/边界） ============

  def('mp_test_matrix', '生成边界测试矩阵',
    '为指定页面生成边界参数用例矩阵（空值/超大值/特殊字符/注入样式/超长字符串等），静态生成不发起构建',
    {
      type: 'object',
      properties: {
        pages: { type: 'array', items: { type: 'string' }, description: '页面路径列表' },
        paramName: { type: 'string', description: '主要参数名，默认 id' },
        customCases: {
          type: 'array',
          items: { type: 'object', properties: { case: { type: 'string' }, query: { type: 'string' } } },
          description: '追加自定义用例',
        },
      },
    },
    async (args) => {
      const pages = args.pages?.length ? args.pages : [];
      if (!pages.length) return fail('请提供 pages 参数');
      const cases = buildTestMatrix(pages, args.paramName ?? 'id', args.customCases ?? []);
      return ok({
        ok: true,
        summary: `生成 ${cases.length} 个边界用例（${pages.length} 页 × 用例矩阵）`,
        cases,
        usage: '将用例交给 mp_test_run 逐个生成预览二维码做真机验证，或按用例手工调用 mp_preview',
      });
    });

  def('mp_test_run', '运行页面测试用例',
    '批量运行测试用例：编译一次，然后为每个用例生成指定页面+参数的真机预览二维码（构建缓存加速），逐个扫码即可在真机验证；运行后用 mp_logs_analyze 汇总报错',
    {
      type: 'object',
      properties: {
        project: { type: 'string' },
        appId: { type: 'string', description: '小程序 AppID（必填）' },
        pages: { type: 'array', items: { type: 'string' }, description: '要测试的页面列表' },
        paramName: { type: 'string', description: '主要参数名，默认 id' },
        caseLimit: { type: 'number', description: '最多生成的用例数（防止二维码爆炸），默认 12' },
        customCases: { type: 'array', items: { type: 'object', properties: { case: { type: 'string' }, query: { type: 'string' } } } },
        skipBuild: { type: 'boolean', description: '跳过首次构建（已有产物时）' },
      },
      required: ['appId', 'pages'],
    },
    async (args) => {
      const project = resolveProject(args.project);
      const limit = Math.max(1, Math.min(args.caseLimit ?? 12, 30));
      const cases = buildTestMatrix(args.pages, args.paramName ?? 'id', args.customCases ?? []).slice(0, limit);
      const results = [];
      let buildError = null;
      if (!args.skipBuild) {
        try {
          await worker.call('build.run', { project, sourceMap: false });
        } catch (e) {
          buildError = e.message;
        }
      }
      if (buildError) {
        return fail(`编译失败，无法生成测试预览: ${buildError}`, { hint: '先修复编译错误' });
      }
      for (const c of cases) {
        try {
          const r = await worker.call('preview.run', {
            project, appId: args.appId,
            page: c.page, pageQuery: c.query || undefined,
            skipBuild: true,
          });
          const qrFile = await saveQrImage(r.qrcodeUrl, `case-${results.length + 1}`);
          results.push({ ...c, ok: true, qrcodeUrl: r.qrcodeUrl, qrImageFile: qrFile });
        } catch (e) {
          results.push({ ...c, ok: false, error: e.message });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return ok({
        ok: okCount > 0,
        summary: `用例 ${okCount}/${results.length} 个已生成预览二维码（存于 ${path.join(dataDir, 'qr')}）；真机逐个扫码验证后，调用 mp_logs_analyze 汇总报错`,
        cases: results,
        next: '扫码验证每个用例 → mp_logs_get / mp_logs_analyze 查看报错 → 修复后重跑',
      });
    });

  def('mp_list_sessions', '会话列表',
    '列出当前活跃会话（DevServer/真机调试/Web 模拟器）与日志会话',
    { type: 'object', properties: {} },
    async () => {
      return ok({ ok: true, summary: `${sessions.list().length} 个活跃会话`, sessions: sessions.list(), logSessions: logStore.listSessions() });
    });

  return tools;
}
