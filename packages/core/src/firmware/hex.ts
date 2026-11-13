/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

/** One contiguous run of firmware bytes. */
export interface HexBlock {
  address: number;
  bytes: Uint8Array;
}

/** A parsed Intel HEX file, with blocks in file order. */
export interface HexImage {
  data: HexBlock[];
  bytesTotal: number;
}

export class HexParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Invalid HEX file at line ${line}: ${message}`);
    this.name = "HexParseError";
  }
}

const RECORD_DATA = 0x00;
const RECORD_END_OF_FILE = 0x01;
const RECORD_EXTENDED_SEGMENT = 0x02;
const RECORD_START_SEGMENT = 0x03;
const RECORD_EXTENDED_LINEAR = 0x04;
const RECORD_START_LINEAR = 0x05;

/** Byte count, two address bytes, record type and checksum. */
const RECORD_OVERHEAD = 5;
const RECORD_LINE = /^:(?:[0-9a-fA-F]{2})+$/;

interface HexRecord {
  type: number;
  offset: number;
  payload: Uint8Array;
}

interface OpenBlock {
  address: number;
  length: number;
  chunks: Uint8Array[];
}

function parseRecord(line: string, lineNumber: number): HexRecord {
  if (!RECORD_LINE.test(line)) throw new HexParseError("not a HEX record", lineNumber);

  const raw = new Uint8Array((line.length - 1) / 2);
  for (let i = 0; i < raw.length; i++) raw[i] = Number.parseInt(line.slice(1 + i * 2, 3 + i * 2), 16);

  if (raw.length < RECORD_OVERHEAD || raw.length !== raw[0]! + RECORD_OVERHEAD) {
    throw new HexParseError("record length does not match its byte count", lineNumber);
  }
  if (raw.reduce((sum, byte) => sum + byte, 0) & 0xff) throw new HexParseError("checksum mismatch", lineNumber);

  return {
    type: raw[3]!,
    offset: (raw[1]! << 8) | raw[2]!,
    payload: raw.subarray(4, raw.length - 1),
  };
}

function expectPayload(record: HexRecord, length: number, lineNumber: number): void {
  if (record.payload.length !== length) {
    throw new HexParseError(`record type ${record.type} must carry ${length} bytes`, lineNumber);
  }
}

function closeBlock(block: OpenBlock): HexBlock {
  const bytes = new Uint8Array(block.length);
  let offset = 0;
  for (const chunk of block.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { address: block.address, bytes };
}

/**
 * Parses an Intel HEX file. Every record's checksum is validated and any malformed
 * line, or a missing end-of-file record, rejects the whole file: a firmware image
 * that is only partly understood must never reach the flasher.
 */
export function parseIntelHex(text: string): HexImage {
  const data: HexBlock[] = [];
  const lines = text.split(/\r?\n|\r/);
  let bytesTotal = 0;
  let upperAddress = 0;
  let ended = false;
  let open: OpenBlock | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const lineNumber = index + 1;
    if (line === "") continue;
    if (ended) throw new HexParseError("data after the end-of-file record", lineNumber);

    const record = parseRecord(line, lineNumber);
    switch (record.type) {
      case RECORD_DATA: {
        if (record.payload.length === 0) break;
        const address = upperAddress + record.offset;
        if (open && open.address + open.length === address) {
          open.chunks.push(record.payload);
          open.length += record.payload.length;
        } else {
          if (open) data.push(closeBlock(open));
          open = { address, length: record.payload.length, chunks: [record.payload] };
        }
        bytesTotal += record.payload.length;
        break;
      }
      case RECORD_END_OF_FILE:
        expectPayload(record, 0, lineNumber);
        ended = true;
        break;
      case RECORD_EXTENDED_SEGMENT:
        expectPayload(record, 2, lineNumber);
        // Segment addressing would place data somewhere other than where this parser
        // computes, so a non-zero segment cannot be flashed correctly.
        if (record.payload[0]! !== 0 || record.payload[1]! !== 0) {
          throw new HexParseError("extended segment addressing is not supported", lineNumber);
        }
        break;
      case RECORD_START_SEGMENT:
        expectPayload(record, 4, lineNumber);
        break;
      case RECORD_EXTENDED_LINEAR:
        expectPayload(record, 2, lineNumber);
        upperAddress = ((record.payload[0]! << 24) | (record.payload[1]! << 16)) >>> 0;
        break;
      case RECORD_START_LINEAR:
        expectPayload(record, 4, lineNumber);
        break;
      default:
        throw new HexParseError(`unknown record type ${record.type}`, lineNumber);
    }
  }

  if (!ended) throw new HexParseError("missing end-of-file record", lines.length);
  if (open) data.push(closeBlock(open));
  return { data, bytesTotal };
}
