import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");
export const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");
export const RESULTS_DIR = join(REPO_ROOT, "results");
