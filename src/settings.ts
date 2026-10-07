// Limits, mode and toggles, in one settings.json the dashboard can edit. Precedence: the settings
// file, then RN_* environment variables, then cautious defaults. Hard maximums cap everything, so
// no setting can configure an account into a ban. Read fresh on every use: changes apply live.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const DEFAULTS = { daily: 5, likes: 10, commentGapMin: 10, dryRun: true, notify: true, openApproval: true };
export type Settings = typeof DEFAULTS;
export const MAX = { daily: 20, likes: 50, minCommentGapMin: 2, maxCommentGapMin: 1440 };

type Env = Record<string, string | undefined>;
const LABEL: Record<keyof Settings, string> = {
  daily: "Writes per day",
  likes: "Likes per day",
  commentGapMin: "Minutes between comments",
  dryRun: "Dry run",
  notify: "Notifications",
  openApproval: "Open the approval page automatically",
};
const RANGE: Partial<Record<keyof Settings, [number, number]>> = {
  daily: [0, MAX.daily],
  likes: [0, MAX.likes],
  commentGapMin: [MAX.minCommentGapMin, MAX.maxCommentGapMin],
};

/** Strict check for anything coming from the dashboard. Throws a message a person can act on. */
function checked(patch: Partial<Record<keyof Settings, unknown>>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch) as [keyof Settings, unknown][]) {
    if (!(k in DEFAULTS) || v === undefined) continue;
    const range = RANGE[k];
    if (range) {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${LABEL[k]} must be a whole number.`);
      if (v < range[0] || v > range[1]) throw new Error(`${LABEL[k]} must be between ${range[0]} and ${range[1]}.`);
    } else if (typeof v !== "boolean") throw new Error(`${LABEL[k]} must be true or false.`);
    out[k] = v;
  }
  return out as Partial<Settings>;
}

function fromEnv(env: Env): Partial<Settings> {
  const num = (name: string) => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, 0 or more. Got "${raw}".`);
    return n;
  };
  const flag = (name: string) => (env[name] === undefined ? undefined : env[name] !== "0");
  return { daily: num("RN_DAILY_WRITES"), likes: num("RN_DAILY_LIKES"), commentGapMin: num("RN_COMMENT_GAP_MIN"), dryRun: flag("RN_DRY_RUN"), notify: flag("RN_NOTIFY"), openApproval: flag("RN_OPEN_APPROVAL") };
}

function readFile(file: string): Partial<Settings> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} (settings.json) is not valid JSON. Fix or delete it before writes can continue.`);
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function loadSettings(file: string, env: Env = process.env): Settings {
  const defined = (o: Partial<Settings>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const s = { ...DEFAULTS, ...defined(fromEnv(env)), ...defined(readFile(file)) } as Settings;
  return {
    daily: clamp(Math.floor(Number(s.daily)) || 0, 0, MAX.daily),
    likes: clamp(Math.floor(Number(s.likes)) || 0, 0, MAX.likes),
    commentGapMin: clamp(Math.floor(Number(s.commentGapMin)) || 0, MAX.minCommentGapMin, MAX.maxCommentGapMin),
    dryRun: s.dryRun !== false,
    notify: s.notify !== false,
    openApproval: s.openApproval !== false,
  };
}

/** Checks the patch strictly, merges it into the file, writes atomically, returns the result. */
export function saveSettings(file: string, patch: Partial<Record<keyof Settings, unknown>>, env: Env = process.env): Settings {
  const next = { ...readFile(file), ...checked(patch) };
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
  renameSync(`${file}.tmp`, file);
  return loadSettings(file, env);
}
