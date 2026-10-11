import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Read the version from the package we were installed as, so `vinavu --version`
// cannot drift from what npm reports.
export const VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [join(here, ".."), join(here, "..", "..")]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg?.name === "vinavu" && typeof pkg.version === "string") return pkg.version;
    } catch {
      // keep looking
    }
  }
  return "0.0.0";
})();
