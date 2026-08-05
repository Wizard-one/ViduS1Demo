/*
 * RTCPeerConnection 拦截器 —— 必须在 AliRTC SDK 之前加载。
 *
 * 为什么需要它：AliRTC Web SDK 只提供 setRemoteViewConfig(videoElement,…) 把远端画面
 * 绑到 <video> 上，远端音频则由 SDK 内部自己 new 一个 <audio> 播放，
 * 没有任何公开 API 能拿到原始 MediaStreamTrack。而我们要把数字人音频
 * 送进 AudioContext 跟麦克风混成单声道，必须拿到 track 本身。
 * SDK 底层终究走标准 WebRTC，所以在这里把 track 事件和 sender 截下来即可。
 */
(function () {
  const Native = window.RTCPeerConnection;
  if (!Native) {
    console.error('[rtc-tap] 当前浏览器没有 RTCPeerConnection');
    return;
  }
  if (window.__rtcTap) return;

  const listeners = new Set();
  const tap = {
    pcs: [],
    remote: { audio: [], video: [] },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 远端（数字人）轨道，SDK 侧可能先给出 muted 轨道，这里只过滤已 ended 的 */
    remoteTracks(kind) {
      return tap.remote[kind].filter((t) => t.readyState === 'live');
    },
    /** 本端轨道直接从 sender 上取，避免对同一个摄像头/麦克风做第二次 getUserMedia */
    localTracks(kind) {
      const out = [];
      for (const pc of tap.pcs) {
        if (pc.signalingState === 'closed') continue;
        for (const s of pc.getSenders()) {
          if (s.track && s.track.kind === kind && s.track.readyState === 'live' && !out.includes(s.track)) {
            out.push(s.track);
          }
        }
      }
      return out;
    },
    /** 轮询等待某类轨道出现（入会/发布/订阅都是异步的） */
    waitFor(side, kind, timeoutMs = 20000) {
      const get = () => (side === 'remote' ? tap.remoteTracks(kind) : tap.localTracks(kind));
      const found = get();
      if (found.length) return Promise.resolve(found);
      return new Promise((resolve) => {
        const t0 = Date.now();
        const timer = setInterval(() => {
          const now = get();
          if (now.length) {
            clearInterval(timer);
            resolve(now);
          } else if (Date.now() - t0 > timeoutMs) {
            clearInterval(timer);
            resolve([]);
          }
        }, 200);
      });
    },
    /** 兜底：SDK 内部播放用的媒体元素上也挂着 srcObject */
    scanDomTracks(kind) {
      const out = [];
      for (const el of document.querySelectorAll('audio, video')) {
        const so = el.srcObject;
        if (!so || typeof so.getTracks !== 'function') continue;
        for (const t of so.getTracks()) {
          if (t.kind === kind && t.readyState === 'live' && !out.includes(t)) out.push(t);
        }
      }
      return out;
    },
  };

  const emit = (evt) => {
    for (const fn of listeners) {
      try {
        fn(evt);
      } catch (e) {
        console.error('[rtc-tap] listener error', e);
      }
    }
  };

  class TappedRTCPeerConnection extends Native {
    constructor(...args) {
      super(...args);
      tap.pcs.push(this);
      this.addEventListener('track', (e) => {
        const track = e.track;
        if (!track) return;
        const bucket = tap.remote[track.kind];
        if (!bucket || bucket.includes(track)) return;
        bucket.push(track);
        console.log(`[rtc-tap] 远端 ${track.kind} 轨道 id=${track.id} muted=${track.muted}`);
        track.addEventListener('ended', () => emit({ type: 'remote-ended', kind: track.kind, track }));
        track.addEventListener('unmute', () => emit({ type: 'remote-unmute', kind: track.kind, track }));
        emit({ type: 'remote-track', kind: track.kind, track, streams: e.streams });
      });
      this.addEventListener('connectionstatechange', () => {
        emit({ type: 'pc-state', state: this.connectionState });
      });
    }
  }

  // 保留静态方法（generateCertificate 等）
  for (const k of Object.getOwnPropertyNames(Native)) {
    if (['length', 'name', 'prototype'].includes(k)) continue;
    try {
      TappedRTCPeerConnection[k] = Native[k];
    } catch {}
  }

  window.RTCPeerConnection = TappedRTCPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = TappedRTCPeerConnection;
  window.__rtcTap = tap;
  console.log('[rtc-tap] 已安装');
})();
