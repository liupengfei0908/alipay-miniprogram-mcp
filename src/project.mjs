/**
 * project.mjs — 小程序项目静态分析：页面完整性、组件引用、tabBar、分包等
 */
import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); // 兼容带 BOM 的 JSON
    return JSON.parse(text);
  } catch (e) {
    return { __error: e.message };
  }
}

function exists(p) { return fs.existsSync(p); }

/** 解析 usingComponents 引用为绝对文件路径候选 */
function resolveComponentPath(ref, fromDir, projectRoot) {
  const base = ref.startsWith('/')
    ? path.join(projectRoot, ref.slice(1))
    : path.resolve(fromDir, ref);
  return base;
}

/**
 * 静态分析小程序项目
 * @param {string} projectRoot 项目根目录（含 app.json）
 */
export function analyzeProject(projectRoot) {
  const findings = [];
  const add = (severity, file, message, fix) => findings.push({ severity, file, message, ...(fix ? { fix } : {}) });

  const appJsonPath = path.join(projectRoot, 'app.json');
  if (!exists(appJsonPath)) {
    return { ok: false, error: `未找到 app.json（项目根目录: ${projectRoot}）` };
  }
  const appJson = readJson(appJsonPath);
  if (appJson.__error) {
    return { ok: false, error: `app.json 解析失败: ${appJson.__error}` };
  }

  // --- 页面清单 ---
  const pages = Array.isArray(appJson.pages) ? appJson.pages : [];
  if (!pages.length) add('error', 'app.json', 'pages 为空，小程序至少需要一个页面');

  const pageDetails = [];
  const registered = new Set(pages);

  for (const page of pages) {
    const dir = path.join(projectRoot, page);
    const detail = { page, files: {} };
    for (const ext of ['axml', 'js', 'json', 'acss', 'css']) {
      const f = `${dir}.${ext}`;
      const has = exists(f);
      if (has) detail.files[ext] = f;
    }
    if (!detail.files.axml) add('error', page, `缺少模板文件 ${page}.axml`, '每个页面必须有 axml 模板');
    if (!detail.files.js) add('error', page, `缺少逻辑文件 ${page}.js`, '每个页面必须有 js 文件（即使为空对象注册）');
    if (!detail.files.json) add('warn', page, `缺少页面配置 ${page}.json`, '建议补充页面标题等配置');
    if (!detail.files.acss && !detail.files.css) add('info', page, `无样式文件 ${page}.acss（允许）`);

    // 页面内 usingComponents
    if (detail.files.json) {
      const pj = readJson(detail.files.json);
      if (pj.__error) {
        add('error', `${page}.json`, `JSON 解析失败: ${pj.__error}`);
      } else if (pj.usingComponents) {
        detail.usingComponents = {};
        for (const [name, ref] of Object.entries(pj.usingComponents)) {
          const base = resolveComponentPath(ref, path.dirname(detail.files.json), projectRoot);
          const ok = exists(`${base}.json`) && exists(`${base}.js`) && exists(`${base}.axml`);
          detail.usingComponents[name] = { ref, ok };
          if (!ok) add('error', page, `组件 ${name}（${ref}）文件不完整`, '组件目录需包含 .js/.axml/.json（如需样式加 .acss）');
        }
      }
    }
    pageDetails.push(detail);
  }

  // --- tabBar ---
  const tabBar = appJson.tabBar;
  if (tabBar && Array.isArray(tabBar.list)) {
    for (const item of tabBar.list) {
      if (item.pagePath && !registered.has(item.pagePath)) {
        add('error', 'app.json', `tabBar.pagePath "${item.pagePath}" 未在 pages 中注册`);
      }
      for (const key of ['iconPath', 'selectedIconPath']) {
        if (item[key] && !exists(path.join(projectRoot, item[key]))) {
          add('error', 'app.json', `tabBar 图标不存在: ${item[key]}`);
        }
      }
    }
    if (tabBar.list.length < 2) add('warn', 'app.json', 'tabBar 至少需要 2 个 tab');
    if (tabBar.list.length > 5) add('error', 'app.json', 'tabBar 最多 5 个 tab');
  }

  // --- 分包 ---
  const subPackages = appJson.subPackages ?? appJson.subpackages ?? [];
  for (const sp of subPackages) {
    if (!sp.root || !Array.isArray(sp.pages)) {
      add('error', 'app.json', `分包配置缺少 root 或 pages: ${JSON.stringify(sp).slice(0, 120)}`);
      continue;
    }
    for (const p of sp.pages) {
      const full = path.posix.join(sp.root, p);
      const base = path.join(projectRoot, full);
      if (!exists(`${base}.axml`) || !exists(`${base}.js`)) {
        add('error', full, `分包页面文件不完整（${full}.axml / ${full}.js）`);
      }
    }
    // 分包 root 与主包页面重叠检查
    for (const page of pages) {
      if (page.startsWith(`${sp.root}/`)) {
        add('warn', 'app.json', `主包页面 ${page} 位于分包 root "${sp.root}" 内，可能引起歧义`);
      }
    }
  }

  // --- 全局 usingComponents（app.json） ---
  if (appJson.usingComponents) {
    for (const [name, ref] of Object.entries(appJson.usingComponents)) {
      const base = resolveComponentPath(ref, projectRoot, projectRoot);
      if (!(exists(`${base}.json`) && exists(`${base}.js`) && exists(`${base}.axml`))) {
        add('error', 'app.json', `全局组件 ${name}（${ref}）文件不完整`);
      }
    }
  }

  // --- 工程配置 ---
  const hasProjectConfig = exists(path.join(projectRoot, 'mini.project.json')) || exists(path.join(projectRoot, 'project.config.json'));
  if (!hasProjectConfig) add('warn', '', '缺少 mini.project.json / project.config.json 工程配置文件');

  // --- 体积估算 ---
  let totalSize = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else {
        try { totalSize += fs.statSync(f).size; } catch {}
      }
    }
  };
  walk(projectRoot);
  const sizeKB = Math.round(totalSize / 102.4) / 10;
  if (sizeKB > 2048) add('warn', '', `主包体积约 ${sizeKB}KB，超过 2MB 限制将无法上传`, '使用分包 subPackages 拆分');

  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');

  return {
    ok: errors.length === 0,
    projectRoot,
    stats: {
      pages: pages.length,
      subPackages: subPackages.length,
      tabBarItems: tabBar?.list?.length ?? 0,
      sizeKB,
      errors: errors.length,
      warnings: warns.length,
      infos: findings.filter((f) => f.severity === 'info').length,
    },
    findings,
    pageDetails: pageDetails.map((d) => ({
      page: d.page,
      files: Object.fromEntries(Object.keys(d.files).map((k) => [k, true])),
      usingComponents: d.usingComponents,
    })),
  };
}
