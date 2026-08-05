// 画面合成：数字人视频铺满主画面，本地摄像头画中画贴在角上
export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.main = null; // HTMLVideoElement
    this.pip = null; // HTMLVideoElement
    this.raf = 0;
    this.frames = 0;
    this.opts = {
      fit: 'cover', // cover | contain
      pipScale: 0.28, // 画中画宽度占主画面宽度的比例
      pipCorner: 'br', // br | bl | tr | tl
      pipMargin: 0.01, // 边距，占主画面宽度比例，越小越贴边
      pipMirror: true,
      pipRadius: 0.015, // 圆角，占主画面宽度比例
      pipBorder: true,
      showPip: true,
      background: '#000000',
    };
  }

  setMain(video) {
    this.main = video;
  }

  setPip(video) {
    this.pip = video;
  }

  setOptions(patch) {
    Object.assign(this.opts, patch);
  }

  /** 主画面就绪时按其宽高自动定画布尺寸，避免出现黑边 */
  autoSize(maxLong = 1920) {
    const v = this.main;
    if (!v || !v.videoWidth || !v.videoHeight) return false;
    let w = v.videoWidth;
    let h = v.videoHeight;
    const long = Math.max(w, h);
    if (long > maxLong) {
      const k = maxLong / long;
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    // H.264 要求偶数宽高
    this.resize(w - (w % 2), h - (h % 2));
    return true;
  }

  resize(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  start() {
    if (this.raf) return;
    const draw = () => {
      this.raf = requestAnimationFrame(draw);
      this.drawFrame();
    };
    this.raf = requestAnimationFrame(draw);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  drawFrame() {
    const { ctx, canvas, opts } = this;
    const W = canvas.width;
    const H = canvas.height;

    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, W, H);

    if (isReady(this.main)) {
      drawFitted(ctx, this.main, 0, 0, W, H, opts.fit, false);
    }

    if (opts.showPip && isReady(this.pip)) {
      const pw = Math.round(W * opts.pipScale);
      const ar = this.pip.videoWidth / this.pip.videoHeight;
      const ph = Math.round(pw / (ar || 16 / 9));
      const m = Math.round(W * opts.pipMargin);
      const x = opts.pipCorner.includes('l') ? m : W - pw - m;
      const y = opts.pipCorner.startsWith('t') ? m : H - ph - m;
      const r = Math.max(2, Math.round(W * opts.pipRadius));

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = Math.round(W * 0.012);
      ctx.shadowOffsetY = Math.round(W * 0.004);
      roundRect(ctx, x, y, pw, ph, r);
      ctx.fillStyle = '#000';
      ctx.fill();
      ctx.restore();

      ctx.save();
      roundRect(ctx, x, y, pw, ph, r);
      ctx.clip();
      drawFitted(ctx, this.pip, x, y, pw, ph, 'cover', opts.pipMirror);
      ctx.restore();

      if (opts.pipBorder) {
        ctx.save();
        ctx.lineWidth = Math.max(2, Math.round(W * 0.0035));
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        roundRect(ctx, x, y, pw, ph, r);
        ctx.stroke();
        ctx.restore();
      }
    }
    this.frames++;
  }
}

function isReady(v) {
  return v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
}

function drawFitted(ctx, video, x, y, w, h, fit, mirror) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = fit === 'contain' ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  if (mirror) {
    ctx.save();
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(video, dx, dy, dw, dh);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
