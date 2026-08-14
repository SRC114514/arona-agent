import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { PythonBridge } from "../utils/python.ts";
import { config } from "../config.ts";

let bridge: PythonBridge | null = null;

async function getBridge(): Promise<PythonBridge> {
  if (!bridge || !bridge.isRunning) {
    bridge = new PythonBridge("computer_use.py", [], {
      CUA_API_KEY: config.cuaApiKey,
    });
    await bridge.start();
  }
  return bridge;
}

function imageResult(screenshot: string) {
  return {
    content: [
      { type: "text" as const, text: `Screenshot captured (${Math.round(screenshot.length / 1024)} KB).` },
      { type: "image" as const, data: screenshot, mimeType: "image/png" },
    ],
    details: {},
  };
}

export const computerScreenshot = defineTool({
  name: "computer_screenshot",
  label: "Screenshot",
  description: "Take a screenshot of the current screen. Returns the screenshot as an image.",
  parameters: Type.Object({}),
  execute: async () => {
    const b = await getBridge();
    const result = await b.send({ action: "screenshot" });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export const computerClick = defineTool({
  name: "computer_click",
  label: "Click",
  description: "Click at the specified coordinates on the screen. Returns a new screenshot after clicking.",
  parameters: Type.Object({
    x: Type.Number({ description: "X coordinate" }),
    y: Type.Number({ description: "Y coordinate" }),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("double")], { description: "Mouse button (default: left)" })),
  }),
  execute: async (_id, params) => {
    const b = await getBridge();
    const result = await b.send({ action: "click", x: params.x, y: params.y, button: params.button || "left" });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export const computerType = defineTool({
  name: "computer_type",
  label: "Type Text",
  description: "Type text at the current cursor position. Returns a new screenshot after typing.",
  parameters: Type.Object({
    text: Type.String({ description: "Text to type" }),
  }),
  execute: async (_id, params) => {
    const b = await getBridge();
    const result = await b.send({ action: "type", text: params.text });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export const computerKey = defineTool({
  name: "computer_key",
  label: "Press Keys",
  description: "Press a key combination (e.g. ['ctrl', 'c']). Returns a new screenshot after pressing.",
  parameters: Type.Object({
    keys: Type.Array(Type.String(), { description: "Keys to press, e.g. ['ctrl', 'c'] or ['enter']" }),
  }),
  execute: async (_id, params) => {
    const b = await getBridge();
    const result = await b.send({ action: "key", keys: params.keys });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export const computerScroll = defineTool({
  name: "computer_scroll",
  label: "Scroll",
  description: "Scroll at the specified coordinates. Returns a new screenshot after scrolling.",
  parameters: Type.Object({
    x: Type.Number({ description: "X coordinate" }),
    y: Type.Number({ description: "Y coordinate" }),
    direction: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "Scroll direction (default: down)" })),
    amount: Type.Optional(Type.Number({ description: "Scroll amount in clicks (default: 3)" })),
  }),
  execute: async (_id, params) => {
    const b = await getBridge();
    const result = await b.send({
      action: "scroll",
      x: params.x,
      y: params.y,
      direction: params.direction || "down",
      amount: params.amount || 3,
    });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export const computerMove = defineTool({
  name: "computer_move",
  label: "Move Mouse",
  description: "Move the mouse to the specified coordinates. Returns a new screenshot after moving.",
  parameters: Type.Object({
    x: Type.Number({ description: "X coordinate" }),
    y: Type.Number({ description: "Y coordinate" }),
  }),
  execute: async (_id, params) => {
    const b = await getBridge();
    const result = await b.send({ action: "move", x: params.x, y: params.y });
    if (result.error) throw new Error(result.error);
    return imageResult(result.screenshot);
  },
});

export function stopComputerUse(): void {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
}

export const computerUseTools = [
  computerScreenshot,
  computerClick,
  computerType,
  computerKey,
  computerScroll,
  computerMove,
];
