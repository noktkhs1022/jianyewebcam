import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "./model.glb";
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// =====================================================
// モバイル性能ティア判定
// =====================================================
function detectPerformanceTier() {
  if (!IS_MOBILE) return "high";

  // メモリ情報（Chromeのみ）
  const mem = navigator.deviceMemory;
  if (mem !== undefined && mem <= 2) return "low";

  // DPR≥3は高性能機（iPhone 12以降など）
  if (window.devicePixelRatio >= 3) return "high";

  // コア数（目安）
  const cores = navigator.hardwareConcurrency || 2;
  if (cores <= 2) return "low";
  return "mid";
}

const PERF = detectPerformanceTier(); // "high" | "mid" | "low"

// =====================================================
// DOM
// =====================================================
const threeLayer = document.getElementById("three-layer");
const asciiCanvas = document.getElementById("ascii");
const asciiCtx = asciiCanvas.getContext("2d");

const video = document.getElementById("video");
const enableCameraBtn = document.getElementById("enableCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");

const sourceCanvas = document.createElement("canvas");
const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });

const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });

const personCanvas = document.createElement("canvas");
const personCtx = personCanvas.getContext("2d", { willReadFrequently: true });

// sampleCanvas を ASCII用とMP用で分離 → 競合解消
const sampleCanvasAscii = document.createElement("canvas");
const sampleCtxAscii = sampleCanvasAscii.getContext("2d", { willReadFrequently: true });

const sampleCanvasMp = document.createElement("canvas");
const sampleCtxMp = sampleCanvasMp.getContext("2d", { willReadFrequently: true });

// =====================================================
// STATE
// =====================================================
const state = {
  source: "object",
  webcamReady: false,
  segmentationReady: false,
  faceReady: false,
  modelReady: false,
  faceBoxNorm: null,
  zoom01: 0,
  glitchBurst: 0,
  mpBusy: false,
  lastMpTime: 0,
  latestMask: null,
  initializedMp: false,
  objectProximity01: 0,

  // フレームスキップ用カウンタ
  asciiFrameCount: 0,

  // 近接アラート
  proxAlert: false,

  // 高解像度キャプチャ中フラグ
  captureMode: false,
};

// =====================================================
// BOOT SEQUENCE
// =====================================================
const bootScreen = document.getElementById("boot-screen");
const bootLines = document.getElementById("boot-lines");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function typewriterLine(text, charMs = 14) {
  if (!bootLines) return;
  const div = document.createElement("div");
  bootLines.appendChild(div);
  for (const ch of text) {
    div.textContent += ch;
    await sleep(charMs);
  }
}

async function runBootSequence() {
  if (!bootLines || !bootScreen || bootScreen.style.display === "none") return;
  await typewriterLine("\u25C8 SURVEILLANCE SYSTEM v2.4.1", 11);
  await sleep(60);
  await typewriterLine("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", 5);
  await sleep(50);
  await typewriterLine("\u25B8 INITIALIZING CORE...", 13);
  await sleep(60);
  await typewriterLine("\u25B8 LOADING NEURAL ASSETS...", 13);
  await sleep(60);
  await typewriterLine("\u25B8 CALIBRATING OPTICS...", 13);
  await sleep(80);
  await typewriterLine("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500", 5);
  await sleep(80);
  await typewriterLine("SYSTEM ONLINE.", 22);
  await sleep(350);
}

// =====================================================
// FILM GRAIN
// =====================================================
(function initGrain() {
  const gc = document.createElement("canvas");
  gc.style.cssText =
    "position:fixed;inset:0;z-index:15;pointer-events:none;" +
    "opacity:0.055;width:100%;height:100%";
  document.body.appendChild(gc);
  const gctx = gc.getContext("2d");
  function resizeGrain() {
    gc.width = Math.round(window.innerWidth * 0.75);
    gc.height = Math.round(window.innerHeight * 0.75);
  }
  resizeGrain();
  window.addEventListener("resize", resizeGrain);
  function drawGrain() {
    const GW = gc.width, GH = gc.height;
    const img = gctx.createImageData(GW, GH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    gctx.putImageData(img, 0, 0);
  }
  drawGrain();
  setInterval(drawGrain, 80);
})();

// =====================================================
// TRANSITION FLASH
// =====================================================
function triggerFlash() {
  const el = document.getElementById("transition-flash");
  if (!el) return;
  el.style.transition = "none";
  el.style.opacity = "0.88";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = "opacity 0.42s ease-out";
      el.style.opacity = "0";
    });
  });
}

// =====================================================
// GEO / TIMECODE HUD (左上)
// =====================================================
const geoInfo = {
  country: "--",
  tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || "--").toUpperCase(),
};

(async () => {
  try {
    const r = await fetch("https://ipapi.co/json/");
    const d = await r.json();
    geoInfo.country = (d.country_name || "--").toUpperCase();
    geoInfo.tz = (d.timezone || geoInfo.tz).toUpperCase();
  } catch { /* タイムゾーンのみ使用 */ }
})();

function drawHudOnCanvas() {
  const w = asciiCanvas.width, h = asciiCanvas.height;
  const dpr = asciiCanvas.width / window.innerWidth;
  const isPortrait = window.innerHeight > window.innerWidth;
  const margin = Math.round((isPortrait ? 20 : 40) * dpr);
  const fs = Math.round((isPortrait ? 8 : 10.5) * dpr);
  const lh = fs * 1.55;
  const lx = margin;
  let ly = margin;

  const now = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  const date = `${now.getFullYear()}.${p2(now.getMonth() + 1)}.${p2(now.getDate())}`;
  const time = `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.${p3(now.getMilliseconds())}`;

  const lines = [
    "\u25C8 SURVEILLANCE ACTIVE",
    `${date} / ${time}`,
    `\u25C8 TZ: ${geoInfo.tz}`,
    `\u25C8 LOC: ${geoInfo.country}`,
  ];

  asciiCtx.save();
  asciiCtx.font = `${fs}px "VT323", monospace`;
  asciiCtx.textAlign = "left";
  asciiCtx.textBaseline = "top";
  asciiCtx.fillStyle = `rgba(${currentTheme.fg},0.78)`;
  for (const line of lines) {
    asciiCtx.fillText(line, lx, ly);
    ly += lh;
  }
  asciiCtx.restore();
}

