# bb-plugin-section-defaults

A [bb](https://getbb.app) plugin that gives each sidebar section its own
defaults for new threads.

Press a section's **+** (New thread in section) and the new-thread composer
starts with that section's model instead of the project's last-used one. A
section can list several models with weights. Each new thread then picks one
at random, e.g. 50/50 between Opus 5.5 on high reasoning and GPT-6.1-Sol on
xhigh. Reasoning level, service tier, and permission mode belong to each
model choice, so they always go together.

A line above the composer shows what was picked, with a **Re-roll** button
that switches to one of the section's other choices. You can still change
the pickers by hand before sending.

Sections without a preset, Pinned, the loose Threads group, and the
top-level New thread button are left alone.

## Configure

**Settings → Section Defaults** lists every section. **Add model** adds a
choice, edited with bb's own provider/model/reasoning picker. Each choice can
also set a permission mode and a weight; the page shows the resulting odds.
Remove every choice to return a section to bb's defaults.

Or from a shell:

```sh
bb section-defaults list [--all] [--json]
bb section-defaults set <section> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults clear <section>
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

Each visit to the new-thread screen is rolled once. Going back to the same
visit keeps the earlier pick and any changes you made by hand.

## Install

```sh
git clone git@github.com:frrad/bb-plugin-section-defaults.git
cd bb-plugin-section-defaults
npm install
bb plugin install .
```

## Develop

```sh
npm test           # node --test presets.test.ts placement.test.ts
npm run typecheck
bb plugin build . && bb plugin reload section-defaults
```
