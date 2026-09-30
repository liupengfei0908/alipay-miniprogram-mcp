/**
 * analyzer.mjs — 日志分析器：错误分类、聚类、边界测试用例生成
 */

// 错误分类规则：按优先级依次匹配
const RULES = [
  { category: 'JS异常', patterns: [
    /TypeError/i, /ReferenceError/i, /SyntaxError/i, /RangeError/i,
    /is not defined/i, /is not a function/i, /Cannot read propert/i,
    /undefined is not an object/i, /null is not an object/i, /Uncaught/i,
  ]},
  { category: '页面路由', patterns: [
    /page.*not.*found/i, /navigateTo|redirectTo|switchTab|reLaunch/i,
    /页面不存在|路由失败|invalid page/i, /\b404\b/,
  ]},
  { category: '网络请求', patterns: [
    /request:fail/i, /timeout/i, /ERR_(?!NONE)/i, /network error/i,
    /连接超时|网络(异常|错误|请求失败)/i, /getaddrinfo|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i,
  ]},
  { category: '开放接口/授权', patterns: [
    /auth|授权|permission|scope/i,
    /error code[:=]?\s*\d{4}/i, /错误码/,
  ]},
  { category: '存储/缓存', patterns: [
    /setStorage|getStorage|removeStorage|clearStorage/i, /storage/i,
  ]},
  { category: '组件/渲染', patterns: [
    /component/i, /render/i, /template/i, /axml/i, /setData/i, /自定义组件/i,
  ]},
  { category: '构建/编译', patterns: [
    /compile|build|webpack|transpile/i, /编译|构建/,
  ]},
];

/** 归一化错误消息用于聚类：去掉数字/路径/哈希等易变部分 */
export function normalizeMessage(msg) {
  return String(msg)
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')       // 哈希
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, '<time>') // 时间戳
    .replace(/\b\d+(\.\d+)+(ms|s|kb|mb|b)\b/gi, '<dur>')
    .replace(/\/[\w\-./@$%]+\.(js|axml|acss|json|ts)/gi, '<path>')
    .replace(/:\d+:\d+/g, ':<line>')               // 行列号
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function classify(message) {
  const s = String(message);
  for (const r of RULES) {
    if (r.patterns.some((p) => p.test(s))) return r.category;
  }
  return '其他';
}

/**
 * 分析日志条目
 * @param {Array<{ts:string, level:string, source?:string, message:string}>} entries
 */
export function analyze(entries) {
  const counts = { total: entries.length, byLevel: {}, byCategory: {}, bySource: {} };
  const errorGroups = new Map(); // normalized -> {sample, message, count, firstTs, lastTs, categories}
  const errors = [];
  const timeline = [];

  for (const e of entries) {
    counts.byLevel[e.level] = (counts.byLevel[e.level] ?? 0) + 1;
    counts.bySource[e.source ?? 'unknown'] = (counts.bySource[e.source ?? 'unknown'] ?? 0) + 1;

    const isError = e.level === 'error' || /error|fail|exception|异常/i.test(String(e.message));
    if (isError) {
      const cat = classify(e.message);
      counts.byCategory[cat] = (counts.byCategory[cat] ?? 0) + 1;
      const key = normalizeMessage(e.message);
      const g = errorGroups.get(key) ?? { message: key, sample: String(e.message).slice(0, 400), category: cat, count: 0, firstTs: e.ts, lastTs: e.ts };
      g.count += 1;
      if (e.ts && e.ts < g.firstTs) g.firstTs = e.ts;
      if (e.ts && e.ts > g.lastTs) g.lastTs = e.ts;
      errorGroups.set(key, g);
      if (errors.length < 200) errors.push({ ts: e.ts, category: cat, message: String(e.message).slice(0, 400) });
    }
    if (e.ts) timeline.push(e.ts);
  }

  const groups = [...errorGroups.values()].sort((a, b) => b.count - a.count);

  const suggestions = [];
  const cats = Object.keys(counts.byCategory);
  if (cats.includes('JS异常')) suggestions.push('存在 JS 运行时异常：优先查看 sample 堆栈，常见原因是空值未判空、API 未定义、异步时序问题');
  if (cats.includes('网络请求')) suggestions.push('存在网络请求失败：检查域名是否已加入小程序后台 request 合法域名白名单，或开启「忽略域名白名单」预览验证');
  if (cats.includes('页面路由')) suggestions.push('存在页面路由问题：确认 app.json 已注册目标页面且路径大小写正确，tabBar 页需用 switchTab');
  if (cats.includes('开放接口/授权')) suggestions.push('存在授权/开放接口错误：检查 my.authorize scope、开放平台密钥配置与接口权限');
  if (cats.includes('组件/渲染')) suggestions.push('存在渲染/组件问题：检查 usingComponents 路径、setData 数据结构与 axml 绑定');
  if (counts.byLevel.warn) suggestions.push('存在警告日志：建议清理以避免掩盖真正的错误');
  if (!errors.length) suggestions.push('未发现错误日志 ✓');

  timeline.sort();
  return {
    summary: {
      totalEntries: counts.total,
      byLevel: counts.byLevel,
      byCategory: counts.byCategory,
      bySource: counts.bySource,
      errorCount: errors.length,
      distinctErrors: groups.length,
      timeRange: timeline.length ? { first: timeline[0], last: timeline[timeline.length - 1] } : null,
    },
    errorGroups: groups.slice(0, 20),
    recentErrors: errors.slice(-30),
    suggestions,
  };
}

// ---------------- 边界测试用例生成 ----------------

/** 通用边界查询参数 payload 集（k 为参数名） */
export function boundaryPayloads(k = 'id') {
  return [
    { case: '空字符串', query: `${k}=` },
    { case: '不传参数', query: '' },
    { case: '零', query: `${k}=0` },
    { case: '负数', query: `${k}=-1` },
    { case: '超大数值', query: `${k}=99999999999999999999` },
    { case: '非数字', query: `${k}=abc` },
    { case: '小数', query: `${k}=3.14159265358979` },
    { case: '特殊字符', query: `${k}=${encodeURIComponent('!@#$%^&*()_+{}|:<>?')}` },
    { case: '中文', query: `${k}=${encodeURIComponent('中文参数测试')}` },
    { case: 'emoji', query: `${k}=${encodeURIComponent('😀🚀测试')}` },
    { case: '超长字符串', query: `${k}=${'x'.repeat(2000)}` },
    { case: 'SQL注入样式', query: `${k}=${encodeURIComponent("1' OR '1'='1")}` },
    { case: 'XSS样式', query: `${k}=${encodeURIComponent('<script>alert(1)</script>')}` },
    { case: 'JSON字符串', query: `${k}=${encodeURIComponent('{"a":1}')}` },
    { case: '数组样式', query: `${k}=${encodeURIComponent('1,2,3')}` },
    { case: '布尔样式', query: `${k}=true` },
    { case: 'URL编码符号', query: `${k}=%00%1B` },
    { case: '重复参数', query: `${k}=1&${k}=2` },
  ];
}

/** 组合用例：页面 × 参数矩阵 */
export function buildTestMatrix(pages, paramName = 'id', customCases = []) {
  const cases = [];
  for (const page of pages) {
    for (const p of boundaryPayloads(paramName)) {
      if (!p.query && p.case !== '不传参数') continue;
      cases.push({ name: `${page} · ${p.case}`, page, query: p.query });
    }
    for (const c of customCases) {
      cases.push({ name: `${page} · ${c.case ?? '自定义'}`, page, query: c.query ?? '' });
    }
  }
  return cases;
}
