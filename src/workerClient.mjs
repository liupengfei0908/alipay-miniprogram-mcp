/**
 * workerClient.mjs — worker 子进程的 RPC 客户端
 * 行式 JSON 协议；无法解析的行（minidev 噪音）安全忽略。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class WorkerClient {
  constructor({ env } = {}) {
    this.env = env;
    this.proc = null;
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject }
    this.eventHandlers = new Set();
    this.ready = false;
    this.exitWaiters = [];
  }

  _ensure() {
    if (this.proc) return this.proc;
    this.proc = spawn(process.execPath, [path.join(__dirname, 'worker.mjs')], {
      cwd: __dirname,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const rl = readline.createInterface({ input: this.proc.stdout, terminal: false });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; } // 忽略噪音行
      if (typeof msg?.id !== 'undefined' && msg.stream === 'event') {
        for (const h of this.eventHandlers) {
          try { h(msg.name, msg.data, msg.id); } catch { /* 处理器异常不影响主流程 */ }
        }
        return;
      }
      const p = this.pending.get(msg?.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else {
        const e = new Error(msg.error?.message ?? 'worker error');
        e.code = msg.error?.code;
        e.stack = msg.error?.stack ?? e.stack;
        p.reject(e);
      }
    });
    this.proc.stderr.on('data', () => { /* 丢弃 worker 的 stderr 噪音 */ });
    this.proc.on('exit', (code) => {
      this.proc = null;
      this.ready = false;
      for (const [, p] of this.pending) p.reject(new Error(`worker 已退出 (code=${code})`));
      this.pending.clear();
      for (const w of this.exitWaiters) w(code);
      this.exitWaiters = [];
    });
    this.ready = true;
    return this.proc;
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** 调用一个 worker 操作 */
  call(op, args = {}) {
    this._ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, op, args }) + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new Error(`写入 worker 失败: ${err.message}`));
        }
      });
    });
  }

  onExit(waiter) {
    this.exitWaiters.push(waiter);
  }

  dispose() {
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
