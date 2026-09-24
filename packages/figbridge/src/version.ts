/** Package version, inlined at build time from package.json. */
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
