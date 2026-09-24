/**
 * Logger that writes JSON lines to stderr. stdout is reserved for the MCP stdio transport,
 * so nothing in figbridge may print there.
 */
import { destination, type Logger, pino } from "pino";

export function createLogger(level = process.env["FIGBRIDGE_LOG"] ?? "info"): Logger {
  return pino({ name: "figbridge", level }, destination(2));
}
