import type { Domain } from "./types.js";

const SETTING_DOMAINS: [RegExp, Domain][] = [
  [/^(gyro_\d_(sensor_align|align_)|align_board_|gyro_to_use|gyro_enabled)/, "orientation"],
  [/^(p|i|d|f|d_min|d_max|s)_(roll|pitch|yaw)$/, "tuning"],
  [/^(simplified_(pids_mode|master|i_gain|d_gain|pi_gain|dmax_gain|d_max_gain|feedforward|pitch_d|pitch_pi)|d_max_|iterm_|anti_gravity|throttle_boost|thrust_linear|feedforward_|tpa_|dyn_idle_|acro_trainer|ff_|integrated_yaw|use_integrated_yaw|abs_control|crashflip|pidsum_|motor_output_limit|vbat_sag)/, "tuning"],
  [/^(simplified_(gyro|dterm)|gyro_(lpf|notch|hardware)|dterm_|dyn_notch|rpm_filter|dyn_lpf)/, "filters"],
  [/^(motor_|dshot_|min_throttle|max_throttle|min_command|use_unsynced|mixer_type|yaw_motors_reversed|crashflip_motor)/, "motors"],
  [/^osd_/, "osd"],
  [/^(vtx_|vcd_|extra_)/, "vtx"],
  [/^(rates_type|rc_rate|roll_|pitch_|yaw_|thr_|tpa_rate|throttle_limit|rateprofile_name)/, "rates"],
  [/^(rc_smoothing|serialrx|rx_|rssi|sbus|srxl|crsf|spektrum|airmode_start|deadband|yaw_deadband|ibus)/, "receiver"],
  [/^failsafe_/, "failsafe"],
  [/^(board_|craft_name|pilot_name|vbat_|ibat|ibata|current_|acc_|mag_|baro_|blackbox|gyro_)/, "board"],
];

const COMMAND_DOMAINS: Record<string, Domain> = {
  serial: "serial",
  aux: "modes",
  adjrange: "modes",
  vtxtable: "vtx",
  vtx: "vtx",
  mixer: "motors",
  mmix: "motors",
  smix: "motors",
  servo: "motors",
  motor: "motors",
  map: "receiver",
  rxrange: "receiver",
  rxfail: "receiver",
  feature: "board",
  beeper: "board",
  beacon: "board",
  resource: "board",
  timer: "board",
  dma: "board",
  board_name: "board",
  manufacturer_id: "board",
  led: "other",
  color: "other",
  mode_color: "other",
};

export function domainOfSetting(name: string): Domain {
  if (name.startsWith("extra_")) return "osd";
  for (const [pattern, domain] of SETTING_DOMAINS) if (pattern.test(name)) return domain;
  return "other";
}

export function domainOfCommand(command: string): Domain {
  return COMMAND_DOMAINS[command] ?? "other";
}