// =====================================================
// パフォーマンス設定（ティア別）
// =====================================================
const PERF_CONFIG = {
  high: {
    pixelRatio: Math.min(window.devicePixelRatio, IS_MOBILE ? 3 : 1.5),
    mpFps: IS_MOBILE ? 12 : 22,
    asciiSkip: IS_MOBILE ? 2 : 1,
    threeAntiAlias: true,
  },
  mid: {
    pixelRatio: Math.min(window.devicePixelRatio, 2.0),
    mpFps: 12,
    asciiSkip: 2,       // 1フレームおきに描画
    threeAntiAlias: false,
  },
  low: {
    pixelRatio: 1.0,
    mpFps: 8,
    asciiSkip: 3,       // 2フレームおきに描画
    threeAntiAlias: false,
  },
};
const pc = PERF_CONFIG[PERF];

// =====================================================
// ASCII CONFIG
// =====================================================
const FACE_SET = " .`'\":,;i!-~^+=*xo#$%0B&WM@";
const FX_SET = " .:-=+*#%@";
const SPECIAL_CHAR = "朱";

// =====================================================
// COLOR THEME
// =====================================================
const THEMES = {
  MONO:   { bg: "#ffffff", fg: "0,0,0",       grainFilter: "",
            panelBg: "rgba(255,255,255,0.97)", panelFg: "#000000",
            panelBorder: "rgba(0,0,0,0.9)",    panelMuted: "rgba(0,0,0,0.5)",
            panelSep: "rgba(0,0,0,0.12)",      thumb: "#000000", track: "rgba(0,0,0,0.22)" },
  GREEN:  { bg: "#050e07", fg: "0,255,65",    grainFilter: "hue-rotate(96deg) saturate(2.5)",
            panelBg: "rgba(5,16,8,0.97)",      panelFg: "#00ff41",
            panelBorder: "rgba(0,255,65,0.6)", panelMuted: "rgba(0,255,65,0.45)",
            panelSep: "rgba(0,255,65,0.18)",   thumb: "#00ff41", track: "rgba(0,255,65,0.25)" },
  AMBER:  { bg: "#0d0800", fg: "255,176,0",   grainFilter: "sepia(1) saturate(4) hue-rotate(5deg)",
            panelBg: "rgba(18,11,0,0.97)",     panelFg: "#ffb000",
            panelBorder: "rgba(255,176,0,0.6)",panelMuted: "rgba(255,176,0,0.45)",
            panelSep: "rgba(255,176,0,0.18)",  thumb: "#ffb000", track: "rgba(255,176,0,0.25)" },
  RED:    { bg: "#0d0000", fg: "255,38,0",    grainFilter: "hue-rotate(330deg) saturate(3)",
            panelBg: "rgba(18,0,0,0.97)",      panelFg: "#ff2600",
            panelBorder: "rgba(255,38,0,0.6)", panelMuted: "rgba(255,38,0,0.45)",
            panelSep: "rgba(255,38,0,0.18)",   thumb: "#ff2600", track: "rgba(255,38,0,0.25)" },
  INVERT: { bg: "#000000", fg: "255,255,255", grainFilter: "invert(1)",
            panelBg: "rgba(18,18,18,0.97)",    panelFg: "#ffffff",
            panelBorder: "rgba(255,255,255,0.45)", panelMuted: "rgba(255,255,255,0.4)",
            panelSep: "rgba(255,255,255,0.14)",    thumb: "#ffffff", track: "rgba(255,255,255,0.25)" },
};

let currentTheme = THEMES.MONO;

