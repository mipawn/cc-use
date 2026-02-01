import { homedir } from "os";
import { join } from "path";
import packageJson from "../package.json";

export const APP_NAME = "cc-use";
export const VERSION = packageJson.version;

export const CONFIG_DIR = join(homedir(), ".config", APP_NAME);
export const DB_FILE = join(CONFIG_DIR, "cc-use.db");

export const GITHUB_REPO = "mipawn/cc-use";
export const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
