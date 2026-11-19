# 0006. Layer effects through node.update

- Status: accepted
- Date: 2026-10-03

## Decision

Extend `node.update.props` with an optional `effects` array, rather than adding
separate tools for each effect. Use Figma's names and units: DROP_SHADOW,
INNER_SHADOW, LAYER_BLUR and BACKGROUND_BLUR, RGBA channels in 0–1, pixel offsets
and nonnegative pixel radii. Shadows use NORMAL blending; blurs use NORMAL blur.
Unsupported effect fields and types fail validation. At most 100 effects are accepted.

The array replaces the layer's effect list; an empty array clears it. Omitting
effects preserves the existing list. `node.get` reports the actual effect list.
The plugin validates whether the node supports effects before modifying other
properties. The existing access control, confirmation and agent undo apply.

## Consequences

Existing callers and the method catalog remain compatible. Undo preserves the
original native effects, including fields the update schema does not expose.
This changes the protocol parameters, not the Scene IR or document importers.
Progressive blur, other blend modes and effect style bindings remain outside
this task's scope.
