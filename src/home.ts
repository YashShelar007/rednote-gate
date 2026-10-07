// Where data and the login live. Pure, so it is tested without touching the real home folder.
// Order: RN_HOME, then a clone that already has .session/ (older installs), then ~/.rednote-gate.
// RN_DATA_DIR and RN_SESSION_PATH still override their own path.
import { join, resolve } from "node:path";

export type Paths = { home: string; dataDir: string; sessionPath: string };

export function resolveHome(env: Record<string, string | undefined>, root: string, userHome: string, exists: (p: string) => boolean): Paths {
  const home = env.RN_HOME ? resolve(env.RN_HOME) : exists(join(root, ".session")) ? root : join(userHome, ".rednote-gate");
  return {
    home,
    dataDir: env.RN_DATA_DIR || join(home, "data"),
    sessionPath: env.RN_SESSION_PATH || join(home, ".session", "state.json"),
  };
}
