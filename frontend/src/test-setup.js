// Shared test setup (vite.config.js test.setupFiles).
// findBy*/waitFor wait up to 5 s instead of 1 s: lazy page chunks can take longer than 1 s while
// the whole suite runs in parallel, and a timeout there would block a publishing round.
import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 5000 });
