---
name: section-defaults
description: Set, list, or clear per-section defaults for new threads (model, reasoning, permission, weighted random model choice) with the Section Defaults plugin.
---

# Section defaults

The Section Defaults plugin applies a preset when the user presses a sidebar
section's **+** (New thread in section) button. A preset is a list of
choices; each choice is a provider, model, optional reasoning level, service
tier, permission mode, and a weight. With more than one choice, each new
thread picks one at random by weight. Sections without a preset keep bb's
normal defaults.

```sh
bb section-defaults list [--all] [--json]   # --all includes sections with no preset
bb section-defaults set <section> --choice '<provider>/<model> [reasoning=…] [weight=…] [permission=…] [tier=…]' [--choice …]
bb section-defaults clear <section>
```

- `<section>` is a section id (`sec_…`) or its exact name, case-insensitive.
  `bb thread section list` lists sections.
- `set` replaces the whole preset. To add a choice, include the existing ones
  from `list` as well.
- Fields in a `--choice` are separated by spaces or commas. `weight` defaults
  to 1 and may be 0 to disable a choice; `permission` is `accept-edits`,
  `auto`, or `full`. Omitted fields keep bb's defaults.
- Get model ids and reasoning levels from `bb provider models <provider>`.
  bb adjusts a reasoning level or tier the model does not support when the
  preset is applied.

The same settings are editable in Settings → Section Defaults.
