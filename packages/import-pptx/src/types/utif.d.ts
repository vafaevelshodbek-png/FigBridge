// Minimal typings for the parts of UTIF.js (MIT, https://github.com/photopea/UTIF.js) we use.
declare module "utif" {
  interface Ifd {
    width?: number;
    height?: number;
    [tag: string]: unknown;
  }
  const UTIF: {
    decode(buffer: ArrayBuffer | Uint8Array): Ifd[];
    decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: Ifd, ifds?: Ifd[]): void;
    toRGBA8(ifd: Ifd): Uint8Array;
    encodeImage(rgba: Uint8Array, width: number, height: number): ArrayBuffer;
  };
  export default UTIF;
}
