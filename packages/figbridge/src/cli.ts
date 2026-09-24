#!/usr/bin/env node
/**
 * figbridge command-line interface.
 *
 *   figbridge mcp            MCP server on stdio (what AI clients launch)
 *   figbridge start          run the hub in the foreground (no AI client needed)
 *   figbridge pair           print the pairing token for the Figma plugin
 *   figbridge status         show whether the hub runs and which files are connected
 *   figbridge call <method>  call a plugin method with JSON params (scripts, debugging)
 *   figbridge export <node>  export a node to a file
 *
 * stdout carries command output (and the MCP protocol for `mcp`); logs go to stderr.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BridgeError, isMethodName, METHODS } from "@figbridge/protocol";
import { Command, Option } from "commander";
import { RemoteHubClient } from "./client.js";
import { hubPort, loadOrCreateToken, pairingCode, stateDir } from "./config.js";
import { importDeck } from "./import-deck.js";
import { serveMcp } from "./mcp/server.js";
import { startRuntime } from "./runtime.js";
import { VERSION } from "./version.js";

/** Exit codes: 0 ok, 1 figbridge error, 2 usage error. */
const EXIT_ERROR = 1;

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function remote(): RemoteHubClient {
  return new RemoteHubClient(`http://127.0.0.1:${String(hubPort())}`, loadOrCreateToken());
}

/** Resolve on SIGINT/SIGTERM or when the parent closes our stdin (MCP client exited). */
function untilShutdown(options: { watchStdin: boolean }): Promise<void> {
  return new Promise((done) => {
    process.once("SIGINT", () => {
      done();
    });
    process.once("SIGTERM", () => {
      done();
    });
    // Windows does not deliver SIGTERM to children reliably; stdin EOF is the portable signal.
    if (options.watchStdin) {
      process.stdin.once("end", () => {
        done();
      });
      process.stdin.once("close", () => {
        done();
      });
    }
  });
}

const program = new Command()
  .name("figbridge")
  .description(
    "Let AI agents read and write Figma, and turn PDF/PPTX decks into editable Figma layers.",
  )
  .version(VERSION);

program
  .command("mcp")
  .description("Serve MCP on stdio (launched by Claude Code, Cursor, VS Code, …)")
  .addOption(new Option("--read-only", "reject every tool that modifies the document"))
  .action(async (options: { readOnly?: boolean }) => {
    const runtime = await startRuntime({ readOnly: options.readOnly === true });
    const mcp = serveMcp(runtime.client);
    await untilShutdown({ watchStdin: true });
    await mcp.close();
    await runtime.close();
  });

program
  .command("start")
  .description("Run the hub in the foreground so the Figma plugin can connect")
  .addOption(new Option("--read-only", "reject every method that modifies the document"))
  .action(async (options: { readOnly?: boolean }) => {
    const runtime = await startRuntime({
      readOnly: options.readOnly === true,
      requireOwnership: true,
    });
    out(
      `figbridge hub on 127.0.0.1:${String(runtime.port)} — pairing code ${pairingCode(loadOrCreateToken())}. Ctrl+C to stop.`,
    );
    await untilShutdown({ watchStdin: false });
    await runtime.close();
  });

program
  .command("pair")
  .description("Print the pairing token to paste into the Figma plugin")
  .action(() => {
    const token = loadOrCreateToken();
    out(token);
    process.stderr.write(
      `Paste this token into the figbridge plugin (Plugins → Development → figbridge).\n` +
        `Stored in ${stateDir()}; keep it private — it grants edit access to open Figma files.\n`,
    );
  });

program
  .command("status")
  .description("Show the hub state and connected Figma files")
  .action(async () => {
    try {
      const sessions = await remote().sessions();
      out(JSON.stringify({ hub: `127.0.0.1:${String(hubPort())}`, sessions }, null, 2));
    } catch (error) {
      throw BridgeError.from(error);
    }
  });

program
  .command("call")
  .description(`Call a plugin method: ${Object.keys(METHODS).join(", ")}`)
  .argument("<method>", "method name")
  .argument("[params]", "JSON parameters", "{}")
  .option("-s, --session <id>", "target session when several files are connected")
  .action(async (method: string, params: string, options: { session?: string }) => {
    if (!isMethodName(method))
      throw new BridgeError("METHOD_NOT_FOUND", `Unknown method "${method}".`);
    const result = await remote().invoke(method, JSON.parse(params), { session: options.session });
    out(JSON.stringify(result, null, 2));
  });

program
  .command("export")
  .description("Export a node to a PNG/JPG/SVG file")
  .argument("<node>", "node id, e.g. 12:34 (or 12-34 as in Figma URLs)")
  .requiredOption("-o, --out <file>", "output file")
  .option("-f, --format <format>", "png | jpg | svg", "png")
  .option("--scale <n>", "scale factor", "1")
  .option("-s, --session <id>", "target session")
  .action(
    async (
      node: string,
      options: { out: string; format: string; scale: string; session?: string },
    ) => {
      const client = remote();
      const params = METHODS["node.export"].params.parse({
        nodeId: node.replaceAll("-", ":"),
        format: options.format,
        scale: Number(options.scale),
      });
      const exported = await client.call("node.export", params, { session: options.session });
      const { bytes } = await client.getBlob(exported.blob);
      const path = resolve(options.out);
      await writeFile(path, bytes);
      out(JSON.stringify({ file: path, width: exported.width, height: exported.height }));
    },
  );

program
  .command("import")
  .description("Import a PDF deck into the connected Figma file as editable slides")
  .argument("<file>", "path to a .pdf file")
  .option("-p, --pages <list>", "comma-separated 1-based pages, e.g. 1,3,5")
  .option("--x <n>", "grid origin x", "0")
  .option("--y <n>", "grid origin y", "0")
  .option("-s, --session <id>", "target session")
  .action(
    async (file: string, options: { pages?: string; x: string; y: string; session?: string }) => {
      const result = await importDeck(remote(), {
        path: resolve(file),
        pages: options.pages?.split(",").map(Number),
        x: Number(options.x),
        y: Number(options.y),
        session: options.session,
        onProgress: (done, total) => {
          process.stderr.write(`slide ${String(done)}/${String(total)}
`);
        },
      });
      out(JSON.stringify(result, null, 2));
    },
  );

program.parseAsync().catch((error: unknown) => {
  const bridgeError = BridgeError.from(error);
  process.stderr.write(`figbridge: ${bridgeError.code}: ${bridgeError.message}\n`);
  process.exitCode = EXIT_ERROR;
});
