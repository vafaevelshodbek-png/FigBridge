import { workspaceProject } from "../../vitest.project.js";

// Render tests import whole decks first.
export default workspaceProject("plugin", { testTimeout: 60_000 });
