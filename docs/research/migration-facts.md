# Firmware migration facts

Checked against the Betaflight repository on 2026-11-08. Tags compared: 4.5.5, 2025.12.5, 2026.6.2 and master. These drive the rule packs in `packages/core/src/migrate`.

"First" is the first release line carrying the change: A is 2025.12, B is 2026.6, C is unreleased after 2026.6.2.

## Renames and removals

| 4.5 setting | Result | First | Conversion | Commit |
|---|---|---|---|---|
| `d_min_roll/pitch/yaw` | Merged into `d_max_*`, with roles swapped | A | See tuning | 908f9cc32 |
| `simplified_dmax_gain` | `simplified_d_max_gain` | A | None | 908f9cc32 |
| `dshot_idle_value` | `motor_idle` | A | Same unit | 5ffeea6ab |
| `min_throttle` | Merged into `motor_idle` | A | Analog only: `(min_throttle - min_command) * 10` | 5ffeea6ab |
| `failsafe_off_delay` | `failsafe_landing_time` | A | Old divided by 10 (0.1 s to 1 s) | 254da8f46 |
| `gyro_to_use` | `gyro_enabled_bitmask` | A | FIRST=1, SECOND=2, BOTH=3 | 078ffafec |
| `gyro_N_sensor_align`, `gyro_N_align_*` | Removed; board definition supplies it | A | None | 882b6df93, 88c4117a2 |
| `dyn_idle_start_increase` | Removed | A | None | 6b5b5cfbd |
| `iterm_limit` | Removed; derived from `iterm_windup` | A | None | 3fe4281a6 |
| `crashflip_expo` | Removed | A | None | 7156dc84a |
| `rc_smoothing_feedforward_cutoff` | Removed | A | None | 67abb0d1e |
| `abs_control_*` | Removed | B | None | 19ddd692c |
| `transient_throttle_limit` | Removed | B | None | 319228bd5 |
| `use_integrated_yaw`, `integrated_yaw_relax` | Removed | C | None | 3377776ea |

`gyro_N_bustype`, `gyro_N_spibus` and `gyro_N_i2c_address` still exist at master. A macro builds them, so a plain text search misses them.

`extra_*` settings exist only on the Funny OSD fork branches, in no upstream tag.

`osd_canvas_width` and `osd_canvas_height` are still in `settings.c` at 2025.12 and later, but only under `OSD_CANVAS_SIZE_DEBUG`. Normal builds do not have them. A text search of `settings.c` misses conditions like this, so availability must come from a real build's `get`.

## Measured on hardware

RRIOT F722, cloud builds with the board's options: 4.5.5 has 561 settings, 2025.12.5 has 568, 2026.6.2 has 573.

Changed factory defaults from 4.5.4 to 2026.6.2 on that board: `failsafe_landing_time` 1 to 60 s, `iterm_windup` 85 to 80, `d_max_gain` 37 to 0, `d_max_advance` 20 to 35, `launch_control_mode` NORMAL to PITCHONLY, `feedforward_averaging` OFF to 2_POINT, `feedforward_smooth_factor` 25 to 65, `altitude_d_lpf` 100 to 300.

## PID tuning

P, I, F defaults are unchanged from 4.5 to master. Scaling constants are unchanged. Filter base frequencies are unchanged.

| Tag | Roll P,I,D,F | Pitch | Yaw | D-related default | `d_max_gain` / advance |
|---|---|---|---|---|---|
| 4.5.5 | 45,80,40,120 | 47,84,46,125 | 45,80,0,120 | `D_MIN` 30,34,0 | 37 / 20 |
| 2025.12.5 | 45,80,30,120 | 47,84,34,125 | 45,80,0,120 | `D_MAX` 40,46,0 | 37 / 20 |
| 2026.6.2 | as above | as above | as above | as above | 0 / 35 |

**D semantics.** 4.5 uses `d_min` as the base and `d` as the peak, active only when `0 < d_min < d`. From 2025.12, `d` is the base and `d_max` the peak, active only when `d_max > d > 0`.

Conversion: when `0 < d_min < d`, new `d` is old `d_min`, and new `d_max` is old `d`. Otherwise boost was off, so keep `d` and set `d_max` to 0. Leaving `d_max` at its default would switch boost on.

**`d_max_advance`** was decoupled from gain at 2025.12: new advance = old gain * old advance / 100.

**`thrust_linear`** changed curve at 2026.6 (b8cb32038): `round((-1 + sqrt(1 + 4 * old / 100)) / 2 * 100)`.

**Changed meaning with no published conversion:** `iterm_windup` (clamps I to a share of the pidsum limit, default 85 to 80), feedforward smoothing (now normalized to a 250 Hz packet rate, default 25 to 65) and jitter. D-term biquads became SVF at 2026.6.

## Hardware and wiring

- **Serial function bits** 0 to 7 and 9 to 17 are stable. Master renames bit 15 and moves OSD custom text, with legacy lines translated.
- **`serial` format:** numeric at 4.5. Printed by name from 2025.12, legacy numbers still accepted. Deprecated after 2026.6.2 in favour of `*_uart` settings; output from those firmwares cannot be loaded on older ones.
- **Mode permanent IDs:** none removed or renumbered; only additions.
- **Motor protocol indices** 0 to 9 are stable, DRONECAN appended.
- **`vtxtable`:** syntax and limits unchanged.
- **OSD positions and `osd_stat_bitmask`:** unchanged.
- **`osd_warn_bitmask`:** bit 8 (RC smoothing) was removed at 2025.12, so old bits 9 to 18 moved to 8 to 17. Conversion: `(old & 0xFF) | ((old >> 9) << 8)`.
- `align_board_*` exists at all tags.
