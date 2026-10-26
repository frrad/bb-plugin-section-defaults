Give each sidebar section its own defaults for new threads, including a
weighted random pick between models.

## What you get

- A section's **+** button starts the new-thread composer the way you last
  started a thread from that section: project, worktree or checkout, base
  branch, model, reasoning, and permission mode.
- Shared model presets such as "Smart" or "Fast": weighted model lists that
  sections link to and follow when edited, or one-off lists per section.
  Every new thread picks a model at random by weight, and a **Re-roll**
  button picks again.
- A settings page that uses bb's own model and permission pickers, and a
  `bb section-defaults` command for the same settings from a shell.

## How it works

Presets live in the plugin's storage on your bb server. The plugin reads
which section the new-thread screen was opened from out of bb's own
navigation state, which bb does not yet expose as a public API, so a bb
update may need a plugin update.
