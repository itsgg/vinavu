export interface Opts {
  question: string;
  files: string[];
  session?: string;
  model?: string;
  system?: string;
  timeout?: number; // seconds
  followWithin?: number; // minutes
  cont: boolean;
  fresh: boolean;
  interactive: boolean;
  list: boolean;
  raw: boolean;
  json: boolean;
  markdown: boolean;
  quiet: boolean;
  noSources: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    question: "",
    files: [],
    cont: false,
    fresh: false,
    interactive: false,
    list: false,
    raw: false,
    json: false,
    markdown: false,
    quiet: false,
    noSources: false,
    help: false,
    version: false,
  };
  const rest: string[] = [];

  // A flag that takes a value must actually get one. Swallowing the next token
  // silently turned `-s` into a request with no question and `-f` into a crash
  // deep inside readFileSync.
  const value = (i: number, long: string): [string, number] => {
    const v = argv[i + 1];
    // A negative number is a value, not a flag, so `--timeout -3` reaches the
    // range check and reports what is actually wrong with it.
    const looksLikeFlag = v !== undefined && v.startsWith("-") && v !== "-" && !/^-\d/.test(v);
    if (v === undefined || looksLikeFlag) throw new UsageError(`${long} needs a value`);
    return [v, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    switch (a) {
      case "-s":
      case "--session":
        [o.session, i] = value(i, "--session");
        break;
      case "-f":
      case "--file": {
        const [v, ni] = value(i, "--file");
        o.files.push(v);
        i = ni;
        break;
      }
      case "-m":
      case "--model":
        [o.model, i] = value(i, "--model");
        break;
      case "-r":
      case "--research":
        o.model = "research";
        break;
      case "-y":
      case "--system":
        [o.system, i] = value(i, "--system");
        break;
      case "-t":
      case "--timeout": {
        const [v, ni] = value(i, "--timeout");
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0)
          throw new UsageError("--timeout needs a positive number of seconds");
        o.timeout = n;
        i = ni;
        break;
      }
      case "--follow-within": {
        const [v, ni] = value(i, "--follow-within");
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0)
          throw new UsageError("--follow-within needs a positive number of minutes");
        o.followWithin = n;
        i = ni;
        break;
      }
      case "-c":
      case "--continue":
        o.cont = true;
        break;
      case "--new":
        o.fresh = true;
        break;
      case "-i":
      case "--interactive":
        o.interactive = true;
        break;
      case "--list":
        o.list = true;
        break;
      case "--raw":
        o.raw = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--markdown":
        o.markdown = true;
        break;
      case "-q":
      case "--quiet":
        o.quiet = true;
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "-V":
      case "--version":
        o.version = true;
        break;
      case "--no-sources":
        o.noSources = true;
        break;
      default:
        // An unrecognised flag is a mistake, not part of the question: silently
        // folding `--jsn` into the prompt text is the worst of both worlds.
        if (a.startsWith("--") || (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)))
          throw new UsageError(`unknown option: ${a}`);
        rest.push(a);
    }
  }
  o.question = rest.join(" ").trim();
  return o;
}
