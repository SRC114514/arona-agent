const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petAPI", {
  onEmotion: (cb) => ipcRenderer.on("pet:emotion", (_e, name) => cb(name)),
  onReset: (cb) => ipcRenderer.on("pet:reset", () => cb()),
  onText: (cb) => ipcRenderer.on("pet:text", (_e, p) => cb(p)),
  getAgentConfig: () => ipcRenderer.invoke("pet:get-agent-config"),
  drag: (dx, dy) => ipcRenderer.send("pet:drag", dx, dy),
  dragEnd: () => ipcRenderer.send("pet:dragend"),
  shake: () => ipcRenderer.send("pet:shake"),
  onCursor: (cb) => ipcRenderer.on("pet:cursor", (_e, x, y) => cb(x, y)),
  // 点击/拖尾特效：桌宠窗口发全局屏幕坐标 → 主进程 → 全屏特效窗口收
  fxDown: (x, y) => ipcRenderer.send("pet:fx-down", x, y),
  fxMove: (x, y) => ipcRenderer.send("pet:fx-move", x, y),
  fxUp: () => ipcRenderer.send("pet:fx-up"),
  onFxDown: (cb) => ipcRenderer.on("fx:down", (_e, x, y) => cb(x, y)),
  onFxMove: (cb) => ipcRenderer.on("fx:move", (_e, x, y) => cb(x, y)),
  onFxUp: (cb) => ipcRenderer.on("fx:up", () => cb()),
});
