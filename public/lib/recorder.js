// 录制：画布视频 + 多路音频强制混成单声道
export class MixRecorder {
  constructor({ canvas, fps = 30, videoBitsPerSecond = 6_000_000 }) {
    this.canvas = canvas;
    this.fps = fps;
    this.videoBitsPerSecond = videoBitsPerSecond;
    this.sources = new Map(); // label -> {track, node, gain}
    this.chunks = [];
    this.recorder = null;
    this.startedAt = 0;

    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });

    // channelCount=1 + explicit：让 WebAudio 在这一级就把所有输入降混成单声道
    this.bus = new GainNode(this.ctx, {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    try {
      this.dest = new MediaStreamAudioDestinationNode(this.ctx, { channelCount: 1 });
    } catch {
      this.dest = this.ctx.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.dest.channelCountMode = 'explicit';
    }
    this.bus.connect(this.dest);

    // 监听：只把数字人的声音送到扬声器，方便万一听不到 S1 时救场（默认关）
    this.monitor = new GainNode(this.ctx, { gain: 0 });
    this.monitor.connect(this.ctx.destination);

    // 音量表
    this.analyser = new AnalyserNode(this.ctx, { fftSize: 512 });
    this.bus.connect(this.analyser);
    this._buf = new Float32Array(this.analyser.fftSize);
  }

  setMonitor(on) {
    this.monitor.gain.value = on ? 1 : 0;
  }

  get audioChannelCount() {
    return this.dest.stream.getAudioTracks()[0]?.getSettings?.().channelCount ?? this.dest.channelCount;
  }

  /** 把一路音频轨接进混音总线；同名 label 会先被移除 */
  addAudio(label, track, gain = 1) {
    if (!track || track.readyState !== 'live') return false;
    this.removeAudio(label);
    const node = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const g = new GainNode(this.ctx, { gain });
    node.connect(g).connect(this.bus);
    if (label.startsWith('bot')) g.connect(this.monitor);
    this.sources.set(label, { track, node, gain: g });
    track.addEventListener('ended', () => this.removeAudio(label));
    return true;
  }

  removeAudio(label) {
    const s = this.sources.get(label);
    if (!s) return;
    try {
      s.node.disconnect();
      s.gain.disconnect();
    } catch {}
    this.sources.delete(label);
  }

  setGain(label, value) {
    const s = this.sources.get(label);
    if (s) s.gain.gain.value = value;
  }

  level() {
    this.analyser.getFloatTimeDomainData(this._buf);
    let sum = 0;
    for (const v of this._buf) sum += v * v;
    return Math.sqrt(sum / this._buf.length);
  }

  static pickMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async start() {
    if (this.recorder) throw new Error('已经在录制中');
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const videoStream = this.canvas.captureStream(this.fps);
    const audioTrack = this.dest.stream.getAudioTracks()[0];
    if (!audioTrack) throw new Error('没有可用的音频轨道');
    const mixed = new MediaStream([...videoStream.getVideoTracks(), audioTrack]);

    const mimeType = MixRecorder.pickMime();
    this.chunks = [];
    this.recorder = new MediaRecorder(mixed, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: this.videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(1000); // 每秒一个分片，避免长录制丢数据
    this.startedAt = performance.now();
    this.mimeType = this.recorder.mimeType || mimeType;
    return { mimeType: this.mimeType, channels: this.audioChannelCount };
  }

  get elapsed() {
    return this.recorder ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  get recording() {
    return Boolean(this.recorder) && this.recorder.state === 'recording';
  }

  stop() {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec) return reject(new Error('未在录制'));
      rec.onstop = () => {
        this.recorder = null;
        resolve(new Blob(this.chunks, { type: this.mimeType || 'video/webm' }));
      };
      rec.onerror = (e) => reject(e.error || new Error('MediaRecorder 出错'));
      rec.stop();
    });
  }

  async close() {
    if (this.recorder) {
      try {
        await this.stop();
      } catch {}
    }
    for (const label of [...this.sources.keys()]) this.removeAudio(label);
    try {
      await this.ctx.close();
    } catch {}
  }
}
