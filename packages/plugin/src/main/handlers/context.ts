/**
 * What every method handler receives, and the handler signature.
 */
import type { MethodName, MethodParamsParsed, MethodResult } from "@figbridge/protocol";
import type { AccessControl } from "../access.js";
import type { FontLoader } from "../render/fonts.js";
import type { ImageResolver } from "../render/paints.js";
import type { UiBridge } from "../ui-bridge.js";
import type { UndoLog } from "../undo.js";

export interface HandlerContext {
  ui: UiBridge;
  access: AccessControl;
  /** Records what the agent changed, for "Undo agent" in the plugin window. */
  undo: UndoLog;
  fonts: FontLoader;
  images: ImageResolver;
  /** Throws a CANCELLED error when the hub cancelled this request. */
  readonly checkCancelled: () => void;
  readonly progress: (done: number, total?: number) => void;
}

export type Handler<M extends MethodName> = (
  params: MethodParamsParsed<M>,
  ctx: HandlerContext,
) => Promise<MethodResult<M>>;

export type HandlerTable = { [M in MethodName]: Handler<M> };

/** Error with a protocol code, thrown by handlers and serialized by the dispatcher. */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function requireNode(id: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (node === null)
    throw new PluginError("NODE_NOT_FOUND", `Node ${id} does not exist in this file.`);
  return node;
}

export async function requireContainer(id: string | undefined): Promise<BaseNode & ChildrenMixin> {
  if (id === undefined) return figma.currentPage;
  const node = await requireNode(id);
  if (!("appendChild" in node))
    throw new PluginError("VALIDATION", `Node ${id} cannot contain children.`);
  return node as BaseNode & ChildrenMixin;
}
