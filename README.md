# Vidu S1 Demo 录制器

用 Vidu S1 API 录制 demo 视频：**主画面是 S1 生成的数字人视频，右下角小窗格是本地摄像头，音频是 S1 声音 + 你的麦克风混成的单声道。**

录制结果直接落盘为 `recordings/*.webm`，并自动用 ffmpeg 转一份 `*.mp4`（H.264 + AAC 单声道）。

---

## 快速开始

```bash
npm install
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
# 编辑 .env 填入 VIDU_API_KEY
npm start
```

打开 <http://localhost:5178>，然后：

1. 右侧填人设 `persona` 与形象图 `image_uri`（也可以选本地图片点「上传本地图片」）
2. 点 **创建会话并连接**，浏览器会请求摄像头和麦克风权限
3. 等状态变成「已连接」、画面出图后，点 **● 开始录制**
4. 对着麦克风说话；也可以在输入框发文本让数字人回应
5. 点 **■ 停止并保存** → 日志里会打印落盘路径

> 录制时**戴耳机**。用扬声器时 S1 的声音会被麦克风二次拾取，混音里会出现回声。

---

## 为什么需要这个本地后端

浏览器直连 Vidu 有两个绕不过去的限制，`server/index.mjs` 就是为了补这两点：

| 限制 | 解决方式 |
| --- | --- |
| WebSocket API 无法自定义 `Authorization` 头，而 `/live/ws/live/connect` 要求 `Token vda_xxx` | 后端代理 `/api/ws` → `wss://{host}/live/ws/live/connect`，转发时补上头 |
| 直接从页面调 `api.vidu.cn` 会跨域，且 API Key 会暴露在前端 | HTTP 接口全部经 `/api/*` 代理，Key 只存在于 `.env` |

顺带做了：录像落盘、ffprobe 校验声道数、ffmpeg 转 mp4。

---

## 录制链路是怎么搭起来的

```
POST /live/v1/lives  ──►  live_id + rtc{token,user_id}
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
   WS 控制链路 (经本地代理)            AliRTC 媒体链路
   conn_init / text_msg /            joinChannel + publish
   audio_interrupted / hangup        订阅数字人音视频
              └───────────────┬───────────────┘
                              ▼
              canvas 合成 (主画面 + 画中画)
              WebAudio 混音 (S1 + 麦克风 → 单声道)
                              ▼
                    MediaRecorder → webm → 落盘 → mp4
```

两条链路并行建立，缺一不可：WS 只走控制信令，音视频全部走 AliRTC。

### 关键实现点

**画面合成** — `public/lib/compositor.js`
`requestAnimationFrame` 里把两个 `<video>` 画进同一张 canvas：主画面按 cover/contain 铺满，画中画带圆角、白边和阴影贴在指定角上。canvas 尺寸默认跟随 S1 出图分辨率（避免黑边），也可以在面板里锁定成 1080×1920 等固定值。最终录的就是这张 canvas，所见即所得。

**单声道混音** — `public/lib/recorder.js`
S1 音频和麦克风各接一个 `GainNode`，汇入一个 `channelCount = 1, channelCountMode = 'explicit'` 的总线节点，WebAudio 在这一级就完成降混，再进 `MediaStreamAudioDestinationNode`。落盘后服务端用 ffprobe 复核声道数并打进日志；转 mp4 时还有 `-ac 1` 兜底。

**拿到 S1 的音频轨道** — `public/rtc-tap.js`
这是唯一一处「非常规」做法，值得说明。AliRTC Web SDK 只提供 `setRemoteViewConfig(videoElement, …)` 把远端画面绑到 `<video>` 上；远端音频由 SDK 内部自己 `new Audio()` 播放，**没有任何公开 API 能拿到原始 `MediaStreamTrack`**（已确认 SDK 7.1.9 bundle 里不存在 `getRemoteAudioTrack` 之类的接口）。而要把 S1 的声音送进 `AudioContext` 混音，就必须拿到 track 本身。

所以 `rtc-tap.js` 在 SDK 加载**之前**用一个 `extends RTCPeerConnection` 的子类替换 `window.RTCPeerConnection`，监听 `track` 事件收集远端轨道。SDK 底层终究走标准 WebRTC，这个位置是稳的。同一个拦截器还从 `pc.getSenders()` 取本端麦克风和摄像头轨道 —— 这样就**不用对同一个设备做第二次 `getUserMedia`**，避免设备争用。

