const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  onEmotion: (cb) => ipcRenderer.on("pet:emotion", (_e, name) => cb(name)),
  onReset: (cb) => ipcRenderer.on("pet:reset", () => cb()),
  onText: (cb) => ipcRenderer.on("pet:text", (_e, p) => cb(p)),
  // TTS 播放中实时音量（RMS 0~1）→ 嘴型 lip-sync
  onTtsLevel: (cb) => ipcRenderer.on("pet:tts-level", (_e, rms) => cb(rms)),
  getAgentConfig: () => ipcRenderer.invoke("pet:get-agent-config"),
  drag: (dx, dy) => ipcRenderer.send("pet:drag", dx, dy),
  dragEnd: () => ipcRenderer.send("pet:dragend"),
  shake: () => ipcRenderer.send("pet:shake"),
  dizzy: () => ipcRenderer.send("pet:dizzy"),
  // gx/gy：全局屏幕坐标（按住期间 renderer 用于晃动检测补采样，出窗不断流）
  onCursor: (cb) => ipcRenderer.on("pet:cursor", (_e, x, y, gx, gy) => cb(x, y, gx, gy)),
  // 点击/拖尾特效：桌宠窗口发全局屏幕坐标 → 主进程 → 全屏特效窗口收
  fxDown: (x, y) => ipcRenderer.send("pet:fx-down", x, y),
  fxMove: (x, y) => ipcRenderer.send("pet:fx-move", x, y),
  fxUp: () => ipcRenderer.send("pet:fx-up"),
  onFxDown: (cb) => ipcRenderer.on("fx:down", (_e, x, y) => cb(x, y)),
  onFxMove: (cb) => ipcRenderer.on("fx:move", (_e, x, y) => cb(x, y)),
  onFxUp: (cb) => ipcRenderer.on("fx:up", () => cb()),
});