function applyColorMode(mode) {
  const T = THEMES[mode];
  if (!T) return;
  currentTheme = T;

  document.body.style.background = T.bg;
  // Three.js scene always stays white — ASCII sampling reads white bg correctly.
  // Color theming is applied to ASCII text color and page background only.

  const root = document.documentElement;
  root.style.setProperty("--thumb-color",  T.thumb);
  root.style.setProperty("--track-color",  T.track);
  root.style.setProperty("--panel-bg",     T.panelBg);
  root.style.setProperty("--panel-fg",     T.panelFg);
  root.style.setProperty("--panel-border", T.panelBorder);
  root.style.setProperty("--panel-muted",  T.panelMuted);
  root.style.setProperty("--panel-sep",    T.panelSep);

  // grain canvas tint
  const grainEl = document.querySelector("canvas[style*='opacity:0.055']") ||
                  (() => { const els = document.querySelectorAll("canvas"); for (const c of els) if (c !== asciiCanvas) return c; })();
  if (grainEl) grainEl.style.filter = T.grainFilter;

  document.querySelectorAll(".color-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
}

// モバイルは列数を絞ってピクセル単価を下げる
const MOBILE_SCALE = PERF === "low" ? 0.72 : PERF === "mid" ? 0.85 : 1.0;

const asciiConfig = {
  objectColumns: Math.round(162 * (IS_MOBILE ? MOBILE_SCALE : 1)),
  objectColumnsMobile: Math.round(84 * MOBILE_SCALE),
  cameraColumns: Math.round(152 * (IS_MOBILE ? MOBILE_SCALE : 1)),
  cameraColumnsMobile: Math.round(72 * MOBILE_SCALE),

  fontFamily: `"VT323", monospace`,
  baseFontSizeScale: IS_MOBILE ? 0.78 : 0.60,
  lineHeightBaseScale: IS_MOBILE ? 0.90 : 0.84,

  contrast: IS_MOBILE ? 1.72 : 1.56,
  gamma: 0.82,
  brightness: 1.0,
  midBoost: 0.05,

  faceContrastBoost: 0.28,
  faceMidBoost: 0.14,
  faceShadowLift: 0.05,

  fxBlendObject: 0.08,
  fxBlendCamera: 0.14,

  specialBaseRateObject: 0.003,
  specialBaseRateCamera: IS_MOBILE ? 0.018 : 0.008,
  specialEdgeBoost: 0.05,
  specialDarkBoost: 0.02,
  specialFaceCenterSuppression: 0.05,
  minLumaForSpecial: 0.16,
  maxLumaForSpecial: 0.72,

  noiseAmount: 0.005,
  vignette: 0.025,
  edgeThreshold: 18,

  objectScanlineAlpha: 0.018,
  cameraScanlineAlpha: 0.042,
  objectFlicker: 0.004,
  cameraFlicker: 0.010,

  maxColsReductionObject: 0.16,
  maxColsReductionCamera: 0.22,
  maxFontGrowObject: 0.28,
  maxFontGrowCamera: 0.40,
  maxLineGrowObject: 0.06,
  maxLineGrowCamera: 0.10,
};

// =====================================================
// Uint8Array 再利用プール（毎フレームアロケーション排除）
// =====================================================
const grayPool = {
  _buf: null,
  _size: 0,
  get(size) {
    if (size > this._size) {
      this._buf = new Uint8Array(size);
      this._size = size;
    }
    return this._buf;
  },
};

// =====================================================
// HELPERS（変更なし）
// =====================================================
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
function luminance(r, g, b) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
function getCharFromSet(luma, charSet) {
  const idx = Math.floor((1 - luma) * (charSet.length - 1));
  return charSet[clamp(idx, 0, charSet.length - 1)];
}

function getFaceWeights(nx, ny, faceBoxNorm) {
  if (!faceBoxNorm) return { facePresence: 0, faceCenterWeight: 0, faceEdgeWeight: 0 };
  const fx = faceBoxNorm.x, fy = faceBoxNorm.y;
  const fw = faceBoxNorm.width, fh = faceBoxNorm.height;
  const cx = fx + fw * 0.5, cy = fy + fh * 0.5;
  const dx = (nx - cx) / Math.max(fw * 0.5, 0.0001);
  const dy = (ny - cy) / Math.max(fh * 0.5, 0.0001);
  const dist = Math.sqrt(dx * dx + dy * dy);
  return {
    facePresence: clamp(1 - smoothstep(0.9, 1.15, dist), 0, 1),
    faceCenterWeight: clamp(1 - smoothstep(0.0, 0.55, dist), 0, 1),
    faceEdgeWeight: clamp(smoothstep(0.42, 0.95, dist) * (1 - smoothstep(0.95, 1.15, dist)), 0, 1),
  };
}

function applyToneMap(luma, nx, ny, faceBoxNorm) {
  const face = getFaceWeights(nx, ny, faceBoxNorm);
  let v = luma * asciiConfig.brightness;
  v = (v - 0.5) * asciiConfig.contrast + 0.5;
  const mid = 1 - Math.abs(v - 0.5) / 0.5;
  v += mid * asciiConfig.midBoost * 0.18;
  if (face.facePresence > 0) {
    v = (v - 0.5) * (1 + asciiConfig.faceContrastBoost * face.facePresence) + 0.5;
    const fm = 1 - Math.abs(v - 0.5) / 0.5;
    v += fm * asciiConfig.faceMidBoost * face.facePresence;
    v += asciiConfig.faceShadowLift * face.faceCenterWeight;
  }
  return clamp(Math.pow(clamp(v, 0, 1), asciiConfig.gamma), 0, 1);
}

function computeEdgeStrength(gray, x, y, w, h) {
  const x0 = clamp(x - 1, 0, w - 1), x1 = clamp(x + 1, 0, w - 1);
  const y0 = clamp(y - 1, 0, h - 1), y1 = clamp(y + 1, 0, h - 1);
  return Math.min(255, Math.abs(gray[y * w + x1] - gray[y * w + x0]) + Math.abs(gray[y1 * w + x] - gray[y0 * w + x]));
}

// =====================================================
// THREE
// =====================================================
const renderer = new THREE.WebGLRenderer({
  antialias: pc.threeAntiAlias,
  alpha: false,
  powerPreference: IS_MOBILE ? "default" : "high-performance", // モバイルはdefaultで省電力優先
  preserveDrawingBuffer: true,
});
renderer.setClearColor(0xffffff, 1);
threeLayer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera3D = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.1, 100);
camera3D.position.set(0, 0.9, 5.8);

const ambientLight = new THREE.AmbientLight(0xffffff, 1.35);
scene.add(ambientLight);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.55);
keyLight.position.set(2.8, 3.0, 4.0);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.75);
fillLight.position.set(-2.0, 1.5, 2.8);
scene.add(fillLight);

let modelRoot = null;
let modelMixer = null;
let idleBaseY = 0;

// モバイルではThree.jsを低解像度レンダリング
const THREE_SCALE = IS_MOBILE ? (PERF === "low" ? 0.5 : 0.65) : 1.0;

function frameModel(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  obj.position.x -= center.x;
  obj.position.y -= center.y;
  obj.position.z -= center.z;
  const targetHeight = IS_MOBILE ? 3.15 : 3.55;
  obj.scale.setScalar(targetHeight / Math.max(size.y, 0.0001));
  const box2 = new THREE.Box3().setFromObject(obj);
  const center2 = box2.getCenter(new THREE.Vector3());
  const size2 = box2.getSize(new THREE.Vector3());
  obj.position.x -= center2.x;
  obj.position.y -= center2.y;
  obj.position.z -= center2.z;
  obj.position.y = -size2.y * 0.18;
  idleBaseY = obj.position.y;
}

async function loadModel() {
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(MODEL_URL, (gltf) => {
      modelRoot = gltf.scene;
      frameModel(modelRoot);
      modelRoot.traverse((child) => {
        if (child.isMesh && child.material) {
          child.castShadow = false;
          child.receiveShadow = false;
          child.material.transparent = false;
          child.material.opacity = 1;
          child.material.depthWrite = true;
        }
      });
      scene.add(modelRoot);
      if (gltf.animations && gltf.animations.length) {
        modelMixer = new THREE.AnimationMixer(modelRoot);
        modelMixer.clipAction(gltf.animations[0]).play();
      }
      state.modelReady = true;
      resolve();
    }, undefined, reject);
  });
}

function animateModel(delta, elapsed) {
  if (!modelRoot) return;
  if (modelMixer) modelMixer.update(delta);
  const idleFloat = Math.sin(elapsed * 0.9) * 0.035;
  const idleBreath = Math.sin(elapsed * 1.4) * 0.018;
  const idleYaw = Math.sin(elapsed * 0.42) * 0.07;
  const idlePitch = Math.sin(elapsed * 0.95) * 0.012;
  const mainCycle = Math.sin(elapsed * 0.48 - 0.9) * 0.5 + 0.5;
  const mainLean = Math.pow(mainCycle, 3.6);
  const microLean = Math.pow(Math.sin(elapsed * 1.15 + 0.8) * 0.5 + 0.5, 2.0) * 0.08;
  const lean = mainLean + microLean;
  modelRoot.position.y = idleBaseY + idleFloat + idleBreath + (-lean * 0.09);
  modelRoot.position.z = lean * 1.0;
  modelRoot.rotation.y = idleYaw + Math.sin(elapsed * 1.1) * 0.03 * mainLean;
  modelRoot.rotation.x = idlePitch + lean * 0.25;
  const targetProximity = smoothstep(0.05, 0.85, lean * 1.0);
  state.objectProximity01 = lerp(state.objectProximity01, targetProximity, 0.12);
}

