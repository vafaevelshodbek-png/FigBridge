# First import: ten-minute walkthrough

This checks the README with someone who has never used figbridge. It is a manual
acceptance test, not a substitute for automated tests.

## Before the timer

- Use Windows or macOS with Node 22 or newer and Figma Desktop installed.
- Give the tester the README and an empty Figma Design file.
- While the package is pre-release, provide a source checkout with dependencies
  installed and `pnpm build` completed. Record this preparation separately: it does
  not prove that the future npm installation works.
- Use `corpus/poi_bar-chart.pptx`; the PDF alternative is
  `corpus/beamer_metropolis_demo.pdf`. Both are in the repository's corpus root.

## Walkthrough

1. Start the timer. Follow the README to import the plugin manifest.
2. Configure one supported AI client, using the source command during pre-release.
3. Pair the plugin and leave its window open in Ask mode.
4. Ask the agent to import slide 1 from the PPTX (or page 1 from the PDF).
5. Approve the change in the plugin. Stop the timer when the frame appears.
6. Select and edit text in the imported frame. Confirm it is an editable layer.

The author observes without giving hints. Record every question, error and detour.
If the tester needs help, record it as a README defect even if the import succeeds.

## Record the result

| Field | Result |
|---|---|
| Date and tester | |
| OS, Node and Figma versions | |
| Git commit or package version | |
| AI client | |
| Preparation time outside the timer | |
| Time to first imported frame | |
| Text edited successfully | |
| Questions and errors, with the step | |
| Passed within ten minutes without hints | |

Do not mark the README acceptance complete until a new tester has performed it.
After publishing, repeat from a clean machine with `npx figbridge@0.1.0` to cover
installation as well as connection and import.
