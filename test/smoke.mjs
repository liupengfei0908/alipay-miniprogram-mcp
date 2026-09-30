/**
 * smoke.mjs — 端到端自测：启动 MCP 服务器（stdio），验证工具列表与核心工具调用
 *
 * 运行: node test/smoke.mjs
 * 说明: 使用 .fakehome 作为用户目录，避免测试过程写入真实用户目录；
 *       需要 ① mp_build 会真实调用 minidev 构建器（首次可能需下载构建资源）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fakeHome = path.join(root, '.fakehome');
fs.mkdirSync(fakeHome, { recursive: true });

const FIXTURE = path.join(root, 'test', 'fixture-demo');

let pass = 0;
let failCount = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name} ${detail}`); }
}

async function callJson(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? '{}';
  let json;
  try { json = JSON.parse(text); } catch { json = { __raw: text }; }
  return { json, isError: res.isError === true };
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'index.mjs')],
    env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
  });
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  await client.connect(transport);
  console.log('== MCP 服务器已连接 ==');

  // 1. 工具列表
  const { tools } = await client.listTools();
  console.log(`\n[1] 工具列表: ${tools.length} 个`);
  check('工具数量 >= 18', tools.length >= 18, `实际 ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  for (const expect of ['mp_env_check', 'mp_login', 'mp_build', 'mp_project_analyze', 'mp_preview', 'mp_upload', 'mp_logs_analyze', 'mp_test_run']) {
    check(`包含 ${expect}`, names.has(expect));
  }

  // 2. 环境自检
  console.log('\n[2] mp_env_check');
  const env = await callJson(client, 'mp_env_check');
  check('返回结构 ok', typeof env.json.node === 'string', JSON.stringify(env.json).slice(0, 200));
  check('minidev 版本可读', !!env.json.minidevVersion);
  console.log(`  授权状态: ${env.json.authenticated ? '有效' : '未授权(预期, 未扫码)'}${env.json.authError ? ` (${String(env.json.authError).slice(0, 60)}...)` : ''}`);

  // 3. 项目静态分析（夹具含故意问题）
  console.log('\n[3] mp_project_analyze');
  const ana = await callJson(client, 'mp_project_analyze', { project: FIXTURE });
  check('识别出错误', (ana.json.stats?.errors ?? 0) >= 3, `实际 ${JSON.stringify(ana.json.stats)}`);
  check('统计页面数 = 2', ana.json.stats?.pages === 2);
  const errMsgs = (ana.json.findings ?? []).filter((f) => f.severity === 'error').map((f) => f.message);
  check('发现页面缺 axml', errMsgs.some((m) => m.includes('axml')), JSON.stringify(errMsgs));
  check('发现 tabBar 图标缺失', errMsgs.some((m) => m.includes('图标不存在')));
  check('发现组件文件不完整', errMsgs.some((m) => m.includes('组件') && m.includes('不完整')));

  // 4. 页面级验证
  console.log('\n[4] mp_validate_pages');
  const vp = await callJson(client, 'mp_validate_pages', { project: FIXTURE, pages: ['pages/index/index'] });
  check('单页验证返回', vp.json.pages?.length === 1, JSON.stringify(vp.json).slice(0, 160));

  // 5. 边界测试矩阵
  console.log('\n[5] mp_test_matrix');
  const tm = await callJson(client, 'mp_test_matrix', { pages: ['pages/index/index', 'pages/detail/detail'], paramName: 'id' });
  check('生成 36 个边界用例', tm.json.cases?.length === 36, `实际 ${tm.json.cases?.length}`);
  check('含超长字符串用例', tm.json.cases?.some((c) => c.name.includes('超长')));
  check('含注入样式用例', tm.json.cases?.some((c) => c.name.includes('SQL')));

  // 6. 日志查询（空）
  console.log('\n[6] mp_logs_get');
  const lg = await callJson(client, 'mp_logs_get', {});
  check('空日志返回 ok', lg.json.ok === true && lg.json.total === 0, JSON.stringify(lg.json).slice(0, 120));

  // 7. 缺参数报错
  console.log('\n[7] 参数校验');
  const need = await callJson(client, 'mp_upload', {});
  check('缺 appId 报错', need.isError === true && /appId/.test(need.json.error ?? ''), JSON.stringify(need.json).slice(0, 120));

  // 8. 未授权时的受控失败（upload 走真实链路但应快速失败）
  console.log('\n[8] mp_app_list（未授权场景）');
  const al = await callJson(client, 'mp_app_list', {});
  console.log(`  结果: ok=${al.json.ok} ${al.json.error ? `error=${String(al.json.error).slice(0, 80)}` : ''}`);
  check('返回结构化结果（无论成功失败）', typeof al.json.ok === 'boolean');

  await client.close();
  console.log(`\n== 冒烟测试完成: ${pass} 通过, ${failCount} 失败 ==`);
  process.exit(failCount ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