// =====================================================
// MEDIAPIPE
// =====================================================
let selfieSegmentation = null;
let faceDetection = null;

function initMediaPipe() {
  if (state.initializedMp) return;
  if (!window.SelfieSegmentation || !window.FaceDetection) {
    throw new Error("MediaPipe scripts failed to load.");
  }

  selfieSegmentation = new window.SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
  });
  // モバイルでは軽量モデル(0)、デスクトップは精度重視(1)
  selfieSegmentation.setOptions({ modelSelection: IS_MOBILE ? 0 : 1 });
  selfieSegmentation.onResults((results) => {
    state.latestMask = results.segmentationMask || null;
    state.segmentationReady = true;
  });

  faceDetection = new window.FaceDetection({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
  });
  faceDetection.setOptions({ model: "short", minDetectionConfidence: 0.45 });
  faceDetection.onResults((results) => {
    const detections = results.detections || [];
    state.faceReady = true;
    if (!detections.length) { state.faceBoxNorm = null; return; }
    const box = detections[0].boundingBox;
    if (!box) { state.faceBoxNorm = null; return; }
    state.faceBoxNorm = {
      x: clamp(box.xCenter - box.width / 2, 0, 1),
      y: clamp(box.yCenter - box.height / 2, 0, 1),
      width: clamp(box.width, 0, 1),
      height: clamp(box.height, 0, 1),
    };
  });

  state.initializedMp = true;
}

// =====================================================
// CAMERA
// =====================================================
async function startCamera() {
  if (state.webcamReady) return;
  if (!state.initializedMp) initMediaPipe();

  // モバイルは解像度を下げてMediaPipe負荷軽減
  const idealW = IS_MOBILE ? (PERF === "low" ? 480 : 640) : 1280;
  const idealH = IS_MOBILE ? (PERF === "low" ? 270 : 360) : 720;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: idealW }, height: { ideal: idealH } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  state.webcamReady = true;
  resizeWorkCanvases(video.videoWidth, video.videoHeight);
}

function stopCamera() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  state.webcamReady = false;
  state.segmentationReady = false;
  state.faceReady = false;
  state.faceBoxNorm = null;
  state.zoom01 = 0;
  state.latestMask = null;
  // MediaPipeインスタンスもリセット（resetBtn対応）
  selfieSegmentation = null;
  faceDetection = null;
  state.initializedMp = false;
}

function resizeWorkCanvases(w, h) {
  [sourceCanvas, maskCanvas, personCanvas].forEach((c) => {
    c.width = w;
    c.height = h;
  });
}

async function processMediaPipeFrame() {
  if (!state.webcamReady || !video.videoWidth || !video.videoHeight) return;
  if (!selfieSegmentation || !faceDetection || state.mpBusy) return;

  state.mpBusy = true;
  try {
    if (sourceCanvas.width !== video.videoWidth || sourceCanvas.height !== video.videoHeight) {
      resizeWorkCanvases(video.videoWidth, video.videoHeight);
    }
    sourceCtx.save();
    sourceCtx.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceCtx.translate(sourceCanvas.width, 0);
    sourceCtx.scale(-1, 1);
    sourceCtx.drawImage(video, 0, 0, sourceCanvas.width, sourceCanvas.height);
    sourceCtx.restore();

    await selfieSegmentation.send({ image: sourceCanvas });
    await faceDetection.send({ image: sourceCanvas });

    buildPersonCanvas();
    updateZoomEstimate();
  } catch (err) {
    console.error(err);
  } finally {
    state.mpBusy = false;
  }
}

function buildPersonCanvas() {
  if (!state.latestMask) return;
  const w = personCanvas.width, h = personCanvas.height;

  maskCtx.clearRect(0, 0, w, h);
  maskCtx.drawImage(state.latestMask, 0, 0, w, h);

  // MP専用sampleCanvasを使用 → ASCII用との競合解消
  sampleCanvasMp.width = w;
  sampleCanvasMp.height = h;
  sampleCtxMp.clearRect(0, 0, w, h);
  sampleCtxMp.filter = "blur(4px)";
  sampleCtxMp.drawImage(maskCanvas, 0, 0, w, h);
  sampleCtxMp.filter = "none";

  const img = sampleCtxMp.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i];
    let a = v >= 170 ? 255 : v > 96 ? Math.round(((v - 96) / 74) * 255) : 0;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = a;
  }
  sampleCtxMp.putImageData(img, 0, 0);

  personCtx.clearRect(0, 0, w, h);
  personCtx.drawImage(sourceCanvas, 0, 0, w, h);
  personCtx.globalCompositeOperation = "destination-in";
  personCtx.drawImage(sampleCanvasMp, 0, 0, w, h);
  personCtx.globalCompositeOperation = "source-over";
}

function updateZoomEstimate() {
  if (!state.faceBoxNorm) { state.zoom01 = lerp(state.zoom01, 0, 0.08); return; }
  const area = state.faceBoxNorm.width * state.faceBoxNorm.height;
  state.zoom01 = lerp(state.zoom01, smoothstep(0.04, 0.18, area), 0.18);
}

// =====================================================
// ASCII CORE
// =====================================================
function pickAsciiChar(luma, edgeStrength, nx, ny, faceBoxNorm, timeSec, sourceMode) {
  const face = getFaceWeights(nx, ny, faceBoxNorm);
  const fxBlend = sourceMode === "camera" ? asciiConfig.fxBlendCamera : asciiConfig.fxBlendObject;

  let chosen = Math.random() < fxBlend * (1 - face.faceCenterWeight * 0.9)
    ? getCharFromSet(luma, FX_SET)
    : getCharFromSet(luma, FACE_SET);

  const edgeBoost = smoothstep(asciiConfig.edgeThreshold, asciiConfig.edgeThreshold * 2.2, edgeStrength);
  if (edgeBoost > 0.45) {
    chosen = getCharFromSet(clamp(luma - 0.08 * edgeBoost, 0, 1), FACE_SET);
  }

  const darkBoost = smoothstep(asciiConfig.maxLumaForSpecial, asciiConfig.minLumaForSpecial, luma);
  const flicker = 0.5 + 0.5 * Math.sin(timeSec * 4.4 + nx * 17 + ny * 11);
  const baseRate = sourceMode === "camera" ? asciiConfig.specialBaseRateCamera : asciiConfig.specialBaseRateObject;
  let specialRate = baseRate
    + face.faceEdgeWeight * asciiConfig.specialEdgeBoost
    + darkBoost * asciiConfig.specialDarkBoost
    + flicker * 0.006
    + state.glitchBurst * 0.03;
  specialRate *= 1 - face.faceCenterWeight * (1 - asciiConfig.specialFaceCenterSuppression);
  if (luma > asciiConfig.maxLumaForSpecial || luma < 0.05) specialRate *= 0.2;

  if (Math.random() < specialRate) chosen = SPECIAL_CHAR;
  return chosen;
}

