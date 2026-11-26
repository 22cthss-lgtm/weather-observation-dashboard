// Fixed public JSON used as realistic test data, shared with the Python tests
// (fetchers/tests/public_fixture.py). frontend/public/data/ is untracked local
// fetcher output, so tests never read it. Paths are relative to the data root,
// e.g. "images/radar/latest.json".
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Relative to frontend/, where `npm test` and both workflows run Vitest.
// (import.meta.url is not a file: URL under the jsdom environment.)
export const PUBLIC_DATA = resolve("../fetchers/tests/fixtures/public-data");

export function readPublicData(path) {
  return JSON.parse(readFileSync(resolve(PUBLIC_DATA, path), "utf8"));
}
