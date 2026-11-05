import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
