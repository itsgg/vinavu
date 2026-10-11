// Terminal theme. Colour is decided once from the environment but stays
// settable, because --raw is only known after arguments are parsed and the
// renderer is imported before that happens.

const ESC = "\x1b[";

let useColor =
  !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
let hyperlinks = useColor && !process.env.NO_HYPERLINKS && process.env.TERM !== "dumb";

// Colour comes from the terminal's own 16-colour palette rather than from fixed
// RGB values. That is what makes vinavu follow the theme the terminal is already
// wearing: the same code reads as warm in a warm theme and cool in a cool one,
// and a hand-picked orange cannot clash with a palette it has never seen.
const ANSI = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightBlack: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
} as const;

/** Force plain output (used by --raw and --json). */
export function setPlain(plain: boolean): void {
  if (!plain) return;
  useColor = false;
  hyperlinks = false;
}

/** Whether colour is being emitted, for the few places that must not rely on it. */
export const colorEnabled = () => useColor;

/** Whether OSC 8 links are being emitted, so a URL need not also be printed. */
export const hyperlinksEnabled = () => hyperlinks;

/** Terminal width, read live so a mid-session resize is picked up. */
export const cols = () => process.stdout.columns || 80;

const attr = (open: string, close: string) => (s: string) =>
  useColor ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const bold = attr("1", "22");
export const italic = attr("3", "23");
export const dim = attr("2", "22");
export const underline = attr("4", "24");

const fg = (code: number) => (s: string) =>
  useColor ? `${ESC}${code}m${s}${ESC}39m` : s;

export const T = {
  h1: fg(ANSI.brightBlue),
  h2: fg(ANSI.blue),
  accent: fg(ANSI.brightCyan),
  tag: fg(ANSI.yellow),
  muted: fg(ANSI.brightBlack),
  link: fg(ANSI.brightBlue),
  code: fg(ANSI.green),
};

export const stripAnsi = (s: string) =>
  s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** Visible width, ignoring colour and hyperlink escapes. */
export const vlen = (s: string) => [...stripAnsi(s)].length;

export function osc8(url: string, text: string): string {
  if (!hyperlinks) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export function renderLink(url: string, text: string): string {
  if (hyperlinks) return T.link(underline(osc8(url, text)));
  if (text === url) return T.link(underline(url));
  return T.link(underline(text)) + T.muted(" (" + url + ")");
}

/**
 * OSC 133;A, the "a prompt starts here" marker.
 *
 * Terminals that understand it (foot, ghostty, kitty, WezTerm, iTerm2, VS Code,
 * Windows Terminal) can then jump between prompts from the keyboard, which in a
 * REPL means jumping between turns. Terminals that do not simply ignore it.
 *
 * Deliberately not tied to the colour setting: this is navigation metadata, not
 * decoration, and NO_COLOR asks for plain text rather than a terminal stripped
 * of the things that make it navigable. It is gated on writing to a terminal at
 * all, so it never lands in a redirected file.
 */
export const PROMPT_MARK = "\x1b]133;A\x1b\\";
export const promptMark = () => (process.stdout.isTTY ? PROMPT_MARK : "");

export { ESC };
