# Alpha Migrate: design

Status: research and design, 2026-11-12. The first implementation follows it; see docs/SPEC.md section 10 for what was built and what still needs hardware.

Alpha Migrate is a future bf-migrate feature: it moves a T-Motor Pacer G4 Alpha flight controller from FETtec's Alpha firmware to Betaflight over an ST-Link driven from the browser. It also flashes boards that were already migrated, since the board is not in Betaflight's cloud build.

## How to read the citations

| Tag | Source | Version read |
|---|---|---|
| `FT/` | `../fix-thobby-g4-alpha` (the owner's repo) | commit `99aacbd` (2026-11-12 20:03). NOTES.md changed while this was researched; line numbers are for that commit. |
| `BM/` | this repository | commit `1e61349` |
| `BF/` | `../betaflight` | master `a12049c58` (2026-11-08); `BF@2026.6.2/` means the tag |
| `HAL/` | `BF/lib/main/STM32G4/Drivers/` | same checkout |
| `BFC/` | `BF/src/config` (the `betaflight/config` submodule) | `55232c8` (2026-09-18) |
| `FA/` | `../fettec-archives` (the owner's archive) | working tree |
| `OCD/` | openocd-org/openocd `src/jtag/drivers/stlink_usb.c` | master, fetched 2026-11-12 |
| `WSL/` | devanlai/webstlink | master (last push 2018-09-07) |
| `STL/` | stlink-org/stlink | master, fetched 2026-11-12 |

Evidence words follow the owner's notes: **observed**, **metered**, **disassembly**, **emulated**, **inferred** (`FT/NOTES.md:5`). Anything this document reasons out without a source is marked **inferred** or **design choice**.

---

## 1. The procedure that took a G4 Alpha to Betaflight

### 1.1 The board and the chip

- MCU: STM32G473CEU6, UFQFPN48, 512 KB flash; gyro IIM-42652 (`FT/NOTES.md:9`). Betaflight builds it as the `STM32G474` target (`FT/NOTES.md:86`, `FT/betaflight-config/TMOTORG4ALPHAHD/config.h:46`). No crystal (`config.h:23`).
- Debug ID: STM32G47x/G48x report DEV_ID `0x469` (`STL/config/chips/G47x_G48x.chip:5`), read from `DBGMCU_IDCODE` at `0xE0042000`, mask `0xFFF` (`HAL/CMSIS/Device/ST/STM32G4xx/Include/stm32g474xx.h:1325,3121`).
- SWD pins: PA13/SWDIO is package pin 36, PA14/SWCLK pin 37, NRST pin 7, PB8/BOOT0 pin 46 (`FT/NOTES.md:23-28`).
- Pads (**metered**): the lower gold pad beside the USB-C is SWCLK and the upper one SWDIO. The button by the USB-C is reset (outer leg GND). There is no boot button (`FT/NOTES.md:36-40`).
- PA14 (SWCLK) is also the DJI plug's SBUS pin and the receiver plug's SIG (`FT/NOTES.md:141,149,155`). An attached ST-Link blocks SBUS, and enabling UART2 takes PA14 away from SWD (`FT/NOTES.md:320`).
- PA15 is coupled to an SWD line. Driving it stopped SWD (`FT/NOTES.md:191`).

### 1.2 Why it needs SWD at all

Alpha 0.7.63 and 0.7.73, in every brand's build, run a routine on every boot that sets RDP to `0x01` (Level 1) and clears `nSWBOOT0` (**disassembly**, at `0x08021124` in `TMOTOR_ALPHA_FC_G4_07_73`, `FT/NOTES.md:48-53`). As a result:

- Read protection blocks flash readout over SWD and ROM DFU (`FT/NOTES.md:59`).
- Removing it mass-erases the chip, FETtec's bootloader included, and no published G4 firmware contains that bootloader (`FT/NOTES.md:60`).
- Alpha has no software route to ROM DFU, and the BOOT0 pin is ignored (`FT/NOTES.md:53,62`).
- No way was found around soldering and an ST-Link (`FT/NOTES.md:63`).

Flash layout:

- Alpha images start at `0x08003800`; the first 14 KB is FETtec's bootloader (`FT/NOTES.md:85`).
- Betaflight's G474 link script places code in `FLASH` at `0x08000000` (10 KB), `FLASH_CONFIG` at `0x08004000` (8 KB) and `FLASH1` at `0x08006000` (496 KB). System memory (the ROM bootloader) is at `0x1FFF0000` (`BF/src/platform/STM32/link/stm32_flash_g474.ld:14-18`).

### 1.3 The operations, in order

The tested run was on the **bad** board, a board already bricked by a failed flash, on 2026-11-09 (`FT/NOTES.md:105`). Tools: STM32CubeProgrammer 2.23.0 (in CubeCLT 1.22.0) and an ST-Link V2 clone on firmware V2J39S7 (`FT/NOTES.md:100-101`).

**Wiring.** GND first, SWCLK to the lower pad, SWDIO to the upper pad. The ST-Link's 3.3 V and RST stay unconnected, and the FC is powered from its USB-C (`FT/NOTES.md:107`).

| # | Operation, as the notes record it | What it does in hardware | Reversible? | What the user loses | Source |
|---|---|---|---|---|---|
| 0 | Back up | Only the option bytes could be read. The flash could not be read, because RDP Level 1 blocks it. | n/a | n/a | `FT/NOTES.md:59,67,81` |
| 1 | `STM32_Programmer_CLI -c port=SWD freq=480 mode=HOTPLUG -ob displ` | Connects without reset at 480 kHz and reads `FLASH_OPTR` (`0x40022020`) and the WRP/PCROP/SEC registers. Read `FLASH_OPTR = 0xFBEFF800`: RDP `0x00` (Level 1), `nSWBOOT0 = 0`, `nBOOT0 = 1`. Factory value is `0xFFEFF8AA`. WRP, PCROP, the secure area and BOOT_LOCK were all inactive. | Yes (read-only) | Nothing | `FT/NOTES.md:67-75,111`; register offsets `stm32g474xx.h:459-479` |
| 2 | `STM32_Programmer_CLI -c port=SWD freq=480 mode=NORMAL -ob RDP=0xAA` | RDP regression from Level 1 to Level 0. The chip mass-erases all flash as part of it. In register terms: unlock `FLASH_CR` (KEYR keys), unlock OPTLOCK (OPTKEYR keys), write OPTR with RDP=`0xAA`, set OPTSTRT, wait for BSY, then OBL_LAUNCH, which resets the chip. | **No, one-way** | The Alpha firmware, all Alpha settings, and FETtec's bootloader (`0x08000000-0x080037FF`). The bootloader is unpublished and unreadable, so it is gone for good. | `FT/NOTES.md:60,105,114`; sequence `HAL/STM32G4xx_HAL_Driver/Src/stm32g4xx_hal_flash.c:537-555,581-584`, `STL/src/stlink-lib/option_bytes.c:541-567` |
| 2b | Not in the command list: "This recovery briefly set it [`nSWBOOT0`] to 1 and then put it back" | Two extra option-byte writes | Yes | Nothing | `FT/NOTES.md:127` |
| 3 | Read-back: "all 524,288 bytes of flash read back as `0xFF`" (command not recorded) | Full flash read at Level 0 | Yes | Nothing | `FT/NOTES.md:122` |
| 4 | `STM32_Programmer_CLI -c port=SWD freq=480 mode=NORMAL -w betaflight_2026.6.2_STM32G474.hex -v -rst` | Programs Betaflight's generic G474 hex from `0x08000000`, verifies it, and resets. | Yes: it can be rewritten over SWD or DFU | Nothing (the flash was blank) | `FT/NOTES.md:117,123` |
| 5 | Result | The board enumerates as a COM port. MSP reports `BTFL` 2026.6.2, board `G474`, API 1.48. `FLASH_OPTR` now reads `0xFBEFF8AA`: Level 0, BOOT0 pin ignored. | | | `FT/NOTES.md:123-127` |
| 6 | Later: the custom `TMOTORG4ALPHAHD` build "flashed over SWD" and again "after a mass erase" (commands not recorded) | Mass erase at Level 0 (reversible, since the flash holds only Betaflight), then a write | Yes | Betaflight settings, if mass-erased | `FT/NOTES.md:300,339` |
| 7 | Every later flash: `bfcli.py COM8 bl`, then `STM32_Programmer_CLI -c port=USB1 -w ... -v -g 0x08000000` | Betaflight's `bl` jumps to the ROM bootloader in software, and the ROM's USB DFU writes the image. Page erase only, so settings survive. | Yes | Nothing | `FT/NOTES.md:125,369-376,429,504` |

How Betaflight reaches DFU with the BOOT0 pin ignored: `systemResetToBootloader` stores a reset reason and resets. On the next boot `systemJumpToBootloader` remaps system memory and jumps to `0x1FFF0000` (`BF/src/platform/STM32/system_stm32g4xx.c:87-99,101-138`).

**Leave `nSWBOOT0` at 0.** PB8 is both BOOT0 and UART3 RX (R3, the DJI plug). If the pin were honoured, anything idling high on R3 would boot the chip into ROM DFU (`FT/NOTES.md:127`, `config.h:40-41`).

**Where the image lands.** Betaflight's hex fills `0x08000000-0x080027FF` and from `0x08006000` up. The 8 KB config area at `0x08004000` is written by Betaflight at runtime, not by the hex (**inferred** from `stm32_flash_g474.ld:14-16`). That is why DFU page-erase flashes kept settings (`FT/NOTES.md:429`).

**After the erase, before the write.** The board does nothing over USB. With `nSWBOOT0 = 0` and `nBOOT0 = 1` it always boots main flash (`FT/NOTES.md:53`), and the G4 has no empty-flash boot check: the FLASH register block in `stm32g474xx.h` has no EMPTY flag (**inferred**). SWD at Level 0 can always finish the write.

### 1.4 What the notes do not cover

These gaps matter for the app.

1. **No stock board has been converted.** The tested board had a non-running image (`FT/NOTES.md:17,81`). The good board, still on Alpha 0.7.73, "has not been written to" (`FT/NOTES.md:3,545`).
2. **Hot-plug SWD on a running Alpha board will probably fail (inferred).** Alpha runs USART2 in half-duplex on PA14, which is SWCLK (`FT/NOTES.md:141`). Its receiver scan reconfigures USART2 repeatedly (`FT/NOTES.md:218-229`). Under Betaflight, UART2 on PA14 takes the pin from SWD (`FT/NOTES.md:320`). So the stock-board path likely needs connect-under-reset. The notes used `mode=HOTPLUG` and `mode=NORMAL`, never `mode=UR`.
3. **The stock option-byte value is inferred.** From the routine it should be RDP `0x00` or `0x01` with `nSWBOOT0 = 0`, for example `0xFBEFF801` or `0xFBEFF800`. A board whose last Alpha was older than 0.7.63 may still have `nSWBOOT0 = 1` (`FT/NOTES.md:55`).
4. **Alpha's MSP identity is unknown.** A stock board enumerates as `0483:5740` (`FT/NOTES.md:14`; `FA/gui.fettec.net/js/common/Serial/webSerial.js:5` lists decimal 1155/22336), the same VID:PID as Betaflight's VCP. What Alpha answers to `MSP_FC_VARIANT` or `MSP_BOARD_INFO` is not recorded. Alpha does answer at least `MSP_RC` (`FT/NOTES.md:157`).
5. **Write speed over ST-Link was not recorded.**

---

## 2. HD versus Analog

What the notes and archives say:

- Every result in the notes is for the HD board (`FT/NOTES.md:1`, `config.h:22-42`).
- An Analog board was ordered on 2026-11-12. The plan on arrival is to read the Alpha version and the MSP target name first and expect SWD. The OSD is "the open question": an AT7456E or another MAX7456-type chip on SPI if there is one; no Betaflight driver if the MCU makes the OSD itself. The plan also says "Expect most pins to match the HD board (same MCU and family); check each one rather than assume" (`FT/NOTES.md:546-549`).
- T-Motor's manual (`FA/docs/tmotor-manual.docx`, extracted text):
  - The DJI AirUnit socket and the receiver socket are "on HD version".
  - "Both Analog and HD version have 5V 3 A BEC, and the HD version excludes 12 V 1.5A BEC". The wording is ambiguous. The HD board does have a 9-12 V regulator for the DJI plug, switched by PC6 (`FT/NOTES.md:211,317`).
  - "Analog video transmission can be directly adjusted using analog OSD. (On Analog Version only, due to Excluded OSD MCU)".
  - The Analog board has VI and VO pads for the camera and VTX.
- Alpha sets up PC4 next to the SPI pins "like a second chip select, for a device the HD board may not have" (`FT/NOTES.md:267`). That would fit an OSD chip select on the Analog board (**inferred**).
- The archive has one T-Motor image per Alpha release (for example `FA/FETtec-Firmware/0.7.73/TMOTOR_ALPHA_FC_G4_07_73.hex`). One image probably serves both variants (**inferred**).

Unknown for Analog:

- the MCU part and package (very likely the same, **inferred**);
- whether the SWD pads exist and where;
- the OSD chip, its SPI bus and CS pin;
- whether PC6 and its regulator exist;
- the receiver plug wiring;
- the VBAT divider, beeper, LEDs and LED strip pins;
- its board name;
- how to tell the two variants apart before migration. Nothing in the notes does it over SWD, so the app has to ask the user.

What should carry over unchanged: the SWD procedure itself (RDP, mass erase, writing). It depends on the MCU, not the board (**inferred**).

---

## 3. The firmware a migrated board needs

**What it is.** Betaflight 2026.6.2 built from a plain export of the tag, plus `FT/betaflight-config/TMOTORG4ALPHAHD/config.h` and two patches. Build flags: `-DCLOUD_BUILD -DUSE_SERIALRX -DUSE_SERIALRX_CRSF -DUSE_SERIALRX_SBUS -DUSE_TELEMETRY -DUSE_TELEMETRY_CRSF -DUSE_OSD_HD -DUSE_DSHOT -DUSE_LED_STRIP -DUSE_PINIO -DUSE_VTX` (`FT/NOTES.md:343-363`). The patches:

- `stm32g4-adc-oversampling.patch` turns on the G4 ADC's 256× hardware oversampler. Without it the battery reading is so noisy that the cell count may never be detected, so the OSD shows 0.00 average cell and the low-battery warnings have no threshold (`FT/NOTES.md:344,423,508-516`; patch header `:1-17`). 256× is the chosen ratio (`FT/NOTES.md:557`).
- `stm32g4-lpuart1-init.patch` backports Betaflight PR #15723 (commit `e29ff7245`, on master after 2026.6.2), so LPUART1, the ESC telemetry line, starts (`FT/NOTES.md:239-240,345`; `BF` log shows `e29ff7245`).
- The 2026.6.x IIM-42652 detection bug is worked around in `config.h` by also enabling the ICM-42688P driver (`config.h:53-57`, `FT/NOTES.md:305`).

The board currently runs this build (`FT/NOTES.md:518`).

**The official alternative.** Betaflight's generic `STM32G474` build, plus pins from the CLI script `generic-build.cli.txt`, was the first image that ran (`FT/NOTES.md:117,129`). It is an asset of the betaflight/betaflight 2026.6.2 GitHub release (`betaflight_2026.6.2_STM32G474.hex`, 1,298,936 bytes, which is roughly 460 KB of binary, **inferred** from Intel-hex overhead). It is not a cloud-build target: `build.betaflight.com/api/targets/STM32G474` returns 404. Its drawbacks: no LED strip (`generic-build.cli.txt:8`), the 0.00-cell fault (`FT/NOTES.md:515`), and LPUART1 never starts (`FT/NOTES.md:239`).

**Where a browser app gets an image:**

| Source | Fit | Notes |
|---|---|---|
| A. Project-built hex, served by the app | **Recommended for the MVP** | CI builds the tag, the patches and the config with the recipe in `FT/NOTES.md:347-363`. It publishes the hex, a manifest, its sha256, and the exact source (tag, patches, config, flags). Serve it from the app's own origin: bf-migrate deploys one Worker for the site and `/api` (`BM/docs/PLAN.md:10`). GitHub release downloads send no `Access-Control-Allow-Origin` on the 302 (checked with curl), so a browser cannot fetch them directly. GPL: anyone distributing firmware must make the corresponding source, board config included, available (`betaflight.com/docs/development/manufacturer/hardware-policy` line 39). Pin the sha256 in the app bundle. |
| B. User-supplied `.hex` | Advanced option | Reuse `BM/packages/core/src/firmware/hex.ts` (`parseIntelHex`) and validate it (see 6.7). |
| C. Generic `STM32G474` release hex plus a CLI pin script | Fallback only | Fully official, but it carries the faults above. It needs the same-origin mirror too. |
| D. Betaflight cloud build | Future | Only if `betaflight/config` accepts the config and a release includes the ADC fix (`FT/NOTES.md:555,563-569`). bf-migrate's `BuildApi` would then work unchanged (`BM/packages/core/src/firmware/build-api.ts:70-127`). |

**Flashing a migrated board: DFU, not SWD.** After migration the board is at Level 0, and `bl` reaches ROM DFU (`FT/NOTES.md:125`). Every later build in the notes went over USB DFU with settings kept (`FT/NOTES.md:369-376,429,504`).

- bf-migrate's DFU flasher already parses the G474's two-bank option-byte string (`BM/packages/core/src/dfu/flasher.ts:285-287`) and by default erases only the pages an image uses (`flasher.ts:330,535`).
- It has only been hardware-tested on F7 (`BM/docs/PLAN.md:38-40`; `BM/docs/SPEC.md:25`). G474 DFU through bf-migrate needs a hardware run.
- The notes flashed through CubeProgrammer's USB mode, not the Betaflight App. "Load Firmware [Local]" is Betaflight's documented route for boards outside the cloud build (hardware-policy line 39).

**SWD is still the recovery path.** If Betaflight does not boot (a bad image, an interrupted write), there is no BOOT0 button and the BOOT0 pin is ignored (`FT/NOTES.md:40,53`). Only SWD can recover the board. The app should therefore keep an SWD reflash mode for Level 0 boards.

---

## 4. Betaflight board-config conventions and "COMM"

The owner's "COMM" is correct.

- `Manufacturers.md` line 10: `|COMM|Community provided target definitions for closed source targets||`. Checked in `BFC/Manufacturers.md:10` and upstream `betaflight/config` master on 2026-11-12. `TMTR` is T-Motor (`BFC/Manufacturers.md:141`; upstream `:144`).
- Betaflight's docs list four reserved IDs for configs with no registered vendor: `CUST`, `FOSS`, `COMM`, `LEGA`. "The manufacturer ID is also what the Betaflight App uses to decide whether it may load a board configuration" (`betaflight/betaflight.com docs/development/manufacturer/creating-configuration.md:35-44`). "Submissions that have no registered vendor use one of the reserved IDs ... and need no new entry" (`requirements-for-submission-of-targets.md:7`).

Layout and rules:

- The path is `configs/<MANUFACTURER_ID>/<BOARD_NAME>/config.h`. Board names must be unique across the repository, and `BOARD_NAME` and `MANUFACTURER_ID` must match the directory names (`BFC/README.md:37-49`; `creating-configuration.md:21-24`).
- The required defines are `FC_TARGET_MCU`, `BOARD_NAME` and `MANUFACTURER_ID` (`BFC/README.md:43-49`).
- The `REFERENCE:` "supported" hash comes from the Betaflight team and cannot be self-generated (`BFC/README.md`, supported-target header section).
- PRs must come from a branch other than `master` (`requirements-for-submission-of-targets.md:13`).
- Cloud-build acceptance for submissions from 28 September 2026 needs: it builds, no motor timer or DMA conflicts, the gyro on SPI, nothing "not accepted for new designs", and a registered manufacturer (`hardware-policy.md:121-129`). "Motors M1 to M4 spread over more than one GPIO port" is not accepted (`hardware-policy.md:100`). This board breaks that rule, as the owner already notes (`FT/NOTES.md:564`).
- Community boards show as "Manufacturer supported" with the named maintainer as the support contact (`hardware-policy.md:50,67`; `FT/NOTES.md:568`).

Discrepancies the owner should settle:

- The repo's `config.h` still says `#define MANUFACTURER_ID TMTR` (`config.h:49`), and the frozen diff says `manufacturer_id TMTR` (`field-test.diff.txt:22`). NOTES says the *submitted* config uses `COMM` (`FT/NOTES.md:563`). Boards flashed before the switch report `TMTR`, so the app should detect by board name and accept both.
- Nothing is merged under `configs/COMM` upstream (the directory returns 404). PR #1174 (`configs/COMM/ATOMRCF405NAVI`) is open and unreviewed.
- The other precedent the owner cites, PR #1235, a pilot-written config for a closed-source Lumenier board, uses the vendor's ID (`configs/LMNR/LUXNDAAF7`), not `COMM`. Maintainers may ask for either.
- The local untracked draft `BF/src/config/configs/TMOTORG473/` is in the old flat layout and unusable (`FT/NOTES.md:287`). It must not be confused with the real config.

---

## 5. ST-Link V2 from a browser

### 5.1 USB identities

| Probe | VID:PID | Interfaces | Bulk endpoints (OUT / IN) | Source |
|---|---|---|---|---|
| ST-Link/V2 and clones | `0483:3748` | One vendor interface | `0x02` / `0x81` (trace `0x83`) | `OCD:66-68,79`; `WSL/src/lib/stlinkusb.js:19-25` |
| ST-Link/V2-1 (Nucleo, Discovery) | `0483:374B`, or `0483:3752` without MSD | Composite: debug MI_00, mass storage, VCP | `0x01` / `0x81` | `OCD:70-71,80-81`; `WSL/stlinkusb.js:26-32` |
| STLINK-V3 (E, SET, 2VCP, V3PWR) | `0483:374E`, `374F`, `3753`, `3754`, `3757` | Composite, high-speed USB | Same as V2-1; needs the V3 frequency API | `OCD:83-88,462` |

### 5.2 Commands needed

Each command is a 16-byte block on the OUT endpoint, with an optional data phase, then the reply on IN. Status `0x80` means OK and `0x81` FAULT; `0x10`, `0x11` and `0x14` are AP/DP wait and fault codes (`OCD:318-327`).

| Purpose | Bytes | Reply | Source |
|---|---|---|---|
| Firmware version | `F1` | 6 bytes: BE16 `v<<12 \| jtag<<6 \| swim`, then VID and PID little-endian. V2J39S7 gives `29 C7 83 04 48 37`. | `OCD:342,1263-1278` |
| Current mode | `F5` | 2 bytes (0 = DFU, 1 = mass storage, 2 = debug) | `OCD:346-351` |
| Leave probe DFU mode | `F3 07` | none | `OCD:344,356` |
| Target voltage | `F7` | 8 bytes, two ADC words. Informational only; do not gate on it. | `OCD:1480-1500` |
| SWD clock | `F2 43 <div>`, where div 7 is 480 kHz and div 1 is 1.8 MHz | 2 | `OCD:431`; map in `WSL/src/lib/stlinkv2.js:85-91` |
| Enter SWD | `F2 30 A3` | 2 | `OCD:407,414` |
| Read IDCODE | `F2 31` | 12 | `OCD:415,2037-2046` |
| Read memory, 32-bit | `F2 07 <addr32> <len16>` | len bytes | `OCD:395` |
| Write memory, 32-bit | `F2 08 <addr32> <len16>`, then data | none | `OCD:396` |
| Last read/write status | `F2 3E` | 12, with the fault address | `OCD:426,2469-2474` |
| Write debug register (single word) | `F2 35 <addr32> <val32>` | 2 | `OCD:419,2090-2096` |
| Read debug register | `F2 36 <addr32>` | 8 | `OCD:420,2069-2072` |
| Drive NRST (only if wired) | `F2 3C 00/01/02` | 2 | `OCD:424,452-454` |
| Leave debug | `F2 21` | none | `OCD:411` |

Firmware-version gates (`OCD:1344-1378`):

- J15: `GETLASTRWSTATUS2`
- J22: SWD frequency command
- J24: DAP register access
- J26: 16-bit memory access
- J28: init AP
- J32: banked registers and CSW

The owner's clone at V2J39 (`FT/NOTES.md:101`) passes all of them. On full-speed probes, 8-bit transfers are capped at 64 bytes, and 32-bit transfers are limited by the probe's 6144-byte buffer (`OCD:74,100-102`). webstlink caps at 1024 bytes (`WSL/stlinkv2.js:83`); use that on V2 until the hardware run measures more.

Cortex-M core control is memory writes to standard registers (**inferred**, standard ARMv7-M, and how OpenOCD's connect-under-reset works, `OCD:1802-1813`):

- `DHCSR` at `0xE000EDF0`: write `0xA05F0003` to halt; poll S_HALT (bit 17).
- `DEMCR` at `0xE000EDFC`: bit 0, VC_CORERESET, catches the reset vector.
- `AIRCR` at `0xE000ED0C`: write `0x05FA0004` for a system reset.

### 5.3 STM32G4 flash and option-byte recipe

Registers: the FLASH base is `0x40022000` (`stm32g474xx.h:1139,1160,1251`). Offsets (`stm32g474xx.h:459-479`):

| Register | Offset |
|---|---|
| KEYR | +0x08 |
| OPTKEYR | +0x0C |
| SR | +0x10 |
| CR | +0x14 |
| OPTR | +0x20 |
| PCROP1SR, PCROP1ER | +0x24, +0x28 |
| WRP1AR, WRP1BR | +0x2C, +0x30 |
| PCROP2SR, PCROP2ER | +0x44, +0x48 |
| WRP2AR, WRP2BR | +0x4C, +0x50 |
| SEC1R, SEC2R | +0x70, +0x74 |

Keys:

- KEYR: `0x45670123`, then `0xCDEF89AB`.
- OPTKEYR: `0x08192A3B`, then `0x4C5D6E7F` (`HAL/Inc/stm32g4xx_hal_flash.h:484-493`).

CR bits (`stm32g474xx.h:5158-5206`):

| Bit | Name |
|---|---|
| 0 | PG |
| 1 | PER |
| 2 | MER1 |
| 3-9 | PNB |
| 11 | BKER |
| 15 | MER2 |
| 16 | STRT |
| 17 | OPTSTRT |
| 18 | FSTPG |
| 27 | OBL_LAUNCH |
| 30 | OPTLOCK |
| 31 | LOCK |

SR: BSY is bit 16; the error flags are bits 1-9, 14 and 15 (`stm32g474xx.h:5120-5154`).

OPTR fields (`stm32g474xx.h:5237-5287`):

- RDP, bits 7:0: `0xAA` is Level 0, `0xCC` is Level 2, anything else is Level 1 (`HAL/Inc/stm32g4xx_hal_flash.h:254-256`).
- BFB2, bit 20.
- DBANK, bit 22. It is 1 in both observed values, so the flash is dual-bank with 2 KB pages and 128 pages per bank (`stm32g4xx_hal_flash.h:849-859`).
- nSWBOOT0, bit 26.
- nBOOT0, bit 27.

**Read identity:**

| Item | Address | Expected | Source |
|---|---|---|---|
| `DBGMCU_IDCODE` | `0xE0042000` | DEV_ID `0x469` | |
| Flash size | `0x1FFF75E0` | `0x0200` (512 KB) | |
| UID, 96 bits | `0x1FFF7590` | | |
| Package | `0x1FFF7500` | | `stm32g474xx.h:1327-1329`; `STL/.../G47x_G48x.chip:5-7` |

Whether the UID and flash-size words read at Level 1 with a debugger attached is to be confirmed on hardware.

**RDP regression (the one-way step):**

1. Unlock CR with KEYR, then OPTKEYR, and check that OPTLOCK reads 0.
2. Clear the SR error flags.
3. Write `OPTR = (old & ~0xFF) | 0xAA`.
4. Set OPTSTRT and poll BSY with a generous timeout.
5. Check OPTVERR and the other error flags.
6. Set OBL_LAUNCH. The chip resets and the debug session drops.
7. Re-enter SWD and confirm RDP reads `0xAA` and the flash reads `0xFF`.

Sources: `HAL/Src/stm32g4xx_hal_flash.c:537-555,581-584`, `STL/src/stlink-lib/option_bytes.c:541-567`. At Level 1 with a debugger connected, flash cannot be programmed or erased, but option bytes can still be changed (`HAL/Src/stm32g4xx_hal_flash_ex.c:650-653`). Whether PCROP areas are erased on regression depends on PCROP_RDP (`stm32g4xx_hal_flash.h:445-453`); the notes found PCROP inactive (`FT/NOTES.md:75`).

**Program at Level 0:**

1. Unlock CR.
2. For each page the image touches: `CR = PER | page<<3 | (bank2 ? BKER : 0)`, then set STRT and poll BSY. Mass erase is `MER1 | MER2`, then STRT.
3. Set PG. Write 64-bit double words, low word first, polling BSY.
4. Clear PG and set LOCK.
5. Verify by reading back.

stlink-org programs G4 this way, word by word with BSY polls (`STL/src/stlink-lib/flash_loader.c:734-743,884-918`). OpenOCD instead uses a RAM-resident algorithm.

### 5.4 Existing JS/TS implementations and licenses

| Project | License | Language | ST-Link | G4 flash | GPL-3.0-or-later compatible | Notes |
|---|---|---|---|---|---|---|
| devanlai/webstlink | MIT (`LICENSE`; ported from pystlink, MIT) | JS (ES modules) | V2, V2-1 | No: flash code for F0/F1/F3 and F2/F4/F7 only; "tested on STM32F103 only" (README:7-12) | Yes (keep the MIT notice) | Unmaintained since 2018-09. Best reference for WebUSB framing (`stlinkusb.js`, `stlinkv2.js`). |
| phryniszak/jstlink | GPL-3.0 (GitHub metadata) | JS | V2, V2-1, V3 | No (RTT and debug only) | Yes | Last push 2022-01. Ships Linux udev rules. |
| nopbxlr/swdart | MIT | Dart | V2 | No (F0/F1/F3, GD32, AT32, nRF) | Yes | Not usable from TS directly. |
| pavelrevak/pystlink | MIT | Python | V2, V2-1 | Partial | Yes | Origin of webstlink. |
| stlink-org/stlink | BSD-3-Clause | C | All | Yes (G4 chip file, OB and flash) | Yes | Best G4 register-sequence reference. |
| OpenOCD | GPL-2.0-or-later (`OCD:1`) | C | All | Yes (`stm32l4x` driver) | Yes ("or later") | Protocol reference. |
| pyOCD, probe-rs | Apache-2.0 (GitHub metadata) | Python, Rust | Yes | Yes | Yes (one-way) | Not browser-ready. |

License compatibility follows the FSF list, https://www.gnu.org/licenses/license-list.html.

**Design choice.** Write a small TypeScript ST-Link layer in `packages/core`, using webstlink's framing and OpenOCD/stlink-org as references. No runtime dependency is needed; the command subset is about 15 commands. If any webstlink code is ported verbatim, keep its MIT notice in the file header.

### 5.5 Chrome WebUSB on Windows

- **What Chrome accepts.** On Windows, Chrome opens a device only if its driver service is `winusb`, or if it is a `usbccgp` composite device whose function node uses WinUSB (`chromium services/device/usb/usb_service_win.cc:85-89,294,452-467`).
- **ST's driver is WinUSB.** STSW-LINK009's `STLinkDbgWinUSB` INF binds `USB\VID_0483&PID_3748` (and the 374A/B/E/F, 3752/3753 MI_00 functions) to the WinUSB service with ST's interface GUID `{DBCE1CD9-A320-4b51-A365-A0C3F3C5FB29}`. Checked on this machine: `C:\Windows\INF\oem159.inf:64-81,93,145`, DriverVer 06/08/2017 2.01, class `STLinkWinUSB`.
- So **ST's own driver should let Chrome open the probe with no Zadig step** (**inferred** from the two sources above; not yet tried in a browser).
- **Zadig (WinUSB) also satisfies Chrome**, but an ST community post reports that STM32CubeProgrammer then stops seeing the probe unless ST's interface GUID is re-added (https://community.st.com/stm32cubeide-mcus-28/here-is-a-fix-for-st-link-v2-on-windows-on-arm-167851).
- ST says installing STSW-LINK009 before plugging in a V2 or V2-1 is mandatory for enumeration, and that V3 needs no driver (https://www.st.com/en/development-tools/stsw-link009.html, and the ST community answers found in search).
- Only one program can hold a WinUSB device at a time: close STM32CubeProgrammer and IDEs first (**inferred**).
- WebUSB needs a secure context, and `requestDevice` only works from a user gesture (https://developer.chrome.com/docs/capabilities/usb). Linux needs a udev rule (same page; jstlink's `udev_rules/49-stlinkv2.rules`).
- ST's VID is not in Chrome's WebUSB blocklist (`chromium chrome/browser/usb/usb_blocklist.cc`, no `0x0483` entries).
- bf-migrate already targets Chrome and Edge with WebUSB (`BM/docs/SPEC.md:24`).

### 5.6 Clones versus V2-1 and V3

- **V2 clones** enumerate as genuine `0483:3748` and run ST's firmware, so the same driver, endpoints and commands apply. The owner's probe is one (`FT/NOTES.md:101`).
- **Their RST pin often does not reset an STM32.** ST forum answers describe it as wired for STM8 SWIM, not SWD NRST (search results from community.st.com, including "swd reset doesn't seem to work on st link"). The app must not depend on NRST. The notes leave RST unconnected anyway (`FT/NOTES.md:107`).
- **V2-1** is composite, uses different endpoints, and adds a VCP. Supporting it costs one table row.
- **V3** is high-speed and uses a different frequency API (`OCD:462`). webstlink does not support it; jstlink does. **Design choice:** MVP supports V2 and V2-1, with V3 later.

---

## 6. App design

### 6.1 Where it fits in bf-migrate

- `packages/core` stays platform-free and talks to hardware through interfaces (`BM/docs/SPEC.md:43`). The existing `UsbDeviceLike` has control transfers only (`BM/packages/core/src/dfu/usb-device.ts:57-69`), so Alpha Migrate adds a bulk-capable sibling.
- The Node harness already wraps `usb`'s `WebUSB` class (`BM/tools/hil/src/dfu-device.ts:1-8`), so the same core code can run in hardware tests.
- Demo mode follows `SimulatedFc` (`BM/packages/core/src/testing/simulated-fc.ts:37-41`; `BM/docs/SPEC.md:257`).
- The app is GPL-3.0-or-later (`BM/docs/SPEC.md:15`).

### 6.2 Module layout

```
packages/core/src/
  usb/bulk-device.ts            UsbBulkDeviceLike: open, claimInterface, transferIn, transferOut, close
  stlink/
    models.ts                   PID -> model, endpoints, max transfer, capabilities from the version
    frames.ts                   pure 16-byte command builders and reply parsers
    probe.ts                    StlinkProbe: one session, mutex, timeouts, mode exit, enterSwd, setFreq,
                                read32/write32/readBlock/writeBlock, debug registers, status mapping
    errors.ts                   NoTarget, ApFault, ProbeFirmwareTooOld, UsbLost, Timeout
  swd/
    memory-access.ts            MemoryAccess interface, so the flash code is probe-independent
    cortex-m.ts                 halt, resume, vector catch, system reset, waitHalted
  targets/stm32g4/
    registers.ts                constants, with header line citations in comments
    identify.ts                 DEV_ID, flash size, UID, package
    option-bytes.ts             decodeOptr(); planOptrChange() (pure, guarded); applyOptr(); regressRdp()
    flash.ts                    unlock/lock, erasePages, massErase, program, verify
  alpha/
    boards.ts                   board profiles: TMOTORG4ALPHAHD enabled, Analog listed but disabled
    images.ts                   firmware manifest, hex validation, page plan (which pages to erase)
    detect.ts                   classify from SWD readings and from MSP identity
    procedure.ts                state machine (pure reducer) plus an effects runner
    texts.ts                    every warning and confirmation text, each with an id and version
    journal.ts                  journal types (persisted by the app, keyed by chip UID)
  testing/
    simulated-g4.ts             G4 memory and FLASH-controller model
    simulated-stlink.ts         UsbBulkDeviceLike that speaks the ST-Link protocol over simulated-g4
    alpha-scenarios.ts          preset boards (see 6.8)
apps/web/src/
  transport/web-usb-stlink.ts   navigator.usb filters for the PIDs in 5.1
  stores/alpha-migrate.ts       Pinia store: runs the procedure; IndexedDB journal
  views/AlphaMigrateView.vue    stepper UI; components/alpha/*.vue for each step and dialog
  demo/alpha-profile.ts         wires the simulator into demo mode
tools/hil/src/
  stlink-device.ts, alpha-run.ts   the same core code over node-usb
```

Core interfaces (sketch):

```ts
interface UsbBulkDeviceLike {
  readonly vendorId: number; readonly productId: number;
  open(): Promise<void>; close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(ep: number, data: Uint8Array): Promise<{ status?: string; bytesWritten?: number }>;
  transferIn(ep: number, length: number): Promise<{ status?: string; data?: DataView }>;
}
interface MemoryAccess {
  read32(addr: number): Promise<number>;
  write32(addr: number, value: number): Promise<void>;
  readBlock(addr: number, length: number): Promise<Uint8Array>;
  writeBlock(addr: number, data: Uint8Array): Promise<void>;
}
type OptrPlan = { before: number; after: number; changes: ("rdp->L0" | "nSWBOOT0->0")[] };
```

Guards in `planOptrChange`:

- The result may differ from `before` only in RDP (to `0xAA`) and, if asked, in `nSWBOOT0` (to 0).
- RDP `0xCC` can never be produced. Level 2 is permanent (`stm32g4xx_hal_flash.h:255-256`).
- Unit tests pin these rules.

### 6.3 Detecting stock, migrated and in-between boards

**Over USB serial, no ST-Link (first choice, design choice).**

- bf-migrate's WebSerial filter already includes VID `0x0483` (`BM/apps/web/src/transport/web-serial.ts:7`), so a stock Alpha board can turn up in the normal Connect flow.
- If `readFcIdentity` (`BM/packages/core/src/fc/identity.ts:172`) returns variant `BTFL` and board `TMOTORG4ALPHAHD`, with manufacturer `TMTR` or `COMM`, the board is **migrated**. Offer a DFU flash of an Alpha image through the existing upgrade flow, with the image source of section 3 in place of the cloud build. No ST-Link is needed.
- If it reports `BTFL` and board `G474` (the generic build), check `resource show` for the Alpha HD signature (MOTOR 1 on A06, gyro CS on B12; `generic-build.cli.txt:12-27`). If it matches, treat it as **migrated (generic)**.
- If it enumerates as `0483:5740` but does not answer Betaflight identity, it is a **possible stock Alpha**: route to Alpha Migrate. Making this exact needs a capture of Alpha's MSP replies (open question 10).

**Over SWD (definitive):**

| Readings | Class | Next |
|---|---|---|
| Cannot reach the DP, even with the reset button held | `UNREACHABLE` | Check wiring. Level 2 would look the same, and Level 2 cannot be recovered. |
| DEV_ID is not `0x469`, or flash size is not 512 | `WRONG_CHIP` | Stop. Nothing changed. |
| WRP, PCROP, SEC1R/SEC2R or BOOT_LOCK active | `PROTECTED_UNTESTED` | Stop and ask for the report. The tested board had all of these inactive (`FT/NOTES.md:75`). |
| RDP is neither `0xAA` nor `0xCC` | `LOCKED_L1` (stock Alpha or a failed flash) | Full migration |
| RDP `0xAA`, `0x08000000` all `0xFF` | `BLANK_L0` (an interrupted migration) | Resume at the write step |
| RDP `0xAA`, valid vector table (SP inside `0x20000000-0x20020000`, odd reset vector in flash, `stm32_flash_g474.ld:19-26`), and `Betaflight`/`BTFL` strings in flash (`BF@2026.6.2/src/main/build/version.h:25-26`) | `BETAFLIGHT_L0` | Reflash. Prefer DFU if Betaflight boots; use SWD if it does not. Offer to keep the settings: the config header at `0x08004000` has magic `0xBE` (`BF@2026.6.2/src/main/config/config_eeprom.c:61,344`). |
| RDP `0xAA`, anything else | `UNKNOWN_L0` | Warn, then write |

`nSWBOOT0` is reported with every class. If it reads 1, offer to set it to 0 (see 6.5, C6b).

### 6.4 The state machine

Pure reducer: `(state, event) -> state + effects`. Effects run in the store. Every transition is written to the journal, which lives in IndexedDB keyed by chip UID, so a closed tab resumes at the right step.

```
Intro --ack--> Variant --HD--> Wiring --checked--> ChooseProbe --granted--> ProbeInfo
ProbeInfo --> Connect(hotplug) --ok--> Identify
Connect(hotplug) --NoTarget--> HoldReset(press) --user ready--> Connect(underReset) --ok--> Release --> Identify
Identify --> ReadOptions --> Classify
Classify:
  LOCKED_L1      --> SaveReport --> ChooseImage --> ConfirmUnlock(one-way, typed) --> Unlocking
                     --> Reconnect --> VerifyBlank --> ConfirmWrite --> Writing --> Verifying --> Reset --> Done
  BLANK_L0       --> ChooseImage --> ConfirmWrite --> Writing ...
  BETAFLIGHT_L0  --> ChooseImage --> ConfirmReflash(keep settings?) --> ErasePages --> Writing ...
  UNKNOWN_L0     --> ConfirmOverwrite --> ...
  WRONG_CHIP | PROTECTED_UNTESTED | UNREACHABLE --> Stopped (with report)
Any step: UsbLost/Timeout --> Paused(resumeAt) ; Cancel allowed before ConfirmUnlock and between steps after it
```

Rules:

- No effect that changes the chip runs unless the journal holds the matching confirmation, with text id, text version and time.
- **Unlocking cannot be cancelled once started.** The UI hides Cancel and says so.
- **Default SWD clock is 480 kHz**, the clock the tested run used (`FT/NOTES.md:111-117`). 1.8 MHz is optional for reads (`FT/tools/pin_loads.ps1:18`).
- **One SWD session for the whole run.** CubeProgrammer resumed the core on every connection (`FT/NOTES.md:231`); the app keeps the session open and resumes or resets explicitly at the end.
- **Hold-reset connect** (design choice, **inferred** to work):
  1. The user holds the reset button. It holds NRST low (`FT/NOTES.md:40`).
  2. The app enters SWD, sets DEMCR.VC_CORERESET and halts.
  3. The user releases the button. The core halts at the reset vector before Alpha can claim PA14.
  This replaces the clone's unreliable RST pin.

### 6.5 Confirmation points and their exact text

The texts live in `alpha/texts.ts` with ids, so the journal records which wording the user saw.

**C1, Intro (checkbox, "I understand").**
> **Alpha Migrate changes your flight controller for good.** It replaces the Alpha firmware on a T-Motor Pacer G4 Alpha HD with Betaflight. This is an unofficial community procedure. T-Motor, FETtec and Betaflight do not support it. One step erases the whole chip, and after it the board can never run Alpha again.
> You need: an ST-Link V2 (or V2-1), three wires soldered to the board, and Chrome or Edge.
> Before you start, write down any Alpha settings you want to keep (rates, output map, receiver protocol). They cannot be copied off the board.
> Only the HD version is supported. Analog is coming soon.

**C2, Wiring (one checkbox per line).**
> 1. Unplug the battery. Power the board from its USB-C only.
> 2. Unplug the receiver and the DJI cable. The ST-Link's clock wire uses the same pin as the receiver's SIG and the DJI SBUS wire.
> 3. Solder GND first. Then ST-Link SWCLK to the lower gold pad beside the USB-C socket, and SWDIO to the upper gold pad.
> 4. Leave the ST-Link's 3.3V and RST pins unconnected.

Sources: `FT/NOTES.md:36-37,107,149,320`. Line 2 is **inferred** for the stock board.

**C3, Choose the probe (button opens the browser chooser).**
> Click **Select ST-Link** and choose "STM32 STLink" in your browser's list. If the list is empty, the ST-Link driver is missing. See *Driver help*. Close STM32CubeProgrammer first; only one program can use the ST-Link at a time.

**C4, Confirm the chip (Yes / Stop).**
> Found an ST-Link {model}, firmware {V2J39S7}. It sees an STM32G47x (ID 0x469) with 512 KB of flash, unique ID {uid}. Read protection: {Level 1, as on a stock Alpha board}. Is this the board you want to convert?

**C4a, Hold reset (shown only after a hot-plug connect fails).**
> The board's running firmware is using the ST-Link's clock pin. Press and hold the button beside the USB-C socket, then click **Connect** while still holding it.

Then:

> Connected. Release the button now.

**C5, Save the report (required download).**
> Save this board report before going on. It holds everything that can be read from a locked Alpha board: its option bytes, protection settings and unique ID. The firmware itself can't be read, because read protection blocks it.

**C6, Choose the firmware (Use this firmware / Choose another).**
> Betaflight {2026.6.2} for TMOTORG4ALPHAHD, a community build with two fixes: steady battery voltage, and the ESC telemetry port. SHA-256 {…}. Source: {links}. This is not an official Betaflight cloud build.

**C6b, nSWBOOT0 is 1 (shown only then; recommended option preselected).**
> This board's BOOT0 pin is switched on. Under Betaflight, a DJI air unit on R3 can hold that pin high and make the board start in its bootloader instead of Betaflight. Switch it off in the same step (recommended).

Source: `FT/NOTES.md:127`.

**C7, The one-way step (typed confirmation: type ERASE).**
> **Erase the board and remove read protection**
> This step can't be undone.
> - The chip erases all of its flash: the Alpha firmware, your Alpha settings, and FETtec's bootloader.
> - FETtec's bootloader has never been published and can't be read off a locked chip, so no one can put it back. This board will never run Alpha or update from the Alpha configurator again.
> - Until the next step finishes, the board does nothing when plugged into USB. That is expected. The ST-Link can always finish the job.
> - Keep the USB cable and the ST-Link connected until the app says it's done.
> Type **ERASE** to continue.

Sources: `FT/NOTES.md:59-61,105`; the "does nothing" line is the inference in 1.3.

**C8, Write (button "Write Betaflight").**
> Write Betaflight to the board. The flash is empty, so nothing is lost. If this step is interrupted, open Alpha Migrate again. It will find the empty board and continue from here.

**C8-reflash, a Level 0 board (option "Keep my settings", on by default).**
> This board is already unlocked and holds {Betaflight 2026.6.2 | unknown firmware | nothing}. Only the parts of flash the new firmware uses are erased, so your saved settings are kept. Turn off "Keep my settings" for a full erase.

**C8-DFU, a migrated board found over USB.**
> This board already runs Betaflight ({TMOTORG4ALPHAHD}, {2026.6.2}). Flash {image} over USB? No ST-Link is needed, and your settings are kept.

**C9, Done.**
> Betaflight is on the board. Before you fly, unsolder or unplug the ST-Link wires: the clock wire shares a pin with the receiver plug and the DJI SBUS wire. Wire your receiver to T1/R1. The receiver plug can't carry CRSF under Betaflight. Then connect over USB to set the board up.

Sources: `FT/NOTES.md:152-158,162,320`.

**Stop texts:**
- `WRONG_CHIP`: "This isn't an STM32G47x, so it isn't a G4 Alpha. Nothing has been changed."
- `PROTECTED_UNTESTED`: "This board has protection settings the tested procedure has never seen. Nothing has been changed. Please send the saved report."
- `UNREACHABLE`: "The ST-Link can't reach the chip. Check the three wires and that the board has USB power. A permanently locked chip (Level 2) looks the same, and nothing can recover it."

### 6.6 How to write the image

- **A. SWD programming (recommended baseline).** This matches the tested CubeProgrammer `-w` path and needs no second USB chooser.
  - Start with double-word writes and BSY polls, as stlink-org does.
  - Then measure. The image is about 460 KB (estimate from section 3).
  - A small SRAM flash loader is the optimisation if timing is poor, as OpenOCD and pyOCD do.
- **B. SWD unlock, then a jump into the ROM bootloader, then bf-migrate's existing `DfuFlasher` (alternative to evaluate).**
  - How: after the unlock, halt, enable the SYSCFG clock, remap system memory, load MSP and PC from `0x1FFF0000/4`, and resume. This mirrors `systemJumpToBootloader` (`system_stm32g4xx.c:113-138`).
  - Pros: it reuses a tested flasher with page-erase and verify, and ROM DFU is proven on this board (`FT/NOTES.md:125,376`).
  - Cons: a second browser chooser. A jump from the debugger has not been tried (**inferred**). The G474 DFU path in bf-migrate is untested on hardware.

### 6.7 Checking an image (for both hosted and user files)

- It parses as Intel hex, and every byte lies in `0x08000000-0x0807FFFF`.
- It never touches option bytes or OTP (`0x1FFF7000`, `0x1FFF7800`, `0x1FFFF800`; `STL/.../G47x_G48x.chip:12`).
- It has a valid vector table at `0x08000000`.
- It contains `Betaflight` and `BTFL` (`version.h:25-26`).
- It names a board: `TMOTORG4ALPHAHD` passes. Generic `G474` gets a "you will need the pin script" warning. Any other board gets a hard warning ("wrong pins").
- **Refuse images that start at `0x08003800`.** Those are Alpha images, and they need FETtec's bootloader, which is gone (`FT/NOTES.md:85,92`).
- Hosted images must also match the pinned sha256.

### 6.8 Simulated ST-Link for demo and tests

**`SimulatedG4`**, a stateful model:

- 512 KB of flash in two banks of 2 KB pages; option registers; DBGMCU, UID and flash-size words.
- A FLASH controller that:
  - honours the key sequences, and sets PGSERR or PGAERR on misuse;
  - sets BSY for configurable times;
  - blocks flash reads and writes at Level 1 while a debugger is attached (AP fault);
  - mass-erases on RDP regression;
  - drops the session on OBL_LAUNCH.
- A "PA14 claimed" flag that makes hot-plug connect fail until a simulated reset-button hold.

**`SimulatedStlink`** implements `UsbBulkDeviceLike`. It parses the same 16-byte frames as the real probe and answers byte-for-byte:

- version `29 C7 83 04 48 37` (V2J39S7);
- modes and status codes as in 5.2;
- latency scaled for the demo.

**Scenarios (`alpha-scenarios.ts`):**

| Scenario | OPTR | Flash | Behaviour | Basis |
|---|---|---|---|---|
| `stockAlpha073` | `0xFBEFF801` | Pseudo-random image from `0x08003800`; bootloader region filled | PA14 claimed; needs hold-reset | **inferred** from `FT/NOTES.md:48-53,141` |
| `brickedPartialFlash` | `0xFBEFF800` | Unreadable (Level 1) | Hot-plug works | **observed**, `FT/NOTES.md:67` |
| `migratedBetaflight` | `0xFBEFF8AA` | A real Betaflight G474 hex, plus a config header `0xBE` at `0x08004000` | | **observed**, `FT/NOTES.md:127` |
| `blankAfterErase` | `0xFBEFF8AA` | All `0xFF` | | **observed** state after step 2, `FT/NOTES.md:122` |
| `oldAlphaSwBoot` | `0xFFEFF800` (nSWBOOT0 = 1) | | | **inferred**, `FT/NOTES.md:55` |
| `level2` | | | Every DP access fails | |
| `wrongChip` | | | DEV_ID `0x413` (an F405) | |
| `wiringFault` | | | DP never answers | |
| Fault injection | | | USB lost after N frames, BSY timeout, verify mismatch | |

Fidelity:

- Model mode is the default for the demo and unit tests.
- **Trace mode** replays a recorded list of OUT/IN frames with timing and fails on any divergence. Use it for regression tests once real captures exist.
- Capturing traces needs hardware and is out of scope here (see 6.9).
- The demo shows a persistent **SIMULATED** banner, and its reports are watermarked.

### 6.9 Test plan

- **Unit tests:** frame encode and decode against the byte examples in 5.2; the OPTR planner guards; image validation; reducer transitions, including resume from every step.
- **Simulator integration:** the full run for every scenario, with fault injection at every effect.
- **Hardware, run by the owner later.** Read-only first:
  - On the **good** board, run only Identify and ReadOptions. These give real stock values, a trace, and Alpha's behaviour on PA14.
  - Use the **bad** board, already on Betaflight, as a repeatable fixture:
    1. Set RDP to `0xBB`. Level 1 is reversible.
    2. Optionally enable UART2 on PA14, to mimic Alpha claiming SWCLK.
    3. Run the full migration, then verify.
  - Never Level 2.
  - Browsers: Chrome on Windows with ST's driver, Chrome with Zadig WinUSB, Edge, and Linux with udev.
  - DFU: a G474 run through `DfuFlasher` and `tools/hil`.

---

## 7. Open questions and risks for the owner

1. **The stock-board path is untested.** Only a bricked board has been migrated (`FT/NOTES.md:3,545`). Alpha's USART2 on PA14 will probably defeat hot-plug SWD (**inferred**, 1.4).
   - Decide: rely on the hold-reset flow, or ask users to wire NRST, given that clone RST pins are unreliable.
   - Do the read-only test on the good board before building the UI around either answer.
2. **FETtec's bootloader.** Code running from flash can still read it (`FT/NOTES.md:61`), so an image sent through FETtec's own bootloader could in principle dump it before the erase. Is preserving it worth a research step, since FETtec is gone? Not in the MVP.
3. **The image pipeline.** Who builds and hosts the hex (CI in `fix-thobby-g4-alpha` or in bf-migrate)? How it is versioned and pinned. How the GPL source offer is presented (hardware-policy line 39). Who rebuilds for 2026.12 and later releases. When to switch to the cloud build if upstream accepts the config.
4. **Manufacturer ID.** Switch `config.h:49` and the app's expectations to `COMM` now? Boards flashed earlier report `TMTR`. PR #1235 used the vendor ID (`LMNR`) for a pilot-written board, so maintainers might ask for `TMTR`. The board name `TMOTORG4ALPHAHD` does not collide upstream today (code search: 0 hits).
5. **Analog.** Gate it as "coming soon" until the board arrives and is mapped (`FT/NOTES.md:546-549`). It needs its own board name, an OSD chip answer, SWD pad locations, and a way for the user to identify the variant (photos in the UI).
6. **Write strategy.** A (SWD) or B (ROM-DFU jump) from 6.6. Measure write time on hardware before choosing.
7. **`nSWBOOT0 = 1` boards.** Fix it silently, fix it by default with an opt-out (as proposed in C6b), or leave it?
8. **Driver UX on Windows.**
   - ST's driver should work with Chrome but needs an ST download.
   - Zadig is quicker but may break CubeProgrammer.
   - Which does the guide recommend?
   - Verify in a browser before writing the help text.
9. **Probe support.** V2 and V2-1 only in the MVP, or V3 too?
10. **Alpha's serial identity.** Capture what a stock board answers to Betaflight MSP identity requests, so detection over USB can route stock boards to Alpha Migrate reliably.
11. **Post-migration setup.**
    - Should the app offer a starter CLI snippet: receiver on T1/R1 CRSF, `feature OSD`, and the motor reorder hint? The OSD shows as `NONE` until `feature OSD` is enabled (`FT/NOTES.md:376`).
    - Should it explain the DShot300 and 4 kHz lock with bidirectional DShot (`FT/NOTES.md:401`)?
    - The owner's `field-test.diff.txt` is a personal tune and should not ship as defaults.
12. **Liability and wording.** The texts in 6.5 promise nothing about flight safety. Decide whether a disclaimer and a "not affiliated" notice are needed beyond the app's existing "Unofficial" label.
13. **Privacy.** The report and the journal hold the chip UID. Keep them local and never upload them. bf-migrate's plan already flags chip IDs in fixtures (`BM/docs/PLAN.md:17`).
14. **Level 2 must stay unreachable.** No code path may compose `0xCC`. Use a unit test and a lint rule on the constant.
