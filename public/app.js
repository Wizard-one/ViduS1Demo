import { Compositor } from '/lib/compositor.js';
import { MixRecorder } from '/lib/recorder.js';
import { ViduSignaling, sleep } from '/lib/vidu-ws.js';
import { RtcClient } from '/lib/alirtc.js';

const $ = (id) => document.getElementById(id);
const tap = window.__rtcTap;

const ui = {
  cfgBadge: $('cfgBadge'), stateBadge: $('stateBadge'), chBadge: $('chBadge'),
  fpsBadge: $('fpsBadge'), sizeBadge: $('sizeBadge'),
  canvas: $('stage'), placeholder: $('placeholder'), recDot: $('recDot'), recTime: $('recTime'),
  log: $('log'), verbose: $('verbose'), liveInfo: $('liveInfo'), lvlMix: $('lvlMix'),
  btnConnect: $('btnConnect'), btnRec: $('btnRec'), btnStop: $('btnStop'),
  btnInterrupt: $('btnInterrupt'), btnHangup: $('btnHangup'), btnSend: $('btnSend'),
  btnUpload: $('btnUpload'), btnVoices: $('btnVoices'), btnBill: $('btnBill'),
  textInput: $('textInput'), imageFile: $('imageFile'),
};

const state = {
  live: null, rtc: null, sig: null, rtcClient: null,
  compositor: new Compositor(ui.canvas), recorder: null,
  canvasStream: null, mainVideo: null, pipVideo: null, ownStreams: [], untap: null,
  connected: false, hangingUp: false, lastFrames: 0, lastFpsAt: performance.now(),
};

// ---------- 日志 ----------
function log(msg, cls = '') {
  const row = document.createElement('div');
  const t = new Date().toTimeString().slice(0, 8);
  row.innerHTML = `<span class="t">${t}</span><span class="${cls}"></span>`;
  row.lastChild.textContent = msg;
  ui.log.appendChild(row);
  ui.log.scrollTop = ui.log.scrollHeight;
  while (ui.log.childElementCount > 500) ui.log.firstChild.remove();
}
function setState(text, cls = '') {
  ui.stateBadge.textContent = text;
  ui.stateBadge.className = `badge ${cls}`;
}

// ---------- 隐藏的取帧用 video 元素 ----------
function makeVideoEl(id) {
  const v = document.createElement('video');
  v.id = id;
  v.autoplay = true;
  v.playsInline = true;
  v.muted = true; // 声音走 WebAudio，元素本身静音避免二次播放
  v.setAttribute('playsinline', '');
  v.style.cssText = 'position:fixed;left:-10000px;top:0;width:4px;height:4px;opacity:0.01;pointer-events:none';
  document.body.appendChild(v);
  return v;
}

function attachTrack(videoEl, track) {
  const cur = videoEl.srcObject;
  if (cur && cur.getVideoTracks?.()[0] === track) return;
  videoEl.srcObject = new MediaStream([track]);
  videoEl.play().catch(() => {});
}

// ---------- 表单 -> 创建会话请求体 ----------
function buildCreateBody() {
  const callMode = $('callMode').value;
  const body = {
    call_mode: callMode,
    avatar: {
      persona: $('persona').value.trim(),
      image_uri: $('imageUri').value.trim(),
      voice: $('voice').value.trim() || 'Tina',
    },
    extra_motion: $('extraMotion').checked,
    audio: { enable_transcription: $('transcription').checked },
    vad: {
      type: $('vadType').value,
      threshold: 0.5,
      silence_duration_ms: Number($('silence').value),
      idle_timeout_ms: Number($('idleMs').value),
    },
    llm: { max_tokens: Number($('maxTokens').value) },
    idle_timeout_seconds: 7200,
  };
  const greeting = $('greeting').value.trim();
  if (greeting) body.avatar.greeting_instruction = greeting;
  if (!body.avatar.persona) throw new Error('persona 不能为空');
  if (!body.avatar.image_uri) throw new Error('image_uri 不能为空');
  return body;
}

