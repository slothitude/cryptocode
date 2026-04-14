import * as path from "node:path";
import * as os from "node:os";

/** Default paths for cryptocode configuration. */
export const CONFIG = {
	configDir: path.join(os.homedir(), ".cryptocode"),
	sessionFile: path.join(os.homedir(), ".cryptocode", "session.json"),
	defaultLowWaterMark: 10_240, // 10 KB
} as const;
