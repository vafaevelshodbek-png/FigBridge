import { z } from "zod";

const Channel = z.number().min(0).max(1);

export const EffectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["DROP_SHADOW", "INNER_SHADOW"]),
    color: z.strictObject({ r: Channel, g: Channel, b: Channel, a: Channel }),
    offset: z.strictObject({ x: z.number(), y: z.number() }),
    radius: z.number().nonnegative(),
    spread: z.number().default(0),
    visible: z.boolean().default(true),
    blendMode: z.literal("NORMAL").default("NORMAL"),
  }),
  z.strictObject({
    type: z.enum(["LAYER_BLUR", "BACKGROUND_BLUR"]),
    radius: z.number().nonnegative(),
    visible: z.boolean().default(true),
    blurType: z.literal("NORMAL").default("NORMAL"),
  }),
]);
