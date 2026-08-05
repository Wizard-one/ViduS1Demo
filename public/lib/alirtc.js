// AliRTC 媒体链路封装
const AliRtcEngine = window.AliRtcEngine;

export class RtcClient {
  constructor({ onLog, onRemoteVideo }) {
    if (!AliRtcEngine) throw new Error('AliRTC SDK 未加载（public/vendor/aliyun-rtc-sdk.js）');
    this.log = onLog || (() => {});
    this.onRemoteVideo = onRemoteVideo || (() => {});
    this.engine = AliRtcEngine.getInstance();
    this.joined = false;
    this.remoteUsers = new Set();
    this._bindEvents();
  }

  _bindEvents() {
    const e = this.engine;
    const on = (name, fn) => {
      try {
        e.on(name, fn);
      } catch (err) {
        this.log(`绑定事件 ${name} 失败: ${err.message}`, 'warn');
      }
    };

    on('remoteUserOnLineNotify', (userId) => {
      this.remoteUsers.add(userId);
      this.log(`远端用户上线: ${userId}`);
    });
    on('remoteUserOffLineNotify', (userId) => {
      this.remoteUsers.delete(userId);
      this.log(`远端用户离线: ${userId}`, 'warn');
    });
    on('videoSubscribeStateChanged', (userId, oldState, newState) => {
      this.log(`视频订阅状态 ${userId}: ${oldState} -> ${newState}`);
      if (isSubscribed(newState)) this.onRemoteVideo(userId, 1);
    });
    on('screenShareSubscribeStateChanged', (userId, oldState, newState) => {
      this.log(`屏幕流订阅状态 ${userId}: ${oldState} -> ${newState}`);
      if (isSubscribed(newState)) this.onRemoteVideo(userId, 2);
    });
    on('audioSubscribeStateChanged', (userId, oldState, newState) => {
      this.log(`音频订阅状态 ${userId}: ${oldState} -> ${newState}`);
    });
    on('bye', (code) => this.log(`收到 RTC bye: ${code}`, 'warn'));
    on('occurError', (err) => this.log(`RTC 错误: ${JSON.stringify(err)}`, 'error'));
    on('connectionStatusChange', (status, reason) => this.log(`RTC 连接状态: ${status} (${reason})`));
  }

  async join({ rtc, callMode }) {
    const e = this.engine;
    await safe(e.setDefaultSubscribeAllRemoteAudioStreams?.bind(e), true);
    await safe(e.setDefaultSubscribeAllRemoteVideoStreams?.bind(e), true);

    // rtc.token 是 base64(JSON)，SDK 会自行解出 appId/channelId/userId
    this.log(`joinChannel channel=${rtc.channel_id} user=${rtc.user_id}`);
    try {
      await e.joinChannel(rtc.token, rtc.user_id);
    } catch (err) {
      this.log(`token 直传入会失败(${err.message})，改用显式 authInfo 重试`, 'warn');
      await e.joinChannel(
        {
          appId: rtc.app_id,
          channelId: rtc.channel_id,
          userId: rtc.user_id,
          token: rtc.token,
          timestamp: Number(rtc.token_expire_at) || undefined,
        },
        rtc.user_id,
      );
    }
    this.joined = true;
    this.log('已加入 RTC 频道');

    await e.publishLocalAudioStream(true);
    this.log('已发布本地麦克风');
    if (callMode === 'video') {
      await e.publishLocalVideoStream(true);
      this.log('已发布本地摄像头');
    }
  }

  /** 把远端画面绑到我们的 <video> 上，合成器再从这个元素取帧 */
  bindRemoteView(videoEl, userId, streamType) {
    try {
      this.engine.setRemoteViewConfig(videoEl, userId, streamType);
      // 这个元素只是合成器的取帧源，声音走 WebAudio；SDK 另有内部 audio 元素负责播放
      videoEl.muted = true;
      videoEl.play?.().catch(() => {});
      return true;
    } catch (err) {
      this.log(`setRemoteViewConfig 失败: ${err.message}`, 'error');
      return false;
    }
  }

  bindLocalView(videoEl) {
    try {
      this.engine.setLocalViewConfig(videoEl, 1);
      videoEl.play?.().catch(() => {});
      return true;
    } catch (err) {
      this.log(`setLocalViewConfig 失败: ${err.message}`, 'warn');
      return false;
    }
  }

  async leave() {
    if (!this.joined) return;
    try {
      await this.engine.leaveChannel();
      this.log('已离开 RTC 频道');
    } catch (err) {
      this.log(`leaveChannel 失败: ${err.message}`, 'warn');
    }
    this.joined = false;
  }
}

function isSubscribed(state) {
  return state === 'subscribed' || state === 3;
}

async function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try {
    return await fn(...args);
  } catch {}
}
