export type BuildOptionGroup = "radio" | "telemetry" | "motor" | "general";

export interface BuildOption {
  id: number;
  define: string;
  label: string;
  group: BuildOptionGroup;
}

function option(group: BuildOptionGroup, id: number, define: string, label: string): BuildOption {
  return { id, define, label, group };
}

/** Numeric identifiers reported by `MSP_BUILD_INFO` on API 1.46 and later. */
export const BUILD_OPTIONS: readonly BuildOption[] = [
  option("radio", 4097, "USE_SERIALRX_CRSF", "CRSF"),
  option("radio", 4098, "USE_SERIALRX_FPORT", "FPort"),
  option("radio", 4099, "USE_SERIALRX_GHST", "GHST"),
  option("radio", 4100, "USE_SERIALRX_IBUS", "iBus"),
  option("radio", 4101, "USE_SERIALRX_JETIEXBUS", "JetiExBus"),
  option("radio", 4102, "USE_RX_PPM", "PPM"),
  option("radio", 4103, "USE_SERIALRX_SBUS", "SBUS"),
  option("radio", 4104, "USE_SERIALRX_SPEKTRUM", "Spektrum"),
  option("radio", 4105, "USE_SERIALRX_SRXL2", "SRXL2"),
  option("radio", 4106, "USE_SERIALRX_SUMD", "SUMD"),
  option("radio", 4107, "USE_SERIALRX_SUMH", "SUMH"),
  option("radio", 4108, "USE_SERIALRX_XBUS", "XBUS"),
  option("radio", 4109, "USE_SERIALRX_MAVLINK", "MAVLink RX"),
  option("telemetry", 12301, "USE_TELEMETRY_FRSKY_HUB", "FrSky Hub"),
  option("telemetry", 12302, "USE_TELEMETRY_HOTT", "HoTT"),
  option("telemetry", 12303, "USE_TELEMETRY_IBUS_EXTENDED", "iBus Extended"),
  option("telemetry", 12304, "USE_TELEMETRY_LTM", "LTM"),
  option("telemetry", 12305, "USE_TELEMETRY_MAVLINK", "MAVLink"),
  option("telemetry", 12306, "USE_TELEMETRY_SMARTPORT", "SmartPort"),
  option("telemetry", 12307, "USE_TELEMETRY_SRXL", "SRXL"),
  option("motor", 8230, "USE_BRUSHED", "Brushed"),
  option("motor", 8231, "USE_DSHOT", "DShot"),
  option("motor", 8232, "USE_MULTISHOT", "Multishot"),
  option("motor", 8233, "USE_ONESHOT", "Oneshot"),
  option("motor", 8234, "USE_PROSHOT", "ProShot"),
  option("motor", 8235, "USE_PWM_OUTPUT", "PWM output"),
  option("motor", 8236, "USE_DRONECAN_ESC", "DroneCAN ESC"),
  option("general", 16404, "USE_ACRO_TRAINER", "Acro trainer"),
  option("general", 16405, "USE_AKK_SMARTAUDIO", "AKK SmartAudio"),
  option("general", 16406, "USE_BATTERY_CONTINUE", "Battery continue"),
  option("general", 16407, "USE_CAMERA_CONTROL", "Camera control"),
  option("general", 16408, "USE_DASHBOARD", "Dashboard"),
  option("general", 16409, "USE_EMFAT_TOOLS", "EMFAT tools"),
  option("general", 16410, "USE_ESCSERIAL_SIMONK", "SimonK ESC serial"),
  option("general", 16411, "USE_FRSKYOSD", "FrSky OSD"),
  option("general", 16412, "USE_GPS", "GPS"),
  option("general", 16413, "USE_LED_STRIP", "LED strip"),
  option("general", 16414, "USE_LED_STRIP_64", "LED strip (64)"),
  option("general", 16415, "USE_MAG", "Magnetometer"),
  option("general", 16416, "USE_OSD_SD", "OSD (SD)"),
  option("general", 16417, "USE_OSD_HD", "OSD (HD)"),
  option("general", 16418, "USE_PINIO", "PINIO"),
  option("general", 16419, "USE_RACE_PRO", "Race Pro"),
  option("general", 16420, "USE_SERVOS", "Servos"),
  option("general", 16421, "USE_VTX", "VTX"),
  option("general", 16422, "USE_ALTITUDE_HOLD", "Altitude hold"),
  option("general", 16423, "USE_SOFTSERIAL", "Soft serial"),
  option("general", 16424, "USE_WING", "Wing"),
  option("general", 16425, "USE_POSITION_HOLD", "Position hold"),
  option("general", 16426, "USE_CHIRP", "Chirp"),
  option("general", 16427, "USE_FLIGHT_PLAN", "Flight plan"),
  option("general", 16428, "USE_OPTICALFLOW", "Optical flow"),
  option("general", 16429, "USE_RANGEFINDER", "Rangefinder"),
  option("general", 16430, "USE_DRONECAN", "DroneCAN"),
  option("general", 16431, "USE_PITOT", "Pitot"),
];

const BY_ID = new Map(BUILD_OPTIONS.map((entry) => [entry.id, entry]));

export interface DecodedBuildOption {
  id: number;
  option: BuildOption | undefined;
}

export function decodeBuildOptions(ids: readonly number[]): DecodedBuildOption[] {
  return ids.map((id) => ({ id, option: BY_ID.get(id) }));
}