function drawAsciiFromSource({ imageSource, sourceMode, faceBoxNorm = null, proximity01 = 0, timeSec = 0 }) {
  const w = asciiCanvas.width, h = asciiCanvas.height;
  asciiCtx.clearRect(0, 0, w, h);
  if (!imageSource) return;

  const baseCols = state.captureMode
    ? (sourceMode === "camera" ? asciiConfig.cameraColumns : asciiConfig.objectColumns)
    : (sourceMode === "camera"
      ? (IS_MOBILE ? asciiConfig.cameraColumnsMobile : asciiConfig.cameraColumns)
      : (IS_MOBILE ? asciiConfig.objectColumnsMobile : asciiConfig.objectColumns));

  const maxColsReduction = sourceMode === "camera" ? asciiConfig.maxColsReductionCamera : asciiConfig.maxColsReductionObject;
  const cols = Math.max(24, Math.round(baseCols * (1 - proximity01 * maxColsReduction)));
  const cellW = w / cols;
  const cellH = cellW * 1.18;

  const fontGrow = sourceMode === "camera" ? asciiConfig.maxFontGrowCamera : asciiConfig.maxFontGrowObject;
  const lineGrow = sourceMode === "camera" ? asciiConfig.maxLineGrowCamera : asciiConfig.maxLineGrowObject;
  const fontSizeScale = asciiConfig.baseFontSizeScale * (1 + proximity01 * fontGrow);
  const lineHeightScale = asciiConfig.lineHeightBaseScale * (1 + proximity01 * lineGrow);
  const lineHeight = cellH * lineHeightScale;
  const rows = Math.max(1, Math.floor(h / lineHeight));

  // ASCII専用sampleCanvasを使用 → MP用との競合解消
  sampleCanvasAscii.width = cols;
  sampleCanvasAscii.height = rows;
  sampleCtxAscii.clearRect(0, 0, cols, rows);
  sampleCtxAscii.drawImage(imageSource, 0, 0, cols, rows);

  const img = sampleCtxAscii.getImageData(0, 0, cols, rows);
  const data = img.data;
  const total = cols * rows;

  // プールから再利用（毎フレームのnew Uint8Array排除）
  const gray = grayPool.get(total);

  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    if (data[idx + 3] < 10) { gray[i] = 255; continue; }
    const x = i % cols, y = Math.floor(i / cols);
    const nx = x / Math.max(cols - 1, 1), ny = y / Math.max(rows - 1, 1);
    let l = luminance(data[idx], data[idx + 1], data[idx + 2]);
    l += (Math.random() - 0.5) * asciiConfig.noiseAmount;
    const dx = nx - 0.5, dy = ny - 0.5;
    l -= smoothstep(0.38, 0.9, Math.sqrt(dx * dx + dy * dy)) * asciiConfig.vignette;
    l = applyToneMap(l, nx, ny, faceBoxNorm);
    gray[i] = Math.round(clamp(l, 0, 1) * 255);
  }

  const fontSize = Math.max(8, Math.floor(cellH * fontSizeScale));
  asciiCtx.textAlign = "center";
  asciiCtx.textBaseline = "middle";
  asciiCtx.font = `${fontSize}px ${asciiConfig.fontFamily}`;

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const luma = gray[i] / 255;
      if (luma > 0.985) continue;
      const edge = computeEdgeStrength(gray, x, y, cols, rows);
      const nx = x / Math.max(cols - 1, 1), ny = y / Math.max(rows - 1, 1);
      const ch = pickAsciiChar(luma, edge, nx, ny, faceBoxNorm, timeSec, sourceMode);
      const px = x * cellW + cellW * 0.5;
      const py = y * lineHeight + lineHeight * 0.5;

      if (ch === SPECIAL_CHAR) {
        asciiCtx.fillStyle = sourceMode === "camera"
          ? `rgba(${currentTheme.fg},${clamp(0.72 + state.glitchBurst * 0.12 + proximity01 * 0.06, 0.70, 0.98)})`
          : `rgba(${currentTheme.fg},${clamp(0.82 + proximity01 * 0.06, 0.82, 0.98)})`;
      } else {
        const a = sourceMode === "camera"
          ? clamp(0.48 + (1 - luma) * 0.38 + proximity01 * 0.04, 0.46, 0.94)
          : clamp(0.42 + (1 - luma) * 0.34 + proximity01 * 0.04, 0.40, 0.86);
        asciiCtx.fillStyle = `rgba(${currentTheme.fg},${a})`;
      }

      const jitter = sourceMode === "camera" && state.glitchBurst > 0.001
        ? (Math.random() - 0.5) * 1.2 * state.glitchBurst : 0;

      asciiCtx.fillText(ch, px + jitter, py);
    }
  }

  drawMinimalFx(timeSec, sourceMode);
  drawCoordOverlay(timeSec, sourceMode);
  drawHudOnCanvas();
}


function drawMinimalFx(timeSec, sourceMode) {
  const w = asciiCanvas.width, h = asciiCanvas.height;
  const scanAlpha = sourceMode === "camera" ? asciiConfig.cameraScanlineAlpha : asciiConfig.objectScanlineAlpha;
  asciiCtx.save();
  asciiCtx.globalAlpha = scanAlpha + state.glitchBurst * 0.04;
  for (let y = 0; y < h; y += 3) {
    asciiCtx.fillStyle = y % 6 === 0 ? `rgba(${currentTheme.fg},0.12)` : `rgba(${currentTheme.fg},0.04)`;
    asciiCtx.fillRect(0, y, w, 1);
  }
  asciiCtx.restore();
  const flicker = (sourceMode === "camera" ? asciiConfig.cameraFlicker : asciiConfig.objectFlicker) + Math.sin(timeSec * 2.3) * 0.004;
  asciiCtx.save();
  asciiCtx.fillStyle = `rgba(${currentTheme.fg},${Math.max(0, flicker)})`;
  asciiCtx.fillRect(0, 0, w, h);
  asciiCtx.restore();
}

