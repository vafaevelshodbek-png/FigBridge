/**
 * Plugin main thread entry point.
 */
import type { AccessMode } from "@figbridge/protocol";
import { isAccessMode } from "@figbridge/protocol/access";
import type { UiToMain } from "../shared/messages.js";
import { AccessControl, type Answer, APPROVAL_TIMEOUT_MS, type NodeSizer } from "./access.js";
import { Dispatcher } from "./dispatcher.js";
import type { HandlerTable } from "./handlers/context.js";
import * as read from "./handlers/read.js";
import * as write from "./handlers/write.js";
import { FontLoader } from "./render/fonts.js";
import { UiBridge } from "./ui-bridge.js";
import { UndoLog } from "./undo.js";

declare const __PLUGIN_VERSION__: string;
declare const __html__: string;

/** Figma's limit per image side. */
const MAX_IMAGE_SIDE = 4096;

const handlers: HandlerTable = {
  "session.info": read.sessionInfo,
  "page.list": read.pageList,
  "page.set": read.pageSet,
  "page.ensure": write.pageEnsure,
  "document.outline": read.documentOutline,
  "selection.get": read.selectionGet,
  "node.get": read.nodeGet,
  "node.find": read.nodeFind,
  "node.export": read.nodeExport,
  "scene.render": write.sceneRender,
  "nodes.create": write.nodesCreate,
  "node.update": write.nodeUpdate,
  "node.delete": write.nodeDelete,
  "node.clone": write.nodeClone,
};

const ui = new UiBridge();
const fonts = new FontLoader((font) => figma.loadFontAsync(font));

/** Image hashes per blob reference: each image is uploaded to Figma once per plugin run. */
const imageHashes = new Map<string, Promise<string>>();
function resolveImage(blob: string): Promise<string> {
  let pending = imageHashes.get(blob);
  if (pending === undefined) {
    pending = (async () => {
      const bytes = await ui.getBlob(blob);
      const image = figma.createImage(bytes);
      const { width, height } = await image.getSizeAsync();
      if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) {
        throw new Error(
          `Image ${blob} is ${width}×${height}; Figma accepts at most ${MAX_IMAGE_SIDE} px per side.`,
        );
      }
      return image.hash;
    })();
    pending.catch(() => imageHashes.delete(blob));
    imageHashes.set(blob, pending);
  }
  return pending;
}

/** Key of the access mode in the document's plugin data: the choice belongs to the file. */
const ACCESS_KEY = "figbridge.access";
/** Key of the name the user gave this file for agents. */
const LABEL_KEY = "figbridge.label";

/** Answers the user has not given yet, by request id. */
const approvals = new Map<string, (answer: Answer) => void>();

const access = new AccessControl({
  loadMode: () => {
    const saved = figma.root.getPluginData(ACCESS_KEY);
    return isAccessMode(saved) ? saved : undefined;
  },
  saveMode: (mode: AccessMode) => {
    figma.root.setPluginData(ACCESS_KEY, mode);
  },
  askUser: ({ id, method, summary, risk }) =>
    new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(id);
        ui.post({ kind: "approval.closed", id });
        resolve("deny");
      }, APPROVAL_TIMEOUT_MS);
      approvals.set(id, (answer) => {
        clearTimeout(timer);
        approvals.delete(id);
        ui.post({ kind: "approval.closed", id });
        resolve(answer);
      });
      ui.post({
        kind: "approval.request",
        id,
        method,
        summary,
        risk: risk === "destructive" ? "destructive" : "write",
      });
    }),
  onChange: (state) => {
    ui.post({ kind: "access", ...state });
  },
});

/** A node and how many layers it holds, for judging deletions. */
const sizer: NodeSizer = async (id) => {
  const node = await figma.getNodeByIdAsync(id);
  if (node === null) return undefined;
  const descendants = "findAll" in node ? (node as ChildrenMixin).findAll(() => true).length : 0;
  return { type: node.type, size: 1 + descendants };
};

const undo = new UndoLog((latest) => {
  ui.post({
    kind: "undo",
    ...(latest === undefined ? {} : { label: latest.label }),
    possible: latest !== undefined && latest.kind !== "deleted",
  });
});

const dispatcher = new Dispatcher(
  handlers,
  ui,
  fonts,
  resolveImage,
  access,
  undo,
  sizer,
  (message) => {
    figma.notify(message, { timeout: 1500 });
  },
);

figma.showUI(__html__, { width: 320, height: 460, title: "figbridge", themeColors: true });
ui.post({
  kind: "hello-info",
  file: figma.root.name,
  label: figma.root.getPluginData(LABEL_KEY),
  editorType: figma.editorType,
  pluginVersion: __PLUGIN_VERSION__,
});
ui.post({ kind: "access", mode: access.mode, paused: access.paused });

figma.ui.onmessage = (message: UiToMain) => {
  if (ui.handleReply(message)) return;
  switch (message.kind) {
    case "request":
      void dispatcher.handle(message.request);
      return;
    case "cancel":
      dispatcher.cancel(message.id);
      return;
    case "access.set":
      access.setMode(message.mode);
      return;
    case "pause.set":
      access.setPaused(message.paused);
      // Pausing also stops what is running and declines what is waiting for approval.
      if (message.paused) {
        dispatcher.cancelAll();
        for (const answer of approvals.values()) answer("deny");
      }
      return;
    case "approval.answer":
      approvals.get(message.id)?.(message.answer);
      return;
    case "undo.run":
      void undo.undo(fonts).then((detail) => {
        ui.post({
          kind: "activity",
          entry: { id: `undo-${String(Date.now())}`, method: "undo", status: "done", detail },
        });
        figma.notify(`figbridge: ${detail}`, { timeout: 2000 });
      });
      return;
    case "label.set":
      figma.root.setPluginData(LABEL_KEY, message.label.trim().slice(0, 80));
      return;
    case "storage.set":
      void figma.clientStorage.setAsync(message.key, message.value);
      return;
    case "storage.get":
      void figma.clientStorage.getAsync(message.key).then((value: unknown) => {
        ui.post({
          kind: "storage.value",
          ticket: message.ticket,
          value: typeof value === "string" ? value : null,
        });
      });
      return;
    case "blob.got":
    case "yield.done":
    case "blob.put.done":
      return; // handled by ui.handleReply
  }
};
