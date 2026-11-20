# Model routing

Example routing file for the CLI and tests. Not used by the plugin unless you point
`PASEO_MODEL_ROUTING_FILE` at it.

active: fast

## Quick routing

Lead sees this before creating a Peer. It is a copy of the active preset.

| Tier | Provider | Model | Effort | Note |
| --- | --- | --- | --- | --- |
| `routine` | `example-peer` | `model-small` | low | - |
| `review` | - | - | - | two models of different families |

## Presets

Switch with the `active:` line above or the Model routing plugin in Paseo.
Quick routing is a copy of the active preset's table; the plugin rewrites it on
save. When editing by hand, change the preset table and Quick routing together.

- `fast`: Small model for routine work.
- `careful`: Large model for routine work; a lead row for Supervisors.

### `fast`

| Tier | Provider | Model | Effort | Note |
| --- | --- | --- | --- | --- |
| `routine` | `example-peer` | `model-small` | low | - |
| `review` | - | - | - | two models of different families |

### `careful`

| Tier | Provider | Model | Effort | Note |
| --- | --- | --- | --- | --- |
| `routine` | `example-peer` | `model-large` | high | - |
| `light` | `example-peer` | `model-small` | low | - |
| `lead` | `example-lead` | `model-large` | high | - |