// =====================================================
// SURVEILLANCE COORD OVERLAY (canvas左側)
// =====================================================
function drawCoordOverlay(timeSec, sourceMode) {
  const h = asciiCanvas.height;
  const dpr = asciiCanvas.width / window.innerWidth;
  const isPortrait = window.innerHeight > window.innerWidth;
  const margin = Math.round((isPortrait ? 20 : 40) * dpr);
  const fs = Math.round((isPortrait ? 8 : 10.5) * dpr);
  const lh = fs * 1.55;
  const lx = margin;

  let cx, cy, cz, dist, proximity;

  if (sourceMode === "object") {
    const rot = modelRoot ? modelRoot.rotation : { y: 0, x: 0 };
    const pos = modelRoot ? modelRoot.position : { z: 0 };
    cx = (rot.y * 1800 + 2400).toFixed(1);
    cy = (rot.x * -1200 + 800).toFixed(1);
    cz = (pos.z * 400 + 600).toFixed(1);
    proximity = state.objectProximity01;
    dist = (1800 - proximity * 1400).toFixed(1);
  } else {
    const fb = state.faceBoxNorm;
    if (fb) {
      cx = ((fb.x + fb.width * 0.5) * 3840).toFixed(1);
      cy = ((fb.y + fb.height * 0.5) * 2160).toFixed(1);
      cz = (200 + (1 - state.zoom01) * 1200).toFixed(1);
    } else {
      cx = cy = cz = "---.-";
    }
    proximity = state.zoom01;
    dist = state.faceBoxNorm ? (200 + (1 - state.zoom01) * 1200).toFixed(1) : "---.-";
  }

  const isAlert = proximity > 0.70;
  const flashOn = isAlert && Math.floor(timeSec * 4) % 2 === 0;
  state.proxAlert = isAlert;

  const filled = Math.round(proximity * 8);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(8 - filled);

  let lines, ly, textAlign, lx2;

  if (isPortrait) {
    // 縦画面: 3行コンパクト、右上に配置（textAlign: right）
    const w = asciiCanvas.width;
    ly = margin;
    lx2 = w - margin;
    lines = [
      flashOn ? "\u26A0 PROXIMITY ALERT" : "\u25C8 TARGET ACQUIRED",
      `X:${String(cx).padStart(8)}  Y:${String(cy).padStart(8)}`,
      `Z:${String(cz).padStart(8)}  DIST:${String(dist).padStart(7)}m`,
      `PROX [${bar}]`,
    ];
  } else {
    // PC: 9行、左中央に配置
    ly = h * 0.26;
    lines = [
      flashOn ? "\u26A0 PROXIMITY ALERT" : "\u25C8 TARGET ACQUIRED",
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `X: ${String(cx).padStart(9)}`,
      `Y: ${String(cy).padStart(9)}`,
      `Z: ${String(cz).padStart(9)}`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `DIST:${String(dist).padStart(10)}m`,
      "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
      `PROX [${bar}]`,
    ];
  }

  asciiCtx.save();
  asciiCtx.font = `${fs}px "VT323", monospace`;
  asciiCtx.textBaseline = "top";

  if (isPortrait) {
    asciiCtx.textAlign = "right";
    for (const line of lines) {
      const isHeader = line.includes("ACQUIRED") || line.includes("ALERT");
      asciiCtx.fillStyle = isHeader && flashOn
        ? `rgba(180,20,20,0.88)`
        : `rgba(${currentTheme.fg},0.78)`;
      asciiCtx.fillText(line, lx2, ly);
      ly += lh;
    }
  } else {
    asciiCtx.textAlign = "left";
    for (const line of lines) {
      const isHeader = line.includes("ACQUIRED") || line.includes("ALERT");
      asciiCtx.fillStyle = isHeader && flashOn
        ? `rgba(180,20,20,0.88)`
        : `rgba(${currentTheme.fg},0.78)`;
      asciiCtx.fillText(line, lx, ly);
      ly += lh;
    }
  }
  asciiCtx.restore();
}

// =====================================================
// EXTERNAL CONTROL via BroadcastChannel（buttons.html用）
// =====================================================
const bc = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("jianye-webcam")
  : null;

function broadcastUpdate(btnText, statusText) {
  if (bc) bc.postMessage({ type: "update", btnText, statusText });
}

if (bc) {
  bc.onmessage = (e) => {
    const data = e.data;
    if (!data || !data.action) return;

    if (data.action === "toggleCamera") {
      triggerFlash();
      if (state.source === "object") {
        startCamera().then(() => {
          state.source = "camera";
          broadcastUpdate("OBJECT", "SOURCE: CAMERA / WAIT");
        }).catch((err) => {
          console.error(err);
          statusEl.textContent = "CAMERA ERROR";
          broadcastUpdate("CAMERA", "CAMERA ERROR");
        });
      } else {
        stopCamera();
        state.source = "object";
        broadcastUpdate("CAMERA", "SOURCE: OBJECT");
      }
    } else if (data.action === "capture") {
      captureCanvas();
    } else if (data.action === "reset") {
      state.faceBoxNorm = null;
      state.zoom01 = 0;
      state.glitchBurst = 0;
      state.lastMpTime = 0;
      state.objectProximity01 = 0;
      state.asciiFrameCount = 0;
      if (state.source === "camera" && state.webcamReady) stopCamera();
      state.source = "object";
      broadcastUpdate("CAMERA", "SOURCE: OBJECT");
      updateStatus();
    }
  };
}

