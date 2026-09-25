/**
 * DrawingML colour models and transforms (ECMA-376 §20.1.2.3), checked against values
 * computed by hand.
 */
import { describe, expect, it } from "vitest";
import { type ColorContext, resolveColor } from "../src/color.js";
import { parseXml } from "../src/xml.js";

const ctx: ColorContext = {
  scheme: new Map([
    ["dk1", "000000"],
    ["lt1", "FFFFFF"],
    ["accent1", "4472C4"],
  ]),
  map: { tx1: "dk1", bg1: "lt1" },
};

const color = (inner: string, placeholder?: { color: string; alpha: number }) =>
  resolveColor(parseXml(`<a:solidFill>${inner}</a:solidFill>`), ctx, placeholder);

describe("colour models", () => {
  it.each([
    ["scheme colour through the colour map", `<a:schemeClr val="tx1"/>`, "#000000"],
    ["scheme colour by its own name", `<a:schemeClr val="accent1"/>`, "#4472C4"],
    ["system colour, last known value", `<a:sysClr val="windowText" lastClr="112233"/>`, "#112233"],
    ["system window colour without a value", `<a:sysClr val="window"/>`, "#FFFFFF"],
    ["system text colour without a value", `<a:sysClr val="windowText"/>`, "#000000"],
    ["preset colour", `<a:prstClr val="navy"/>`, "#000080"],
    ["unknown preset", `<a:prstClr val="burntSienna"/>`, "#000000"],
    ["scRGB (linear) red", `<a:scrgbClr r="100000" g="0" b="0"/>`, "#FF0000"],
    [
      // Linear 0.21404 is sRGB 0.49999: the grey just below the middle.
      "scRGB mid grey",
      `<a:scrgbClr r="21404" g="21404" b="21404"/>`,
      "#7F7F7F",
    ],
    ["HSL red", `<a:hslClr hue="0" sat="100000" lum="50000"/>`, "#FF0000"],
    ["HSL green", `<a:hslClr hue="7200000" sat="100000" lum="50000"/>`, "#00FF00"],
  ])("%s", (_, xml, expected) => {
    expect(color(xml)?.color).toBe(expected);
  });

  it("phClr takes the placeholder colour and alpha", () => {
    expect(color(`<a:schemeClr val="phClr"/>`, { color: "#ABCDEF", alpha: 0.5 })).toEqual({
      color: "#ABCDEF",
      alpha: 0.5,
    });
  });

  it("no colour element means no colour", () => {
    expect(color(`<a:noFill/>`)).toBeUndefined();
  });
});

describe("colour transforms", () => {
  it.each([
    [
      "hue offset turns red into green",
      `<a:srgbClr val="FF0000"><a:hueOff val="7200000"/></a:srgbClr>`,
      "#00FF00",
    ],
    [
      "zero saturation is grey",
      `<a:srgbClr val="FF0000"><a:satMod val="0"/></a:srgbClr>`,
      "#808080",
    ],
    [
      // 808080 has L = 0.502: S 0.5 gives q = 0.751, p = 0.253 → C0 41 41 at hue 0.
      "satOff saturates a grey toward hue 0",
      `<a:srgbClr val="808080"><a:satOff val="50000"/></a:srgbClr>`,
      "#C04141",
    ],
    [
      "lumMod halves lightness",
      `<a:srgbClr val="FFFFFF"><a:lumMod val="50000"/></a:srgbClr>`,
      "#808080",
    ],
    [
      "lumMod then lumOff (PowerPoint's 'lighter 40 %')",
      `<a:srgbClr val="000000"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:srgbClr>`,
      "#666666",
    ],
    [
      "hueMod scales the hue",
      `<a:hslClr hue="14400000" sat="100000" lum="50000"><a:hueMod val="50000"/></a:hslClr>`,
      "#00FF00",
    ],
    ["inverse", `<a:srgbClr val="FFFFFF"><a:inv/></a:srgbClr>`, "#000000"],
    ["grey by luminance", `<a:srgbClr val="00FF00"><a:gray/></a:srgbClr>`, "#B6B6B6"],
    [
      "tint in linear light",
      `<a:srgbClr val="000000"><a:tint val="20000"/></a:srgbClr>`,
      "#E7E7E7",
    ],
    [
      "shade in linear light",
      `<a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr>`,
      "#BCBCBC",
    ],
    ["unknown transforms are ignored", `<a:srgbClr val="123456"><a:comp/></a:srgbClr>`, "#123456"],
  ])("%s", (_, xml, expected) => {
    expect(color(xml)?.color).toBe(expected);
  });

  it("alpha, alphaMod and alphaOff compose and clamp", () => {
    expect(
      color(`<a:srgbClr val="000000"><a:alpha val="80000"/><a:alphaMod val="50000"/></a:srgbClr>`)
        ?.alpha,
    ).toBe(0.4);
    expect(
      color(`<a:srgbClr val="000000"><a:alpha val="10000"/><a:alphaOff val="-50000"/></a:srgbClr>`)
        ?.alpha,
    ).toBe(0);
  });
});
