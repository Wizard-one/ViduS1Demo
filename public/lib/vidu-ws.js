// Vidu S1 控制信令（经本地后端代理补 Authorization 头）
export const MSG = {
  CONN_INIT: 1,
  CONN_INIT_ACK: 2,
  CALL_HANGUP: 5,
  FORCE_HANGUP: 6,
  AUDIO_INTERRUPTED: 7,
  TEXT_MSG: 99,
};

export class ViduSignaling {
  constructor({ liveId, connId = `app-conn-${Date.now()}`, onEvent }) {
    this.liveId = String(liveId);
    this.connId = connId;
    this.onEvent = onEvent || (() => {});
    this.seq = 0;
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  emit(type, detail) {
    this.onEvent({ type, ...detail });
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/ws?live_id=${encodeURIComponent(this.liveId)}&conn_id=${encodeURIComponent(this.connId)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const failEarly = (e) => reject(new Error(`WebSocket 连接失败: ${e?.message || 'unknown'}`));
      ws.onopen = () => {
        ws.onerror = (e) => this.emit('ws-error', { message: String(e?.message || 'ws error') });
        resolve();
      };
      ws.onerror = failEarly;
      ws.onmessage = (ev) => this._onMessage(ev);
      ws.onclose = (ev) => {
        this.ready = false;
        this.closed = true;
        this.emit('ws-close', { code: ev.code, reason: ev.reason });
      };
    });
  }

  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket 未连接');
    const msg = {
      type,
      live_id: this.liveId,
      conn_id: this.connId,
      seq_id: ++this.seq,
      payload,
    };
    this.ws.send(JSON.stringify(msg));
    this.emit('sent', { msg });
    return msg;
  }

  /** conn_init，遇到 NOT_READY（video 模式渲染侧还没回连）指数退避重试 */
  async init({ attempts = 8 } = {}) {
    for (let i = 1; i <= attempts; i++) {
      const ack = await this._initOnce();
      if (ack.success) {
        this.ready = true;
        return ack;
      }
      if (ack.error_code !== 'NOT_READY') {
        throw new Error(`conn_init 失败: ${ack.error_code} ${ack.error_msg || ''}`);
      }
      const wait = Math.min(2000 * i, 6000);
      this.emit('init-retry', { attempt: i, attempts, wait });
      await sleep(wait);
    }
    throw new Error(`conn_init 持续返回 NOT_READY，已重试 ${attempts} 次`);
  }

  _initOnce() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAck = null;
        reject(new Error('conn_init 等待 ack 超时'));
      }, 15000);
      this._pendingAck = (ack) => {
        clearTimeout(timer);
        this._pendingAck = null;
        resolve(ack);
      };
      try {
        this.send(MSG.CONN_INIT, { conn_init: { version: 1 } });
      } catch (e) {
        clearTimeout(timer);
        this._pendingAck = null;
        reject(e);
      }
    });
  }

  sendText(content) {
    return this.send(MSG.TEXT_MSG, {
      text_msg: { msg_id: `m-${Date.now()}`, content, timestamp: Date.now() },
    });
  }

  interrupt() {
    return this.send(MSG.AUDIO_INTERRUPTED, {});
  }

  hangup(reason = 'user_end') {
    try {
      this.send(MSG.CALL_HANGUP, { hangup: { hangup_reason: reason } });
    } catch {}
  }

  close() {
    try {
      this.ws?.close(1000, 'client done');
    } catch {}
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      this.emit('raw', { data: String(ev.data).slice(0, 400) });
      return;
    }

    if (msg.__proxy) {
      this.emit('proxy', { info: msg });
      return;
    }

    this.emit('message', { msg });

    if (msg.type === MSG.CONN_INIT_ACK) {
      const ack = msg.payload?.conn_init_ack || {};
      this.emit('conn-init-ack', { ack });
      this._pendingAck?.(ack);
      return;
    }
    if (msg.type === MSG.FORCE_HANGUP) {
      this.emit('force-hangup', { reason: msg.payload?.hangup?.hangup_reason || 'unknown' });
      return;
    }
    // enable_transcription 打开后服务端会推转写结果，文档未固定 type，这里按字段兜底提取
    const text = extractText(msg.payload);
    if (text) this.emit('transcript', { text, msg });
  }
}

function extractText(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return null;
  for (const key of ['text', 'content', 'transcript', 'transcription']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object') {
      const found = extractText(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