// =====================================================
// CAPTURE
// =====================================================
function captureCanvas() {
  // 高解像度キャプチャ: canvasを3倍サイズに拡大して再描画
  const CAPTURE_SCALE = 3;
  const origW = asciiCanvas.width;
  const origH = asciiCanvas.height;

  asciiCanvas.width = Math.round(window.innerWidth * CAPTURE_SCALE);
  asciiCanvas.height = Math.round(window.innerHeight * CAPTURE_SCALE);

  state.captureMode = true;
  const elapsed = clock.getElapsedTime();
  if (state.source === "object") {
    drawAsciiFromSource({
      imageSource: renderer.domElement,
      sourceMode: "object",
      faceBoxNorm: null,
      proximity01: state.objectProximity01,
      timeSec: elapsed,
    });
  } else {
    drawAsciiFromSource({
      imageSource: personCanvas,
      sourceMode: "camera",
      faceBoxNorm: state.faceBoxNorm,
      proximity01: state.zoom01,
      timeSec: elapsed,
    });
  }
  state.captureMode = false;

  // 白背景に合成
  const offscreen = document.createElement("canvas");
  offscreen.width = asciiCanvas.width;
  offscreen.height = asciiCanvas.height;
  const ctx = offscreen.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, offscreen.width, offscreen.height);
  ctx.drawImage(asciiCanvas, 0, 0);

  // ロゴを右下に合成
  const logoImg = document.querySelector("#logo-br img");
  if (logoImg && logoImg.complete) {
    const canvasScale = asciiCanvas.width / window.innerWidth;
    const isPortrait = window.innerHeight > window.innerWidth;
    const logoCSS = IS_MOBILE ? 36 : 50;
    const logoSize = Math.round(logoCSS * canvasScale);
    const margin = Math.round((isPortrait ? 20 : 40) * canvasScale);
    const lx = offscreen.width - margin - logoSize;
    const ly = offscreen.height - margin - logoSize;
    ctx.drawImage(logoImg, lx, ly, logoSize, logoSize);
  }

  // フィルムグレインを合成
  const noiseCanvas = document.createElement("canvas");
  noiseCanvas.width = offscreen.width;
  noiseCanvas.height = offscreen.height;
  const noiseCtx = noiseCanvas.getContext("2d");
  const noiseData = noiseCtx.createImageData(offscreen.width, offscreen.height);
  for (let i = 0; i < noiseData.data.length; i += 4) {
    const v = Math.floor(Math.random() * 256);
    noiseData.data[i] = v;
    noiseData.data[i + 1] = v;
    noiseData.data[i + 2] = v;
    noiseData.data[i + 3] = 255;
  }
  noiseCtx.putImageData(noiseData, 0, 0);
  ctx.globalAlpha = 0.055;
  ctx.drawImage(noiseCanvas, 0, 0);
  ctx.globalAlpha = 1.0;

  // canvasを元のサイズに戻す
  asciiCanvas.width = origW;
  asciiCanvas.height = origH;

  const dataURL = offscreen.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataURL;
  a.download = `jianye-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

if (captureBtn) {
  captureBtn.addEventListener("click", captureCanvas);
}

// =====================================================
// UI
// =====================================================
function updateStatus() {
  if (state.source === "object") {
    statusEl.textContent = state.modelReady
      ? `SOURCE: OBJECT / ${state.objectProximity01.toFixed(2)}`
      : "SOURCE: OBJECT / LOADING";
  } else {
    if (!state.webcamReady) statusEl.textContent = "SOURCE: CAMERA / WAIT";
    else if (!state.faceBoxNorm) statusEl.textContent = "SOURCE: CAMERA / SEARCH";
    else statusEl.textContent = `SOURCE: CAMERA / ${state.zoom01.toFixed(2)}`;
  }
}

enableCameraBtn.addEventListener("click", async () => {
  triggerFlash();
  if (state.source === "object") {
    try {
      await startCamera();
      state.source = "camera";
      enableCameraBtn.textContent = "OBJECT";
      broadcastUpdate("OBJECT", "SOURCE: CAMERA / WAIT");
    } catch (err) {
      console.error(err);
      statusEl.textContent = "CAMERA ERROR";
      broadcastUpdate("CAMERA", "CAMERA ERROR");
    }
  } else {
    stopCamera();
    state.source = "object";
    enableCameraBtn.textContent = "CAMERA";
    broadcastUpdate("CAMERA", "SOURCE: OBJECT");
  }
});


// =====================================================
// RESIZE
// =====================================================
function resizeAll() {
  const w = window.innerWidth, h = window.innerHeight;

  renderer.setPixelRatio(pc.pixelRatio);
  renderer.setSize(Math.round(w * THREE_SCALE), Math.round(h * THREE_SCALE), false);
  // CSSサイズは常にフル
  renderer.domElement.style.width = `${w}px`;
  renderer.domElement.style.height = `${h}px`;

  camera3D.aspect = w / h;
  camera3D.updateProjectionMatrix();

  asciiCanvas.width = Math.floor(w * Math.min(window.devicePixelRatio, pc.pixelRatio));
  asciiCanvas.height = Math.floor(h * Math.min(window.devicePixelRatio, pc.pixelRatio));
  asciiCanvas.style.width = `${w}px`;
  asciiCanvas.style.height = `${h}px`;

  camera3D.position.set(0, w < 768 ? 1.0 : 0.9, w < 768 ? 6.2 : 5.8);
}

window.addEventListener("resize", resizeAll);

// =====================================================
// ANIMATION
// =====================================================
const clock = new THREE.Clock();

let _rafId = null;

function renderLoop() {
  _rafId = requestAnimationFrame(renderLoop);

  const delta = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  animateModel(delta, elapsed);
  renderer.render(scene, camera3D);

  // MediaPipe処理 — ティア別fps制御
  if (state.source === "camera" && state.webcamReady) {
    const mpInterval = 1 / pc.mpFps;
    if (elapsed - state.lastMpTime > mpInterval) {
      state.lastMpTime = elapsed;
      processMediaPipeFrame();
    }
  }

  state.glitchBurst = lerp(state.glitchBurst, 0, 0.08);

  // ASCII描画フレームスキップ（mid/lowティア）
  state.asciiFrameCount++;
  if (state.asciiFrameCount % pc.asciiSkip !== 0) return;

  if (state.source === "object") {
    drawAsciiFromSource({
      imageSource: renderer.domElement,
      sourceMode: "object",
      faceBoxNorm: null,
      proximity01: state.objectProximity01,
      timeSec: elapsed,
    });
  } else {
    drawAsciiFromSource({
      imageSource: personCanvas,
      sourceMode: "camera",
      faceBoxNorm: state.faceBoxNorm,
      proximity01: state.zoom01,
      timeSec: elapsed,
    });
  }

  updateStatus();
}

// =====================================================
// PAGE VISIBILITY（タブ非表示時に描画停止）
// =====================================================
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
  } else {
    if (_rafId === null) renderLoop();
  }
});

// =====================================================
// INIT
// =====================================================
async function init() {
  resizeAll();
  const modelPromise = loadModel().catch((err) => {
    console.error("model.glb load error:", err);
    statusEl.textContent = "MODEL LOAD ERROR";
  });
  await Promise.all([runBootSequence(), modelPromise]);
  if (bootScreen) {
    bootScreen.style.opacity = "0";
    setTimeout(() => { if (bootScreen.parentNode) bootScreen.remove(); }, 700);
  }
  renderLoop();
}

// =====================================================
// SETTINGS PANEL
// =====================================================
(function initSettingsPanel() {
  const panel      = document.getElementById("ctrl-panel");
  const settingsBtn = document.getElementById("settingsBtn");
  if (!panel || !settingsBtn) return;

  // ── open / close ──
  settingsBtn.addEventListener("click", () => panel.classList.toggle("visible"));
  document.getElementById("closePanelBtn").addEventListener("click", () => panel.classList.remove("visible"));

  // ── sync slider to current asciiConfig value ──
  function syncSlider(slId, valId, value, fmt) {
    const sl = document.getElementById(slId);
    const vl = document.getElementById(valId);
    if (!sl || !vl) return;
    sl.value = value;
    vl.textContent = fmt(value);
  }

  function syncAllSliders() {
    const m = state.source === "camera";
    syncSlider("sl-cols",     "val-cols",     m ? asciiConfig.cameraColumns    : asciiConfig.objectColumns,     v => Math.round(v));
    syncSlider("sl-special",  "val-special",  m ? asciiConfig.specialBaseRateCamera : asciiConfig.specialBaseRateObject, v => v.toFixed(3));
    syncSlider("sl-contrast", "val-contrast", asciiConfig.contrast,   v => v.toFixed(2));
    syncSlider("sl-gamma",    "val-gamma",    asciiConfig.gamma,      v => v.toFixed(2));
    syncSlider("sl-bright",   "val-bright",   asciiConfig.brightness, v => v.toFixed(2));
    syncSlider("sl-scan",     "val-scan",     m ? asciiConfig.cameraScanlineAlpha : asciiConfig.objectScanlineAlpha, v => v.toFixed(3));
    syncSlider("sl-flicker",  "val-flicker",  m ? asciiConfig.cameraFlicker       : asciiConfig.objectFlicker,       v => v.toFixed(3));
  }

  // パネルを開くたびに現在のモードの値を反映
  settingsBtn.addEventListener("click", () => {
    if (panel.classList.contains("visible")) syncAllSliders();
  });

  // ── grain canvas reference ──
  let grainCanvas = null;
  // grain canvas はiife内で生成されdocument.bodyに追加される。init後に取得。
  function getGrainCanvas() {
    if (grainCanvas) return grainCanvas;
    const all = document.querySelectorAll("canvas");
    for (const c of all) {
      if (c !== asciiCanvas && c !== document.getElementById("ascii")) {
        grainCanvas = c; return c;
      }
    }
    return null;
  }

  syncSlider("sl-grain", "val-grain", 0.055, v => v.toFixed(3));

  // ── slider bindings ──
  function bind(slId, valId, fmt, onChange) {
    const sl = document.getElementById(slId);
    const vl = document.getElementById(valId);
    if (!sl || !vl) return;
    sl.addEventListener("input", () => {
      const v = parseFloat(sl.value);
      vl.textContent = fmt(v);
      onChange(v);
    });
  }

  bind("sl-cols", "val-cols", v => Math.round(v), v => {
    if (state.source === "camera") {
      asciiConfig.cameraColumns       = Math.round(v);
      asciiConfig.cameraColumnsMobile = Math.round(v * 0.47);
    } else {
      asciiConfig.objectColumns       = Math.round(v);
      asciiConfig.objectColumnsMobile = Math.round(v * 0.52);
    }
  });

  bind("sl-special", "val-special", v => v.toFixed(3), v => {
    if (state.source === "camera") asciiConfig.specialBaseRateCamera = v;
    else                           asciiConfig.specialBaseRateObject = v;
  });

  bind("sl-contrast", "val-contrast", v => v.toFixed(2), v => { asciiConfig.contrast   = v; });
  bind("sl-gamma",    "val-gamma",    v => v.toFixed(2), v => { asciiConfig.gamma      = v; });
  bind("sl-bright",   "val-bright",   v => v.toFixed(2), v => { asciiConfig.brightness = v; });

  bind("sl-scan", "val-scan", v => v.toFixed(3), v => {
    if (state.source === "camera") asciiConfig.cameraScanlineAlpha = v;
    else                           asciiConfig.objectScanlineAlpha = v;
  });

  bind("sl-flicker", "val-flicker", v => v.toFixed(3), v => {
    if (state.source === "camera") asciiConfig.cameraFlicker = v;
    else                           asciiConfig.objectFlicker  = v;
  });

  bind("sl-grain", "val-grain", v => v.toFixed(3), v => {
    const gc = getGrainCanvas();
    if (gc) gc.style.opacity = v;
  });

  // ── color mode ──
  document.querySelectorAll(".color-btn").forEach(btn => {
    btn.addEventListener("click", () => applyColorMode(btn.dataset.mode));
  });

  // ── reset ──
  const DEFAULTS_OBJ = {
    objectColumns:        asciiConfig.objectColumns,
    objectColumnsMobile:  asciiConfig.objectColumnsMobile,
    cameraColumns:        asciiConfig.cameraColumns,
    cameraColumnsMobile:  asciiConfig.cameraColumnsMobile,
    specialBaseRateObject: asciiConfig.specialBaseRateObject,
    specialBaseRateCamera: asciiConfig.specialBaseRateCamera,
    contrast:    asciiConfig.contrast,
    gamma:       asciiConfig.gamma,
    brightness:  asciiConfig.brightness,
    objectScanlineAlpha: asciiConfig.objectScanlineAlpha,
    cameraScanlineAlpha: asciiConfig.cameraScanlineAlpha,
    objectFlicker: asciiConfig.objectFlicker,
    cameraFlicker: asciiConfig.cameraFlicker,
  };
  const GRAIN_DEFAULT = 0.055;

  document.getElementById("resetSettingsBtn").addEventListener("click", () => {
    Object.assign(asciiConfig, DEFAULTS_OBJ);
    const gc = getGrainCanvas();
    if (gc) gc.style.opacity = GRAIN_DEFAULT;
    syncAllSliders();
    syncSlider("sl-grain", "val-grain", GRAIN_DEFAULT, v => v.toFixed(3));
    applyColorMode("MONO");
  });
})();

init();