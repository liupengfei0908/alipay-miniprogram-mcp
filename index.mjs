#!/usr/bin/env node
/**
 * alipay-miniprogram-mcp — 支付宝小程序开发者工具 MCP 服务器
 *
 * 通过 minidev（支付宝官方 CLI/SDK）提供：
 *   编译验证 / 项目静态分析 / 真机预览 / 真机调试 / Web 模拟器 /
 *   DevServer 日志收集与智能分析 / 代码上传 / 版本管理 / 边界测试矩阵
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WorkerClient } from './src/workerClient.mjs';
import { LogStore, SessionRegistry } from './src/state.mjs';
import { buildTools } from './src/tools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';

// ---------- 目录与环境 ----------
const dataDir = process.env.MP_DATA_DIR
  ? path.resolve(process.env.MP_DATA_DIR)
  : path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const stateFile = path.join(dataDir, 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8'); } catch { /* 忽略 */ }
}

/** 项目路径解析：显式参数 > 上次使用的项目 */
function resolveProject(p) {
  const state = loadState();
  let target = p ?? state.lastProject;
  if (!target) {
    throw new Error('缺少项目路径：请传 project 参数（项目根目录，含 app.json）');
  }
  target = path.resolve(target);
  if (!fs.existsSync(path.join(target, 'app.json'))) {
    throw new Error(`目录 ${target} 下没有 app.json，请确认是小程序项目根目录`);
  }
  if (target !== state.lastProject) saveState({ ...state, lastProject: target });
  return target;
}

// ---------- 组件装配 ----------
const worker = new WorkerClient();
const logStore = new LogStore(dataDir);
const sessions = new SessionRegistry();

const notify = (level, data) => {
  server.sendLoggingMessage({ level, data }).catch(() => { /* 客户端不支持日志通知时静默 */ });
};

const tools = buildTools({ worker, logStore, sessions, resolveProject, dataDir, notify });
const toolMap = new Map(tools.map((t) => [t.name, t]));

// ---------- MCP 服务器 ----------
const server = new Server(
  { name: 'alipay-miniprogram-mcp', version: VERSION },
  { capabilities: { tools: {}, logging: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = toolMap.get(name);
  if (!tool) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `未知工具: ${name}` }) }], isError: true };
  }
  // 必填参数校验
  const required = tool.inputSchema?.required ?? [];
  const missing = required.filter((k) => args?.[k] === undefined);
  if (missing.length) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `缺少必填参数: ${missing.join(', ')}` }) }],
      isError: true,
    };
  }
  try {
    return await tool.handler(args ?? {});
  } catch (e) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e?.message ?? String(e) }) }],
      isError: true,
    };
  }
});

// ---------- 启动 ----------
process.on('exit', () => worker.dispose());
process.on('SIGINT', () => { worker.dispose(); process.exit(0); });
process.on('SIGTERM', () => { worker.dispose(); process.exit(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[alipay-miniprogram-mcp] v${VERSION} ready · dataDir=${dataDir}\n`);
