// Color and log helpers for the vault CLIs, with no npm dependencies.
// Color is on only when both streams are a TTY and NO_COLOR is unset (FORCE_COLOR overrides),
// so piped or captured output (agents, hooks, `| grep`) stays free of ANSI codes.
const force = process.env.FORCE_COLOR;
const forced = force !== undefined && force !== "0";
export const colorEnabled = forced || (!process.env.NO_COLOR && !!process.stdout.isTTY && !!process.stderr.isTTY);

const wrap = (open: number, close: number) => (s: string | number) =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const pc = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

/** Minimal stand-in for consola: plain lines, with a marker on the levels that need one. */
export const consola = {
  log: (...a: unknown[]) => console.log(...a),
  info: (...a: unknown[]) => console.log(pc.cyan("ℹ"), ...a),
  success: (...a: unknown[]) => console.log(pc.green("✔"), ...a),
  warn: (...a: unknown[]) => console.error(pc.yellow("⚠"), ...a),
  error: (...a: unknown[]) => console.error(pc.red("✖"), ...a),
};
