---
name: section-defaults
description: Manage the Section Defaults plugin — per-section defaults for new threads (last-used project, workspace, branch, and model) and shared model presets with weighted random model choice.
---

# Section defaults

When the user presses a sidebar section's **+** (New thread in section)
button, the Section Defaults plugin restores the settings last used to start
a thread from that section: project, environment and machine, worktree base
branch, model, reasoning, and permission mode. They are recorded
automatically each time a thread is sent from that composer.

A section can also choose its model from a weighted list: each entry is a
provider, model, optional reasoning level, service tier, permission mode,
and a weight. Each new thread picks one at random by weight, replacing the
remembered model. The list is either a shared **model preset** (e.g.
"Smart"; sections using it follow edits) or the section's own one-off
list. A preset can also be the global **default** for sections without their
own model choice; it replaces their remembered model while leaving their
remembered project and workspace intact.

```sh
bb section-defaults preset list [--json]
bb section-defaults preset set <name> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults preset rename <preset> <new-name>
bb section-defaults preset delete <preset>   # sections using it keep a one-off copy

bb section-defaults list [--all] [--json]   # --all includes sections with nothing set
bb section-defaults default set <preset>    # fallback for sections without their own models
bb section-defaults default clear           # use last-used models in those sections again
bb section-defaults use <section> <preset>  # link a section to a preset
bb section-defaults set <section> --choice '…' [--choice …]   # one-off list; unlinks any preset
bb section-defaults clear <section>         # remove the section's models
bb section-defaults forget <section>        # forget last-used settings
```

- To change the models for every section on a preset, run `preset set` with
  the preset's existing name; it replaces the whole list.
- A section's own preset or one-off list overrides the default preset.
  Deleting the default preset clears the default.

- `<section>` and `<preset>` are ids (`sec_…`, `mp_…`) or exact names, case-insensitive.
  `bb thread section list` lists sections.
- Last-used settings cannot be set from the CLI; they come from actually
  starting a thread from the section.
- `set` replaces all of a section's one-off models. To add a choice, include the existing ones
  from `list` as well.
- Fields in a `--choice` are separated by spaces or commas. `weight` defaults
  to 1 and may be 0 to disable a choice; `permission` is `accept-edits`,
  `auto`, or `full`. Omitted fields keep bb's defaults.
- Get model ids and reasoning levels from `bb provider models <provider>`.
  bb adjusts a reasoning level or tier the model does not support when the
  preset is applied.

The same settings are editable in Settings → Section Defaults.

If the composer shows **Section defaults failed: X is not available on this
machine**, the drawn model isn't in that machine's provider catalog (check
`bb provider models <provider> --machine <host>`). Fix the machine's provider
config or point the section at a preset whose models that machine offers.
