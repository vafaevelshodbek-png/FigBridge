/**
 * Theme colours as Figma colour variables: one collection per deck theme, created once per
 * file and reused on later imports. A paint is bound only when the variable's value equals
 * the paint's colour, so binding changes nothing visible.
 */
import type { Slide } from "@figbridge/scene";
import { hexToRgb } from "./geometry.js";

type Definition = NonNullable<Slide["colorVariables"]>;

/** Largest per-channel difference (0–1) at which two colours count as the same. */
const SAME_COLOR = 0.5 / 255;

export class ColorVariables {
  #collection: Promise<VariableCollection> | undefined;
  readonly #variables = new Map<string, Promise<Variable | undefined>>();

  constructor(
    private readonly def: Definition,
    private readonly warnings: string[],
  ) {}

  /** `paint` bound to the theme variable `name`, or unchanged when it cannot be. */
  async bind(paint: SolidPaint, name: string): Promise<SolidPaint> {
    const variable = await this.#variable(name);
    return variable === undefined
      ? paint
      : figma.variables.setBoundVariableForPaint(paint, "color", variable);
  }

  #variable(name: string): Promise<Variable | undefined> {
    let variable = this.#variables.get(name);
    if (variable === undefined) {
      variable = this.#ensure(name);
      this.#variables.set(name, variable);
    }
    return variable;
  }

  async #ensure(name: string): Promise<Variable | undefined> {
    const color = this.def.colors.find((c) => c.name === name)?.color;
    if (color === undefined) return undefined;
    const rgb = hexToRgb(color);
    const collection = await this.#ensureCollection();
    const mode = collection.defaultModeId;
    const existing = (await figma.variables.getLocalVariablesAsync("COLOR")).find(
      (v) => v.name === name && v.variableCollectionId === collection.id,
    );
    if (existing !== undefined) {
      const value = existing.valuesByMode[mode];
      if (isRgb(value) && sameColor(value, rgb)) return existing;
      this.warnings.push(
        `colour variable "${this.def.collection}/${name}" already exists with another value; imported colours are not bound to it`,
      );
      return undefined;
    }
    const variable = figma.variables.createVariable(name, collection, "COLOR");
    variable.setValueForMode(mode, rgb);
    return variable;
  }

  #ensureCollection(): Promise<VariableCollection> {
    this.#collection ??= figma.variables
      .getLocalVariableCollectionsAsync()
      .then(
        (collections) =>
          collections.find((c) => c.name === this.def.collection) ??
          figma.variables.createVariableCollection(this.def.collection),
      );
    return this.#collection;
  }
}

function isRgb(value: unknown): value is RGB {
  return typeof value === "object" && value !== null && "r" in value && "g" in value;
}

function sameColor(a: RGB, b: RGB): boolean {
  return (
    Math.abs(a.r - b.r) <= SAME_COLOR &&
    Math.abs(a.g - b.g) <= SAME_COLOR &&
    Math.abs(a.b - b.b) <= SAME_COLOR
  );
}
