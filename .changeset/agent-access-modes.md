---
"figbridge": minor
---

Agent access modes in the plugin window: Read only, Ask before changes (default), Auto (asks only before destructive changes) and Unrestricted, chosen per file. The user can pause or stop the agent, approve or deny each change, and follow recent agent actions; agents see the mode in `figma_file_info` and get `DENIED`, `READ_ONLY` or `PAUSED` with guidance instead of silent failures.
