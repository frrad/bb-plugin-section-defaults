# bb-plugin-section-defaults

A [bb](https://getbb.app) plugin that gives each sidebar section its own
defaults for new threads.

Press a section's **+** (New thread in section) and the new-thread composer
starts the way you last started a thread from that section: same project,
environment (worktree, checkout, …), machine, worktree base branch, model,
reasoning, and permission mode. Sending a thread from that composer
records its settings for next time.

A section can also choose its model from a weighted list. Each new thread
then picks one at random, e.g. 50/50 between Opus 5.5 on high reasoning and
GPT-6.1-Sol on xhigh; the pick replaces the remembered model. Reasoning
level, service tier, and permission mode belong to each model in the list,
so they always go together.

Lists are usually **model presets**: named, shared lists such as "Smart" or
"Fast". Every section using a preset follows edits to it. Set one preset as
the **default** to use it in every section without its own model choice,
instead of the last-used model. A section can also have its own one-off list.

A line above the composer says what was applied, with a **Re-roll** button
when there are model choices to pick between. You can still change anything
by hand before sending.

During startup the composer shows **Loading section defaults…** or
**Applying section defaults…** and waits before accepting input or sends.
The plugin verifies that the selected provider and model match its pick,
retrying that same pick for up to 30 seconds while providers load. A failed
application stays blocked with a **Retry** button. Project-switch remounts
and page reloads retain a pending pick; a visit is marked applied only after
its model switch succeeds.

A section with nothing remembered or configured yet, Pinned, the loose
Threads group, and the top-level New thread button are left alone.

## Configure

**Settings → Section Defaults** has two parts:

- **Model presets.** **New preset** adds one; rename it in place. **Add
  model** adds a model, edited with bb's own provider/model/reasoning
  picker, with an optional permission mode and a weight; the page shows the
  odds and which sections use the preset. Deleting a preset leaves the
  sections that used it with a one-off copy of its models.
- **Default preset.** Applies to every section without its own model choice.
  Set it to **None** to keep using those sections' last-used models.
- **Sections.** Each section picks the default preset (or **Model: last used**
  when there is no default), its own preset, or **One-off models** (which
  starts from a copy of what it used before). It also shows what the section
  remembers; **Forget** clears it.

Turn off **Remember last-used settings per section** there to use only the
model lists.

Or from a shell:

```sh
bb section-defaults preset list [--json]
bb section-defaults preset set <name> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults preset rename <preset> <new-name>
bb section-defaults preset delete <preset>

bb section-defaults list [--all] [--json]
bb section-defaults default set <preset>                # fallback for sections without their own models
bb section-defaults default clear                       # restore last-used models in those sections
bb section-defaults use <section> <preset>              # link a section to a preset
bb section-defaults set <section> --choice '…' [--choice …]   # one-off models
bb section-defaults clear <section>                     # remove the section's models
bb section-defaults forget <section>                    # forget last-used settings
```

Sections and presets are given by id or name. For example:

```sh
bb section-defaults preset set Smart \
  --choice 'claude-code/claude-opus-5-5 reasoning=high' \
  --choice 'codex/gpt-6.1-sol reasoning=xhigh'
bb section-defaults use research Smart
```

`preset set` on an existing name replaces its models, and every section
using it follows. Deleting the default preset clears the default; explicit
section links to any deleted preset become one-off copies.

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
npm test           # pure logic and composer lifecycle regression tests
npm run typecheck
bb plugin build . && bb plugin reload section-defaults
```
