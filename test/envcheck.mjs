/**
 * envcheck.mjs — 命令行直连 MCP 服务器调用任意工具
 * 用法: node test/envcheck.mjs [工具名] [JSON参数]
 * 例:   node test/envcheck.mjs mp_env_check
 *       node test/envcheck.mjs mp_project_analyze '{"project":"C:\\path\\to\\project"}'
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tool = process.argv[2] ?? 'mp_env_check';
let toolArgs = {};
if (process.argv[3]) {
  try { toolArgs = JSON.parse(process.argv[3]); } catch { console.error('参数不是合法 JSON'); process.exit(2); }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'index.mjs')],
});
const client = new Client({ name: 'envcheck-cli', version: '0.0.0' });
await client.connect(transport);

// 中间日志通知（如登录二维码）也打印出来
client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
  if (n?.params?.data) console.error(`[通知] ${n.params.data}`);
});

try {
  // 长耗时工具（构建/预览/上传）可能超过 SDK 默认 60s
  const res = await client.callTool({ name: tool, arguments: toolArgs }, undefined, { timeout: 300_000 });
  for (const c of res.content ?? []) {
    if (c.type === 'text') console.log(c.text);
  }
  process.exitCode = res.isError ? 1 : 0;
} finally {
  await client.close();
}
