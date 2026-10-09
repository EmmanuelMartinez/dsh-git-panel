# dsh-git-panel

The right Sidebar's **Source control** tab (VS Code-style changes tree with git
status letters and an aggregate folder dot, plus the history graph) and the
read-only `git` Remote it reads, packaged for installations that do not ship
them — including the DeepSeek Harness Desktop application.

## Install

In the DeepSeek Harness Desktop Plugin Manager choose **Add plugin** and enter:

\`\`\`
github:EmmanuelMartinez/dsh-git-panel#v1.0.0
\`\`\`

Then restart the application. Plugins do not auto-update: uninstall and
reinstall to move versions.

## What it contains

- `lib/index.js` — the Host half: the `git` Remote owner, which resolves the
  repository behind a registered Workspace and serves the history graph,
  working-tree status, refs, and file comparisons. `@deepseek-ai/dsh-git-command`
  is compiled in, so the package installs from git without a build step.
- `lib/client.js` — the browser half: the Sidebar tab, its rail button, and the
  changed-file count. It mounts its own generated `git` Remote namespace when
  the deployment's static Client assembly predates it.
- `lib/typert.host.js` — the generated Host Typert assembly discovered through
  the package's `./typert` export.

## What the patch does

The bundle's \`cordis.patch.yml\` inserts this package's row and disables the
in-box \`git-controller\` and \`ui-git\` rows, so a deployment that already has
them loses nothing and one that does not gains the panel. The Host half is
read-only: it reports repository state and changes nothing.
