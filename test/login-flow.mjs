/**
 * login-flow.mjs — 单连接完成 登录→展示二维码→轮询状态→验证授权
 * 解决：分次调用会各起新服务器进程、登录态不可见的问题。
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'index.mjs')],
});
const client = new Client({ name: 'login-flow', version: '0.0.0' });
client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
  if (n?.params?.data) console.error(`[通知] ${n.params.data}`);
});
await client.connect(transport);

const call = async (name, args = {}, timeout = 30_000) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = res.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return { __raw: text }; }
};

// 1-3. 发起登录 + 展示 + 轮询；二维码约 1 分钟过期，过期自动换新码重试
const deadline = Date.now() + 300_000;
let final = null;
let last = '';
let attempt = 0;

while (Date.now() < deadline && !final) {
  attempt += 1;
  const login = await call('mp_login');
  console.log(`\n[第 ${attempt} 个二维码] 状态: ${login.status} | ${login.qrCodeUrl ?? '(无)'}`);
  if (login.qrImageFile && fs.existsSync(login.qrImageFile)) {
    spawn('cmd.exe', ['/c', 'start', '', login.qrImageFile], { detached: true, stdio: 'ignore' }).unref();
    console.log(`已用系统图片查看器打开: ${login.qrImageFile}`);
  }
  if (login.qrCodeUrl) {
    const ascii = await QRCode.toString(login.qrCodeUrl, { type: 'terminal', small: true });
    console.log('===== 终端二维码（支付宝 App 内「扫一扫」，请尽快扫） =====');
    console.log(ascii);
  }

  // 单个二维码的轮询窗口（最长 70s，过期前换码）
  const qrDeadline = Date.now() + 70_000;
  while (Date.now() < qrDeadline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = await call('mp_login_status');
    if (st.status !== last) {
      console.log(`[${new Date().toLocaleTimeString()}] ${st.summary}`);
      last = st.status;
    }
    if (st.status === 'success') { final = st; break; }
    if (st.status === 'failed') {
      console.log('二维码已过期/失败，自动换新码…');
      break;
    }
  }
}

// 4. 成功后立即验证
if (final?.status === 'success') {
  const env = await call('mp_env_check');
  console.log('\n=== 授权后环境状态 ===');
  console.log(JSON.stringify(env, null, 2));
} else {
  console.log('\n未在时限内完成扫码；重新运行本命令即可获取新二维码');
}
await client.close();
