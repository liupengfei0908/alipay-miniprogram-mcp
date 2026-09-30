/**
 * state.mjs — 运行时状态：日志环形缓冲 + JSONL 落盘 + 会话登记
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RING_LIMIT = 8000;

export class LogStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(this.logsDir, { recursive: true });
    /** sessionId -> { ring: [], file: string, meta: {} } */
    this.sessions = new Map();
  }

  _session(id, meta = {}) {
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        ring: [],
        file: path.join(this.logsDir, `${id}.jsonl`),
        meta: { ...meta, createdAt: new Date().toISOString() },
      });
    }
    return this.sessions.get(id);
  }

  /**
   * 追加一条日志
   * @param {string} sessionId
   * @param {{level?:string, source?:string, message:string, extra?:object}} entry
   */
  append(sessionId, entry, meta = {}) {
    const s = this._session(sessionId, meta);
    const rec = {
      ts: new Date().toISOString(),
      seq: s.ring.length + 1,
      level: entry.level ?? 'info',
      source: entry.source ?? 'devserver',
      message: entry.message,
      ...entry.extra,
    };
    s.ring.push(rec);
    if (s.ring.length > RING_LIMIT) s.ring.splice(0, s.ring.length - RING_LIMIT);
    try { fs.appendFileSync(s.file, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* 落盘失败不影响主流程 */ }
    return rec;
  }

  /**
   * 查询日志
   * @param {{sessionId?:string, level?:string, keyword?:string, tail?:number, since?:string, sources?:string[]}} q
   */
  query(q = {}) {
    const ids = q.sessionId ? [q.sessionId] : [...this.sessions.keys()];
    let rows = [];
    for (const id of ids) {
      const s = this.sessions.get(id);
      if (!s) continue;
      for (const r of s.ring) rows.push({ sessionId: id, ...r });
    }
    rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq));
    if (q.level) rows = rows.filter((r) => r.level === q.level);
    if (q.sources?.length) rows = rows.filter((r) => q.sources.includes(r.source));
    if (q.since) rows = rows.filter((r) => r.ts >= q.since);
    if (q.keyword) {
      const kw = q.keyword.toLowerCase();
      rows = rows.filter((r) => String(r.message).toLowerCase().includes(kw));
    }
    const total = rows.length;
    const tail = q.tail && q.tail > 0 ? rows.slice(-q.tail) : rows.slice(-500);
    return { total, returned: tail.length, entries: tail };
  }

  clear(sessionId) {
    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) { s.ring = []; try { fs.rmSync(s.file, { force: true }); } catch {} }
      return { cleared: [sessionId] };
    }
    this.sessions.clear();
    try { fs.rmSync(this.logsDir, { recursive: true, force: true }); fs.mkdirSync(this.logsDir, { recursive: true }); } catch {}
    return { cleared: 'all' };
  }

  listSessions() {
    return [...this.sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      entries: s.ring.length,
      meta: s.meta,
    }));
  }

  /** 读取本地 JSONL 文件（历史日志分析用） */
  loadFromFile(file) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { rows.push({ ts: '', level: 'unknown', source: 'raw', message: line }); }
    }
    return rows;
  }
}

export class SessionRegistry {
  constructor() {
    this.map = new Map();
  }
  create(kind, info = {}) {
    const id = `${kind}-${crypto.randomBytes(3).toString('hex')}-${Date.now() % 100000}`;
    this.map.set(id, { id, kind, createdAt: Date.now(), ...info });
    return id;
  }
  get(id) { return this.map.get(id); }
  set(id, info) {
    const cur = this.map.get(id) ?? { id, createdAt: Date.now() };
    this.map.set(id, { ...cur, ...info });
    return this.map.get(id);
  }
  delete(id) { this.map.delete(id); }
  list() {
    return [...this.map.values()].map(({ id, kind, createdAt, ...rest }) => ({
      id, kind, createdAt: new Date(createdAt).toISOString(),
      summary: rest.summary,
    }));
  }
}