兜底顺序（每一级都会写进日志，能看出实际用的是哪条）：

| 素材 | 首选 | 兜底 |
| --- | --- | --- |
| 数字人画面 | `setRemoteViewConfig` 绑定的 `<video>` | 拦截到的远端 video track |
| 数字人音频 | 拦截到的远端 audio track | 扫描 DOM 里 SDK 播放元素的 `srcObject` |
| 麦克风 | RTC sender 上的 audio track | 独立 `getUserMedia({audio})` |
| 摄像头 | RTC sender 上的 video track | 独立 `getUserMedia({video})` |

`audio` 模式下 SDK 不采集摄像头，画中画必然走 `getUserMedia` 兜底。

---

## 面板参数

**数字人配置** — `call_mode`（video 模式 S1 能看到你）、`persona`、`image_uri`、`voice`、开场问候提示。

**打断与对话** — `vad.type`（`server` 过滤附和 / `semantic` 开口即打断）、静音触发时长、`idle_timeout_ms`（>0 时数字人会主动开口）、`max_tokens`、语音转写开关。开了转写后字幕会打进日志。

**画面合成** — 输出尺寸、主画面缩放方式、画中画位置/大小/镜像/白边、录制帧率。都可以在录制前随时调，画面即时反映（画布尺寸在录制中锁定）。

**音频** — S1 与麦克风各自的增益，录制中可实时调整。

---

## 输出文件

| 文件 | 说明 |
| --- | --- |
| `recordings/vidu-s1-demo-<时间戳>.webm` | MediaRecorder 原始输出，VP9/VP8 + Opus 单声道 |
| `recordings/vidu-s1-demo-<时间戳>.mp4` | 自动转码，H.264 + AAC 单声道、恒定 30fps、`+faststart` |

日志里还会给一个下载链接，可以另存一份到浏览器下载目录。

漏转或想重转：

```bash
npm run mp4                                   # 转所有还没有 mp4 的
npm run mp4 -- vidu-s1-demo-2026-08-05.webm   # 只转指定文件
```

---

## 注意事项

- **单次会话最长 600 秒**（`live.live_duration`），超时服务端会 `force_hangup`。状态栏有倒计时；如果超时那一刻还在录制，会自动停止并保存已录内容，不会丢。
- **录制期间别把标签页切到后台**。`requestAnimationFrame` 在后台标签会被节流到 1fps 左右，录出来的画面会卡。可以切别的窗口，但要让这个标签保持可见。
- 浏览器用 **Chrome / Edge**。依赖 `MediaRecorder` + `canvas.captureStream()`，Safari 支持不全。
- `http://localhost` 属于安全上下文，摄像头麦克风权限没问题，不用配 HTTPS 证书。
- `video` 模式创建成功不代表数字人渲染侧已就绪，`conn_init` 可能返回 `NOT_READY`。已按文档做指数退避重试（最多 8 次），日志里能看到重试过程。
- 海外环境把 `.env` 里的 `VIDU_HOST` 改成 `api.vidu.com`。
- 这台机器上有 `HTTP_PROXY=http://127.0.0.1:7897`。Node 的 `fetch` 默认**不走**环境变量代理，所以后端是直连 `api.vidu.cn`。如果你的网络必须经代理才能出网，用 `NODE_USE_ENV_PROXY=1 npm start` 启动。

---

## 目录结构

```
server/index.mjs          HTTP 代理 + WS 代理 + 静态服务 + 录像落盘/转码
public/index.html         界面
public/rtc-tap.js         RTCPeerConnection 拦截器（必须在 SDK 之前加载）
public/vendor/            AliRTC Web SDK 7.1.9（已本地固定版本）
public/app.js             主流程编排
public/lib/vidu-ws.js     S1 控制信令（conn_init / text_msg / 打断 / 挂断）
public/lib/alirtc.js      AliRTC 入会、发布、订阅封装
public/lib/compositor.js  canvas 画面合成
public/lib/recorder.js    单声道混音 + MediaRecorder
scripts/to-mp4.mjs        webm 批量转 mp4
recordings/               输出目录
```
