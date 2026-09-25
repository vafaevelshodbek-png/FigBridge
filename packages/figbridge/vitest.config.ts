import { workspaceProject } from "../../vitest.project.js";

// Golden and end-to-end tests import and render whole decks.
export default workspaceProject("figbridge", { testTimeout: 60_000 });
