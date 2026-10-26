---
name: section-defaults
description: Set, list, clear, or forget per-section defaults for new threads (last-used project, workspace, branch, and model; weighted random model choice) with the Section Defaults plugin.
---

# Section defaults

When the user presses a sidebar section's **+** (New thread in section)
button, the Section Defaults plugin restores the settings last used to start
a thread from that section: project, environment and machine, worktree base
branch, model, reasoning, and permission mode. They are recorded
automatically each time a thread is sent from that composer.

A section can also have model choices: each is a provider, model, optional
reasoning level, service tier, permission mode, and a weight. With choices,
each new thread picks one at random by weight, replacing the remembered
model.

```sh
bb section-defaults list [--all] [--json]   # --all includes sections with no preset
bb section-defaults set <section> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults clear <section>    # remove model choices
bb section-defaults forget <section>   # forget last-used settings
```

- `<section>` is a section id (`sec_…`) or its exact name, case-insensitive.
  `bb thread section list` lists sections.
- Last-used settings cannot be set from the CLI; they come from actually
  starting a thread from the section.
- `set` replaces all of a section's choices. To add a choice, include the existing ones
  from `list` as well.
- Fields in a `--choice` are separated by spaces or commas. `weight` defaults
  to 1 and may be 0 to disable a choice; `permission` is `accept-edits`,
  `auto`, or `full`. Omitted fields keep bb's defaults.
- Get model ids and reasoning levels from `bb provider models <provider>`.
  bb adjusts a reasoning level or tier the model does not support when the
  preset is applied.

The same settings are editable in Settings → Section Defaults.
