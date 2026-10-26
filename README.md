# bb-plugin-section-defaults

A [bb](https://getbb.app) plugin that gives each sidebar section its own
defaults for new threads.

Press a section's **+** (New thread in section) and the new-thread composer
starts the way you last started a thread from that section: same project,
environment (worktree, checkout, …), machine, worktree base branch, model,
reasoning, and permission mode. Sending a thread from that composer
records its settings for next time.

A section can also list models to choose from, with weights. Each new thread
then picks one at random, e.g. 50/50 between Opus 5.5 on high reasoning and
GPT-6.1-Sol on xhigh; the pick replaces the remembered model. Reasoning
level, service tier, and permission mode belong to each model choice, so
they always go together.

A line above the composer says what was applied, with a **Re-roll** button
when there are model choices to pick between. You can still change anything
by hand before sending.

A section with nothing remembered or configured yet, Pinned, the loose
Threads group, and the top-level New thread button are left alone.

## Configure

**Settings → Section Defaults** lists every section with what it remembers
(**Forget** clears it) and its model choices. **Add model** adds a choice,
edited with bb's own provider/model/reasoning picker. Each choice can also
set a permission mode and a weight; the page shows the resulting odds.
Turn off **Remember last-used settings per section** there to use only the
model choices.

Or from a shell:

```sh
bb section-defaults list [--all] [--json]
bb section-defaults set <section> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults clear <section>    # remove model choices
bb section-defaults forget <section>   # forget last-used settings
```

`<section>` is a section id or name. For example:

```sh
bb section-defaults set research \
  --choice 'claude-code/claude-opus-5-5 reasoning=high' \
  --choice 'codex/gpt-6.1-sol reasoning=xhigh'
```

Weights default to 1. `permission` is `accept-edits`, `auto`, or `full`.
`bb provider models <provider>` lists model ids.

## How it detects the section

bb's plugin API doesn't say which section the new-thread screen was opened
from (the composer reports only its project). The plugin reads it from two
bb internals: the router state the section's **+** button navigates with,
and the `bb.root-compose.placement` sessionStorage entry bb keeps afterwards
([placement.ts](placement.ts)). A bb update could change either. If that
happens, the plugin stops applying presets; nothing else breaks.

Each visit to the new-thread screen is applied once. Going back to the same
visit keeps the earlier pick and any changes you made by hand.

The worktree base branch needs one more workaround. bb's API can select the
Worktree environment but not its branch, so the plugin opens the Worktree
control and clicks the remembered branch ([worktree-branch.ts](worktree-branch.ts)).
If that control changes in a bb update, the branch falls back to the
default. A reused existing environment or worktree is never restored, since
it pins the new thread to an old workspace.

## Install

```sh
git clone git@github.com:frrad/bb-plugin-section-defaults.git
cd bb-plugin-section-defaults
npm install
bb plugin install .
```

## Develop

```sh
npm test           # node --test presets.test.ts placement.test.ts worktree-branch.test.ts
npm run typecheck
bb plugin build . && bb plugin reload section-defaults
```
