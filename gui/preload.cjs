// GUI preload：contextBridge 暴露双向协议通道（send / on）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guiAPI", {
  send(msg) {
    ipcRenderer.send("gui-send", msg);
  },
  on(cb) {
    ipcRenderer.on("gui-event", (_e, msg) => cb(msg));
  },
});
