/**
 * Plugin main thread entry point.
 */
import type { UiToMain } from "../shared/messages.js";
import { Dispatcher } from "./dispatcher.js";
import type { HandlerTable } from "./handlers/context.js";
import * as read from "./handlers/read.js";
import * as write from "./handlers/write.js";
import { FontLoader } from "./render/fonts.js";
import { UiBridge } from "./ui-bridge.js";

declare const __PLUGIN_VERSION__: string;
declare const __html__: string;

/** Figma's limit per image side. */
const MAX_IMAGE_SIDE = 4096;

const handlers: HandlerTable = {
  "session.info": read.sessionInfo,
  "page.list": read.pageList,
  "page.set": read.pageSet,
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

const dispatcher = new Dispatcher(handlers, ui, fonts, resolveImage);

figma.showUI(__html__, { width: 300, height: 220, title: "figbridge", themeColors: true });
ui.post({
  kind: "hello-info",
  file: figma.root.name,
  editorType: figma.editorType,
  pluginVersion: __PLUGIN_VERSION__,
});

figma.ui.onmessage = (message: UiToMain) => {
  if (ui.handleReply(message)) return;
  switch (message.kind) {
    case "request":
      void dispatcher.handle(message.request);
      return;
    case "cancel":
      dispatcher.cancel(message.id);
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
    case "blob.put.done":
      return; // handled by ui.handleReply
  }
};