async function api(path, { method = 'GET', body, headers } = {}) {
  const res = await fetch(path, { method, body, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new Error(data.message || data.reason || `HTTP ${res.status}`);
  return data;
}

// ---------- 主流程 ----------
async function connect() {
  ui.btnConnect.disabled = true;
  try {
    const body = buildCreateBody();
    setState('创建会话…', 'busy');
    log(`创建 Live：call_mode=${body.call_mode} voice=${body.avatar.voice}`);
    const created = await api('/api/lives', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.live = created.live;
    state.rtc = created.rtc;
    log(`会话已创建 live_id=${created.live.id} status=${created.live.status} 最长 ${created.live.live_duration}s`, 'ok');
    renderLiveInfo();
    ui.btnBill.disabled = false;

    state.recorder = new MixRecorder({ canvas: ui.canvas, fps: Number($('fps').value) });
    state.recorder.setMonitor($('monitor').checked);
    // 录制时的视频源：在连接阶段建一次，跟随 canvas 实际绘制节奏（含空帧节流→帧率稳定、不卡顿）
    state.canvasStream = ui.canvas.captureStream(0);

    // 控制链路与媒体链路并行建立，两条都通才算 ready
    const control = startSignaling(created.live.id);
    const media = startMedia(created.rtc, body.call_mode);
    await Promise.all([control, media]);

    // 等数字人出图后再定画布尺寸，避免录制过程中改尺寸打断编码
    setState('等待数字人画面…', 'busy');
    if (await waitForMainVideo(20000)) {
      log(`数字人画面已出图 ${state.mainVideo.videoWidth}×${state.mainVideo.videoHeight}`, 'ok');
    } else {
      log('20 秒内没有拿到数字人画面，其余功能仍可用；请检查 image_uri 与 call_mode', 'error');
    }
    applyOutputSize();

    state.connected = true;
    ui.placeholder.classList.add('hidden');
    setState('已连接', 'ok');
    ui.btnRec.disabled = true; // 自动录制接管，手动按钮本会话不再开始
    ui.btnHangup.disabled = false;
    ui.btnInterrupt.disabled = false;
    ui.btnSend.disabled = false;
    ui.textInput.disabled = false;
    log('控制链路与媒体链路均已就绪，可以开始录制', 'ok');
    startLiveCountdown();

    // 一连上就自动开始录制；结束后通过「■ 停止并保存」保存
    ui.btnRec.disabled = true;
    await startRecording();
    log('已自动开始录制，点「■ 停止并保存」结束', 'ok');
  } catch (err) {
    log(`连接失败: ${err.message}`, 'error');
    setState('失败', 'bad');
    ui.btnConnect.disabled = false;
    await teardown({ hangup: true });
  }
}

async function startSignaling(liveId) {
  const sig = new ViduSignaling({
    liveId,
    onEvent: (e) => {
      if (e.type === 'message' && ui.verbose.checked) log(`WS ← ${JSON.stringify(e.msg)}`);
      if (e.type === 'sent' && ui.verbose.checked) log(`WS → ${JSON.stringify(e.msg)}`);
      if (e.type === 'transcript') log(`字幕: ${e.text}`, 'say');
      if (e.type === 'init-retry') log(`数字人渲染侧未就绪(NOT_READY)，${e.wait}ms 后重试 conn_init (${e.attempt}/${e.attempts})`, 'warn');
      if (e.type === 'proxy') log(`代理: ${JSON.stringify(e.info)}`, 'warn');
      if (e.type === 'force-hangup') {
        log(`服务端强制挂断: ${e.reason}`, 'error');
        onSessionEnded(`force_hangup:${e.reason}`);
      }
      if (e.type === 'ws-close') {
        log(`WS 已关闭 code=${e.code} ${e.reason || ''}`, 'warn');
        if (state.connected) onSessionEnded(`ws_close:${e.code}`);
      }
      if (e.type === 'ws-error') log(`WS 错误: ${e.message}`, 'error');
    },
  });
  state.sig = sig;
  await sig.connect();
  log('WebSocket 已连接，发送 conn_init…');
  const ack = await sig.init();
  log(`conn_init 成功 server_timestamp=${ack.server_timestamp}`, 'ok');
}

async function startMedia(rtc, callMode) {
  state.mainVideo = makeVideoEl('mainVideo');
  state.pipVideo = makeVideoEl('pipVideo');
  state.compositor.setMain(state.mainVideo);
  state.compositor.setPip(state.pipVideo);
  applyCompositorOptions();
  state.compositor.start();

  const client = new RtcClient({
    onLog: (m, cls) => log(`[rtc] ${m}`, cls || ''),
    onRemoteVideo: (userId, streamType) => {
      if (client.bindRemoteView(state.mainVideo, userId, streamType)) {
        log(`主画面已绑定 ${userId} (streamType=${streamType})`, 'ok');
      }
    },
  });
  state.rtcClient = client;

  // 拦截器一拿到远端音频就接进混音总线
  state.untap = tap.on((e) => {
    if (e.type === 'remote-track' && e.kind === 'audio') addRemoteAudio(e.track);
  });

  await client.join({ rtc, callMode });

  // --- 数字人音频 ---
  const botTracks = await tap.waitFor('remote', 'audio', 20000);
  if (botTracks.length) botTracks.forEach(addRemoteAudio);
  else {
    const dom = tap.scanDomTracks('audio');
    if (dom.length) {
      log(`拦截器没抓到远端音频，改用 SDK 播放元素上的轨道 (${dom.length} 路)`, 'warn');
      dom.forEach(addRemoteAudio);
    } else {
      log('未获取到数字人音频轨道，录制将只有你的声音', 'error');
    }
  }

  // --- 本地麦克风：优先复用 SDK 已经采集的轨道，避免二次打开设备 ---
  let micTracks = await tap.waitFor('local', 'audio', 8000);
  if (!micTracks.length) {
    log('未从 RTC sender 取到麦克风轨道，回退到独立 getUserMedia', 'warn');
    const s = await getOwn({ audio: true });
    micTracks = s ? s.getAudioTracks() : [];
  }
  if (micTracks.length) {
    state.recorder.addAudio('mic', micTracks[0], Number($('gainMic').value) / 100);
    log(`麦克风已接入混音: ${micTracks[0].label || micTracks[0].id}`, 'ok');
  } else {
    log('没有可用麦克风，录制将只有数字人声音', 'error');
  }

  // --- 画中画摄像头 ---
  let camTracks = callMode === 'video' ? await tap.waitFor('local', 'video', 8000) : [];
  if (!camTracks.length) {
    if (callMode === 'video') log('未从 RTC sender 取到摄像头轨道，回退到独立 getUserMedia', 'warn');
    const s = await getOwn({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    camTracks = s ? s.getVideoTracks() : [];
  }
  if (camTracks.length) {
    attachTrack(state.pipVideo, camTracks[0]);
    log(`画中画摄像头已接入: ${camTracks[0].label || camTracks[0].id}`, 'ok');
  } else {
    log('没有可用摄像头，画中画将为空', 'warn');
  }
}

function addRemoteAudio(track) {
  if (!track || track.readyState !== 'live') return;
  const label = `bot:${track.id.slice(0, 8)}`;
  if (state.recorder?.addAudio(label, track, Number($('gainBot').value) / 100)) {
    log(`数字人音频已接入混音 (${label})`, 'ok');
  }
}

/** 轮询等主画面出图；setRemoteViewConfig 没触发时改用拦截到的远端视频轨道兜底 */
async function waitForMainVideo(timeoutMs) {
  const el = state.mainVideo;
  const t0 = Date.now();
  let fellBack = false;
  while (Date.now() - t0 < timeoutMs) {
    if (state.mainVideo !== el) return false; // 期间已断开重连
    if (el.videoWidth > 0) return true;
    if (!fellBack) {
      const [t] = tap.remoteTracks('video');
      if (t) {
        attachTrack(el, t);
        fellBack = true;
        log('主画面改用拦截到的远端视频轨道兜底', 'warn');
      }
    }
    await sleep(400);
  }
  return el.videoWidth > 0;
}

async function getOwn(constraints) {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      audio: constraints.audio
        ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : false,
      video: constraints.video || false,
    });
    state.ownStreams.push(s);
    return s;
  } catch (err) {
    log(`getUserMedia 失败: ${err.name} ${err.message}`, 'error');
    return null;
  }
}

// ---------- 录制 ----------
async function startRecording() {
  try {
    state.recorder.fps = Number($('fps').value);
    const info = await state.recorder.start();
    ui.btnRec.disabled = true;
    ui.btnStop.disabled = false;
    ui.recDot.classList.remove('hidden');
    ui.chBadge.textContent = `声道 ${info.channels}`;
    ui.chBadge.className = `badge sm ${info.channels === 1 ? 'ok' : 'bad'}`;
    log(`开始录制 ${info.mimeType} 声道数=${info.channels} 画布=${ui.canvas.width}×${ui.canvas.height}`, 'ok');
    if (info.channels !== 1) log('浏览器未按单声道输出，保存时 ffmpeg 会用 -ac 1 兜底转单声道', 'warn');
  } catch (err) {
    log(`开始录制失败: ${err.message}`, 'error');
  }
}

async function stopRecording() {
  if (!state.recorder?.recording) return;
  ui.btnStop.disabled = true;
  const seconds = state.recorder.elapsed;
  try {
    const blob = await state.recorder.stop();
    ui.recDot.classList.add('hidden');
    ui.btnRec.disabled = !state.connected;
    log(`录制结束 ${seconds.toFixed(1)}s ${(blob.size / 1e6).toFixed(1)} MB，上传保存中…`);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `vidu-s1-demo-${stamp}.webm`;
    const res = await api(`/api/recordings?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    log(`已保存 ${res.webm}`, 'ok');
    if (res.audio) {
      log(`音轨校验: ${res.audio.codec} ${res.audio.channels} 声道 ${res.audio.sampleRate}Hz`, res.audio.channels === 1 ? 'ok' : 'warn');
    }
    if (res.mp4) log(`已转码 ${res.mp4}`, 'ok');
    else if (res.mp4Error) log(`mp4 转码失败（webm 仍可用）: ${res.mp4Error}`, 'warn');

    offerDownload(blob, name);
  } catch (err) {
    log(`保存失败: ${err.message}`, 'error');
  }
}

function offerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.textContent = `另存一份到浏览器下载目录：${name}`;
  a.style.color = '#9fc4ff';
  const row = document.createElement('div');
  row.appendChild(a);
  ui.log.appendChild(row);
  ui.log.scrollTop = ui.log.scrollHeight;
}

// ---------- 结束 ----------
async function onSessionEnded(why) {
  if (!state.connected) return;
  state.connected = false;
  setState('已结束', 'bad');
  log(`会话结束 (${why})`, 'warn');
  if (state.recorder?.recording) {
    log('检测到正在录制，自动停止并保存本次内容', 'warn');
    await stopRecording();
  }
  await teardown({ hangup: false });
  ui.btnConnect.disabled = false;
  ui.btnRec.disabled = true;
  ui.btnStop.disabled = true;
  ui.btnInterrupt.disabled = true;
  ui.btnHangup.disabled = true;
  ui.btnSend.disabled = true;
  ui.textInput.disabled = true;
}

async function hangup() {
  if (state.hangingUp) return;
  state.hangingUp = true;
  ui.btnHangup.disabled = true;
  log('主动挂断…');
  if (state.recorder?.recording) await stopRecording();
  state.sig?.hangup('user_end');
  await sleep(300);
  await onSessionEnded('user_end');
  state.hangingUp = false;
}

async function teardown({ hangup: doHangup }) {
  stopLiveCountdown();
  state.untap?.();
  state.untap = null;
  if (doHangup) state.sig?.hangup('user_end');
  state.sig?.close();
  state.sig = null;
  await state.rtcClient?.leave();
  state.rtcClient = null;
  state.compositor.stop();
  for (const s of state.ownStreams.splice(0)) s.getTracks().forEach((t) => t.stop());
  if (state.recorder) {
    await state.recorder.close();
    state.recorder = null;
  }
  state.mainVideo?.remove();
  state.pipVideo?.remove();
  state.mainVideo = state.pipVideo = null;
  ui.placeholder.classList.remove('hidden');
}

// ---------- 会话信息与倒计时 ----------
function renderLiveInfo(extra) {
  const l = state.live || {};
  const r = state.rtc || {};
  ui.liveInfo.textContent = [
    `live_id      ${l.id}`,
    `status       ${l.status}`,
    `call_mode    ${l.call_mode}`,
    `最长时长     ${l.live_duration}s`,
    `channel_id   ${r.channel_id || '-'}`,
    `user_id      ${r.user_id || '-'}`,
    extra || '',
  ].join('\n');
}

let countdownTimer = 0;
function startLiveCountdown() {
  const max = Number(state.live?.live_duration || 600);
  const t0 = Date.now();
  stopLiveCountdown();
  countdownTimer = setInterval(() => {
    const left = Math.max(0, max - Math.round((Date.now() - t0) / 1000));
    setState(`已连接 · 剩余 ${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`, left > 30 ? 'ok' : 'busy');
    if (left === 0) stopLiveCountdown();
  }, 1000);
}
function stopLiveCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = 0;
}

// ---------- 合成参数 ----------
function applyCompositorOptions() {
  state.compositor.setOptions({
    fit: $('fit').value,
    pipScale: Number($('pipScale').value) / 100,
    pipCorner: $('pipCorner').value,
    pipMirror: $('pipMirror').checked,
    pipBorder: $('pipBorder').checked,
    showPip: $('showPip').checked,
  });
}

function applyOutputSize() {
  if (state.recorder?.recording) {
    log('录制中不能改画布尺寸，请先停止录制', 'warn');
    return;
  }
  const v = $('outSize').value;
  if (v === 'auto') {
    if (!state.compositor.autoSize()) state.compositor.resize(720, 1280);
  } else {
    const [w, h] = v.split('x').map(Number);
    state.compositor.resize(w, h);
  }
  ui.sizeBadge.textContent = `${ui.canvas.width}×${ui.canvas.height} px`;
}

// ---------- 仪表刷新 ----------
setInterval(() => {
  if (state.recorder) {
    const lvl = Math.min(1, state.recorder.level() * 4);
    ui.lvlMix.style.width = `${(lvl * 100).toFixed(1)}%`;
    if (state.recorder.recording) {
      const s = Math.floor(state.recorder.elapsed);
      ui.recTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }
  }
  const now = performance.now();
  if (now - state.lastFpsAt >= 1000) {
    const f = state.compositor.frames;
    ui.fpsBadge.textContent = `${Math.round(((f - state.lastFrames) * 1000) / (now - state.lastFpsAt))} fps`;
    state.lastFrames = f;
    state.lastFpsAt = now;
  }
}, 100);

// ---------- 事件绑定 ----------
ui.btnConnect.onclick = connect;
ui.btnRec.onclick = startRecording;
ui.btnStop.onclick = stopRecording;
ui.btnHangup.onclick = hangup;
ui.btnInterrupt.onclick = () => {
  try {
    state.sig.interrupt();
    log('已发送打断信号');
  } catch (e) {
    log(`打断失败: ${e.message}`, 'error');
  }
};

function sendText() {
  const text = ui.textInput.value.trim();
  if (!text) return;
  try {
    state.sig.sendText(text);
    log(`我(文本): ${text}`, 'say');
    ui.textInput.value = '';
  } catch (e) {
    log(`发送失败: ${e.message}`, 'error');
  }
}
ui.btnSend.onclick = sendText;
ui.textInput.onkeydown = (e) => {
  if (e.key === 'Enter') sendText();
};

ui.btnUpload.onclick = async () => {
  const file = ui.imageFile.files?.[0];
  if (!file) return log('先选择一个图片文件', 'warn');
  ui.btnUpload.disabled = true;
  try {
    log(`上传 ${file.name} (${(file.size / 1e6).toFixed(2)} MB)…`);
    const res = await api('/api/upload-image', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/png' },
      body: file,
    });
    $('imageUri').value = res.uri;
    log(`上传成功 image_uri=${res.uri}`, 'ok');
  } catch (e) {
    log(`上传失败: ${e.message}`, 'error');
  } finally {
    ui.btnUpload.disabled = false;
  }
};

ui.btnVoices.onclick = async () => {
  try {
    const res = await api('/api/voices');
    const list = (res.voices || []).map((v) => v.voice);
    log(`自定义音色 (${list.length}): ${list.join(', ') || '（空）'}`);
  } catch (e) {
    log(`拉取音色失败: ${e.message}`, 'error');
  }
};

ui.btnBill.onclick = async () => {
  try {
    const res = await api(`/api/lives/${state.live.id}`);
    const l = res.live || res;
    state.live = { ...state.live, ...l };
    renderLiveInfo(
      `billed       ${l.billed_seconds ?? '-'}s\ncredits      ${l.credits_cost ?? '-'}\ntrace_id     ${l.trace_id || '-'}`,
    );
    log(`状态=${l.status} 计费=${l.billed_seconds ?? '-'}s 积分=${l.credits_cost ?? '-'}`, 'ok');
  } catch (e) {
    log(`查询失败: ${e.message}`, 'error');
  }
};

for (const id of ['fit', 'pipCorner', 'pipScale', 'pipMirror', 'pipBorder', 'showPip']) {
  $(id).addEventListener('input', applyCompositorOptions);
}
$('outSize').addEventListener('change', applyOutputSize);
$('gainBot').addEventListener('input', (e) => {
  const g = Number(e.target.value) / 100;
  $('gBotLbl').textContent = `${e.target.value}%`;
  for (const label of state.recorder?.sources.keys() || []) {
    if (label.startsWith('bot:')) state.recorder.setGain(label, g);
  }
});
$('monitor').addEventListener('change', (e) => {
  state.recorder?.setMonitor(e.target.checked);
  if (e.target.checked) log('已开启 S1 监听；用扬声器时会造成回声，建议戴耳机', 'warn');
});
$('gainMic').addEventListener('input', (e) => {
  $('gMicLbl').textContent = `${e.target.value}%`;
  state.recorder?.setGain('mic', Number(e.target.value) / 100);
});
const labels = { silence: ['silLbl', (v) => v], maxTokens: ['tokLbl', (v) => v], pipScale: ['pipLbl', (v) => `${v}%`], fps: ['fpsLbl', (v) => v], idleMs: ['idleLbl', (v) => (v === '0' ? '0（关闭）' : `${v}`)] };
for (const [id, [lbl, fmt]] of Object.entries(labels)) {
  $(id).addEventListener('input', (e) => ($(lbl).textContent = fmt(e.target.value)));
}

window.addEventListener('beforeunload', (e) => {
  if (state.recorder?.recording) {
    e.preventDefault();
    e.returnValue = '正在录制，离开会丢失本次录像';
  } else if (state.connected) {
    state.sig?.hangup('user_end');
  }
});

// ---------- 启动自检 ----------
(async () => {
  try {
    const cfg = await api('/api/config');
    ui.cfgBadge.textContent = `${cfg.host} · ${cfg.hasKey ? 'Key 已配置' : 'Key 缺失'}`;
    ui.cfgBadge.className = `badge ${cfg.hasKey ? 'ok' : 'bad'}`;
    if (!cfg.hasKey) log('未配置 VIDU_API_KEY：复制 .env.example 为 .env 填入 Key 后重启服务', 'error');
    log(`录像保存目录: ${cfg.recordingsDir}`);
  } catch (e) {
    ui.cfgBadge.textContent = '后端不可用';
    ui.cfgBadge.className = 'badge bad';
  }
  if (!window.AliRtcEngine) log('AliRTC SDK 未加载成功，检查 public/vendor/aliyun-rtc-sdk.js', 'error');
  else log(`AliRTC SDK 就绪`);
  if (!window.MediaRecorder) log('浏览器不支持 MediaRecorder，请用 Chrome / Edge', 'error');
  else log(`录制格式: ${MixRecorder.pickMime() || '（浏览器默认）'}`);
  if (!tap) log('rtc-tap 未安装，数字人音频可能无法进入混音', 'error');
  ui.sizeBadge.textContent = `${ui.canvas.width}×${ui.canvas.height} px`;
})();
