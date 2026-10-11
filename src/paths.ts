import { homedir } from "node:os";
import { join } from "node:path";

// Everything vinavu writes lives under one root, shared with the engine (its
// thread map and the cached Space id sit beside the sessions). VINAVU_HOME
// relocates it, which keeps tests off the real state.
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
export const HOME = process.env.VINAVU_HOME || join(stateHome, "vinavu");

export const SESS_DIR = join(HOME, "sessions");

// The root holds conversation transcripts and thread tokens, so it is ours alone.
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;
