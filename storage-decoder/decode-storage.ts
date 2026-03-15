/**
 * Solidity Storage Slot Decoder
 *
 * Decodes raw storage slot values into human-readable form using:
 * - Storage layout JSON (from solc or Hardhat)
 * - ABI JSON (for enum names and struct context)
 * - Raw slot hex values
 *
 * Supports: packed variables, structs, nested structs, mappings, arrays,
 * strings, bytes, enums, signed integers, and state diff formatting.
 *
 * Usage:
 *   import { StorageDecoder } from './decode-storage';
 *   const decoder = new StorageDecoder(storageLayoutJson, abiJson, enumDefs);
 *   const result = decoder.decodeSlot(slotNumber, rawHexValue);
 *   const diff = decoder.decodeStateDiff(stateDiff);
 */

import { keccak256, AbiCoder, zeroPadValue, toBeHex, hexlify, getBytes } from "ethers";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single entry from the `storage` array in the storage layout JSON */
export interface StorageEntry {
  label: string;
  offset: number;
  slot: string;
  type: string;
  contract?: string;
}

/** A type descriptor from the `types` object in the storage layout JSON */
export interface TypeDescriptor {
  encoding: "inplace" | "mapping" | "dynamic_array" | "bytes";
  label: string;
  numberOfBytes: string;
  // For structs:
  members?: StorageEntry[];
  // For mappings:
  key?: string;
  value?: string;
  // For arrays:
  base?: string;
}

/** The full storage layout JSON structure */
export interface StorageLayout {
  storage: StorageEntry[];
  types: Record<string, TypeDescriptor>;
}

/** Enum definitions: maps enum type labels to their variant names */
export type EnumDefinitions = Record<string, string[]>;

/** A decoded variable value */
export interface DecodedValue {
  /** Variable name / path (e.g., "orders[42].maker") */
  label: string;
  /** Solidity type (e.g., "address", "uint128") */
  type: string;
  /** Decoded value as a display string */
  value: string;
  /** Raw hex bytes for this field */
  rawHex: string;
  /** Absolute slot number */
  slot: string;
  /** Byte offset within the slot */
  offset: number;
  /** Size in bytes */
  size: number;
}

/** A state diff for a single slot */
export interface SlotDiff {
  slot: string;
  from: string; // raw hex
  to: string; // raw hex
}

/** A decoded state diff entry */
export interface DecodedDiffEntry {
  label: string;
  type: string;
  slot: string;
  offset: number;
  fromValue: string;
  toValue: string;
  fromRawHex: string;
  toRawHex: string;
  changed: boolean;
}

// ─── Core Decoder ────────────────────────────────────────────────────────────

export class StorageDecoder {
  private layout: StorageLayout;
  private abi: any[];
  private enums: EnumDefinitions;
  private coder = AbiCoder.defaultAbiCoder();

  constructor(
    storageLayout: StorageLayout,
    abi: any[] = [],
    enumDefinitions: EnumDefinitions = {}
  ) {
    this.layout = storageLayout;
    this.abi = abi;
    this.enums = enumDefinitions;
  }

  // ─── Slot Computation ──────────────────────────────────────────────────

  /**
   * Compute the storage slot for a mapping value.
   *
   * mapping(K => V) at slot p:
   *   slot_of_value = keccak256(abi.encode(key, p))
   *
   * Key encoding depends on the key type:
   *   - address: abi.encode(address, uint256) = left-pad address to 32B + slot as 32B
   *   - uint256: abi.encode(uint256, uint256) = key as 32B + slot as 32B
   *   - bytes32: abi.encode(bytes32, uint256) = key as 32B + slot as 32B
   *   - string:  abi.encode(keccak256(string), uint256) [for string keys, hash first]
   */
  static computeMappingSlot(
    mappingSlot: bigint,
    key: string | bigint,
    keyType: string = "t_uint256"
  ): bigint {
    const coder = AbiCoder.defaultAbiCoder();
    let encoded: string;

    if (keyType === "t_address" || keyType.includes("address")) {
      // address keys: pad to 32 bytes, then concat with slot (32 bytes)
      encoded = coder.encode(["address", "uint256"], [key, mappingSlot]);
    } else if (keyType.includes("bytes32")) {
      encoded = coder.encode(["bytes32", "uint256"], [key, mappingSlot]);
    } else if (keyType.includes("string")) {
      // string keys: hash the string first
      const keyHash = keccak256(
        coder.encode(["string"], [key as string])
      );
      encoded = coder.encode(["bytes32", "uint256"], [keyHash, mappingSlot]);
    } else {
      // uint or int keys
      encoded = coder.encode(["uint256", "uint256"], [key, mappingSlot]);
    }

    return BigInt(keccak256(encoded));
  }

  /**
   * Compute the storage slot for a nested mapping value.
   *
   * mapping(K1 => mapping(K2 => V)) at slot p:
   *   inner_slot = keccak256(abi.encode(key1, p))
   *   value_slot = keccak256(abi.encode(key2, inner_slot))
   */
  static computeNestedMappingSlot(
    mappingSlot: bigint,
    key1: string | bigint,
    key1Type: string,
    key2: string | bigint,
    key2Type: string
  ): bigint {
    const innerSlot = StorageDecoder.computeMappingSlot(
      mappingSlot,
      key1,
      key1Type
    );
    return StorageDecoder.computeMappingSlot(innerSlot, key2, key2Type);
  }

  /**
   * Compute the storage slot for a dynamic array element.
   *
   * T[] at slot p:
   *   length is stored at slot p
   *   element i starts at: keccak256(abi.encode(p)) + i * ceil(elementBytes / 32)
   *
   * For packed arrays (element < 32 bytes):
   *   element i is at: keccak256(abi.encode(p)) + floor(i * elementBytes / 32)
   *   with byte offset: (i * elementBytes) % 32
   */
  static computeDynamicArrayElementSlot(
    arraySlot: bigint,
    index: bigint,
    elementBytes: number
  ): { slot: bigint; offset: number } {
    const coder = AbiCoder.defaultAbiCoder();
    const baseDataSlot = BigInt(
      keccak256(coder.encode(["uint256"], [arraySlot]))
    );

    if (elementBytes >= 32) {
      // Each element takes ceil(elementBytes/32) slots
      const slotsPerElement = BigInt(Math.ceil(elementBytes / 32));
      return {
        slot: baseDataSlot + index * slotsPerElement,
        offset: 0,
      };
    } else {
      // Packed: multiple elements per slot
      const totalByteOffset = index * BigInt(elementBytes);
      const slotOffset = totalByteOffset / 32n;
      const byteOffset = Number(totalByteOffset % 32n);
      return {
        slot: baseDataSlot + slotOffset,
        offset: byteOffset,
      };
    }
  }

  /**
   * Compute the storage slot for a fixed-size array element.
   *
   * T[N] at slot p:
   *   element i starts at: p + i * ceil(elementBytes / 32)
   *   (for packed elements: p + floor(i * elementBytes / 32), offset = (i * elementBytes) % 32)
   */
  static computeFixedArrayElementSlot(
    arrayBaseSlot: bigint,
    index: bigint,
    elementBytes: number
  ): { slot: bigint; offset: number } {
    if (elementBytes >= 32) {
      const slotsPerElement = BigInt(Math.ceil(elementBytes / 32));
      return {
        slot: arrayBaseSlot + index * slotsPerElement,
        offset: 0,
      };
    } else {
      const totalByteOffset = index * BigInt(elementBytes);
      const slotOffset = totalByteOffset / 32n;
      const byteOffset = Number(totalByteOffset % 32n);
      return {
        slot: arrayBaseSlot + slotOffset,
        offset: byteOffset,
      };
    }
  }

  // ─── Bit-Level Extraction ──────────────────────────────────────────────

  /**
   * Extract a value from a raw 32-byte slot hex value.
   *
   * Solidity stores packed variables lower-order aligned:
   *   - offset 0 = rightmost bytes of the hex string
   *   - higher offset = further left
   *
   * Formula: value = (slotValue >> (offsetBytes * 8)) & ((1 << (sizeBytes * 8)) - 1)
   */
  static extractFromSlot(
    slotHex: string,
    offsetBytes: number,
    sizeBytes: number
  ): bigint {
    const slotValue = BigInt(slotHex);
    const shift = BigInt(offsetBytes) * 8n;
    const mask = (1n << (BigInt(sizeBytes) * 8n)) - 1n;
    return (slotValue >> shift) & mask;
  }

  /**
   * Extract raw hex bytes from a slot (useful for bytes32, bytesN, raw data).
   */
  static extractRawHex(
    slotHex: string,
    offsetBytes: number,
    sizeBytes: number
  ): string {
    const raw = StorageDecoder.extractFromSlot(slotHex, offsetBytes, sizeBytes);
    return "0x" + raw.toString(16).padStart(sizeBytes * 2, "0");
  }

  // ─── Type Decoding ─────────────────────────────────────────────────────

  /**
   * Decode a raw BigInt value based on its Solidity type.
   * Returns a human-readable string representation.
   */
  decodeTypedValue(rawValue: bigint, typeKey: string): string {
    const typeInfo = this.layout.types[typeKey];
    if (!typeInfo) {
      return "0x" + rawValue.toString(16);
    }

    const label = typeInfo.label;
    const sizeBytes = parseInt(typeInfo.numberOfBytes);

    // Address
    if (label === "address") {
      return "0x" + rawValue.toString(16).padStart(40, "0");
    }

    // Bool
    if (label === "bool") {
      return rawValue !== 0n ? "true" : "false";
    }

    // Unsigned integers
    if (label.startsWith("uint")) {
      return rawValue.toString();
    }

    // Signed integers (two's complement)
    if (label.startsWith("int")) {
      const bits = BigInt(sizeBytes) * 8n;
      const signBit = 1n << (bits - 1n);
      if (rawValue >= signBit) {
        return (rawValue - (1n << bits)).toString();
      }
      return rawValue.toString();
    }

    // bytes1..bytes32
    if (label.match(/^bytes\d+$/)) {
      return "0x" + rawValue.toString(16).padStart(sizeBytes * 2, "0");
    }

    // Enums
    if (label.startsWith("enum")) {
      const enumIndex = Number(rawValue);
      // Try to find enum variant name from definitions
      for (const [enumName, variants] of Object.entries(this.enums)) {
        if (label.includes(enumName) && enumIndex < variants.length) {
          return `${variants[enumIndex]} (${enumIndex})`;
        }
      }
      return enumIndex.toString();
    }

    // Contract types (stored as address)
    if (typeInfo.encoding === "inplace" && sizeBytes === 20) {
      return "0x" + rawValue.toString(16).padStart(40, "0");
    }

    // Fallback
    return "0x" + rawValue.toString(16);
  }

  // ─── String/Bytes Decoding ────────────────────────────────────────────

  /**
   * Decode a Solidity string or bytes from storage.
   *
   * Short strings (≤ 31 bytes):
   *   The slot contains the string data (left-aligned) with the lowest byte = length * 2.
   *   Detection: (slotValue & 1) === 0
   *
   * Long strings (≥ 32 bytes):
   *   The slot contains length * 2 + 1.
   *   Data starts at keccak256(slot) and spans ceil(length / 32) consecutive slots.
   *   Detection: (slotValue & 1) === 1
   *
   * @param slotHex The raw hex value of the string's base slot
   * @param baseSlot The slot number (needed to compute data slot for long strings)
   * @param getSlotValue Function to fetch additional slot values (for long strings)
   * @param isString true for string, false for bytes
   */
  static decodeStringOrBytes(
    slotHex: string,
    baseSlot: bigint,
    getSlotValue: (slot: bigint) => string | undefined,
    isString: boolean = true
  ): string {
    const slotValue = BigInt(slotHex);

    if ((slotValue & 1n) === 0n) {
      // Short string: data in same slot, lowest byte = length * 2
      const length = Number(slotValue & 0xffn) / 2;
      if (length === 0) return isString ? '""' : "0x";

      // Extract the data bytes (they're in the high bytes of the slot)
      const slotBytes = slotHex.replace("0x", "").padStart(64, "0");
      const dataHex = slotBytes.slice(0, length * 2);

      if (isString) {
        return '"' + hexToUtf8(dataHex) + '"';
      }
      return "0x" + dataHex;
    } else {
      // Long string: length = (slotValue - 1) / 2, data at keccak256(slot)
      const length = Number((slotValue - 1n) / 2n);
      const coder = AbiCoder.defaultAbiCoder();
      const dataBaseSlot = BigInt(
        keccak256(coder.encode(["uint256"], [baseSlot]))
      );

      let dataHex = "";
      const numSlots = Math.ceil(length / 32);
      for (let i = 0; i < numSlots; i++) {
        const dataSlotValue = getSlotValue(dataBaseSlot + BigInt(i));
        if (dataSlotValue) {
          dataHex += dataSlotValue.replace("0x", "").padStart(64, "0");
        } else {
          dataHex += "0".repeat(64);
        }
      }

      // Trim to actual length
      dataHex = dataHex.slice(0, length * 2);

      if (isString) {
        return '"' + hexToUtf8(dataHex) + '"';
      }
      return "0x" + dataHex;
    }
  }

  // ─── Main Decoding Methods ─────────────────────────────────────────────

  /**
   * Find all storage entries that occupy a given slot.
   * Returns entries that are packed into this specific slot.
   */
  findEntriesInSlot(slotNumber: bigint): StorageEntry[] {
    return this.layout.storage.filter((entry) => {
      const baseSlot = BigInt(entry.slot);
      const typeInfo = this.layout.types[entry.type];
      if (!typeInfo) return false;
      const numSlots = Math.max(
        1,
        Math.ceil(parseInt(typeInfo.numberOfBytes) / 32)
      );
      return (
        slotNumber >= baseSlot && slotNumber < baseSlot + BigInt(numSlots)
      );
    });
  }

  /**
   * Decode all variables packed into a single storage slot.
   *
   * @param slotNumber The slot number to decode
   * @param slotHex The raw 32-byte hex value (e.g., "0x000...001")
   * @param getSlotValue Optional function to fetch additional slots (for strings/bytes)
   * @returns Array of decoded values for all variables in this slot
   */
  decodeSlot(
    slotNumber: bigint,
    slotHex: string,
    getSlotValue?: (slot: bigint) => string | undefined
  ): DecodedValue[] {
    const results: DecodedValue[] = [];
    const entries = this.findEntriesInSlot(slotNumber);

    for (const entry of entries) {
      const typeInfo = this.layout.types[entry.type];
      if (!typeInfo) continue;

      const entryBaseSlot = BigInt(entry.slot);
      const relativeSlot = slotNumber - entryBaseSlot;

      if (typeInfo.encoding === "inplace") {
        if (typeInfo.members) {
          // Struct: decode members that fall in this slot
          this.decodeStructMembers(
            typeInfo,
            entry.type,
            entryBaseSlot,
            slotNumber,
            slotHex,
            entry.label,
            results,
            getSlotValue
          );
        } else if (typeInfo.base) {
          // Fixed-size array: decode elements in this slot
          this.decodeFixedArrayInSlot(
            typeInfo,
            entryBaseSlot,
            slotNumber,
            slotHex,
            entry.label,
            results,
            getSlotValue
          );
        } else {
          // Simple type packed in this slot
          if (relativeSlot === 0n) {
            const sizeBytes = parseInt(typeInfo.numberOfBytes);
            const raw = StorageDecoder.extractFromSlot(
              slotHex,
              entry.offset,
              sizeBytes
            );
            const rawHex = StorageDecoder.extractRawHex(
              slotHex,
              entry.offset,
              sizeBytes
            );
            results.push({
              label: entry.label,
              type: typeInfo.label,
              value: this.decodeTypedValue(raw, entry.type),
              rawHex,
              slot: slotNumber.toString(),
              offset: entry.offset,
              size: sizeBytes,
            });
          }
        }
      } else if (typeInfo.encoding === "bytes") {
        // string or bytes
        if (relativeSlot === 0n) {
          const isString = typeInfo.label === "string";
          const decoded = StorageDecoder.decodeStringOrBytes(
            slotHex,
            entryBaseSlot,
            getSlotValue || (() => undefined),
            isString
          );
          results.push({
            label: entry.label,
            type: typeInfo.label,
            value: decoded,
            rawHex: slotHex,
            slot: slotNumber.toString(),
            offset: 0,
            size: 32,
          });
        }
      } else if (typeInfo.encoding === "mapping") {
        // Mapping base slot - just note it exists
        if (relativeSlot === 0n) {
          results.push({
            label: entry.label,
            type: typeInfo.label,
            value: "(mapping - slot is empty; values at derived slots)",
            rawHex: slotHex,
            slot: slotNumber.toString(),
            offset: 0,
            size: 32,
          });
        }
      } else if (typeInfo.encoding === "dynamic_array") {
        // Dynamic array base slot stores length
        if (relativeSlot === 0n) {
          const length = BigInt(slotHex);
          results.push({
            label: entry.label + ".length",
            type: "uint256",
            value: length.toString(),
            rawHex: slotHex,
            slot: slotNumber.toString(),
            offset: 0,
            size: 32,
          });
        }
      }
    }

    return results;
  }

  /**
   * Decode struct members that fall within a specific slot.
   */
  private decodeStructMembers(
    typeInfo: TypeDescriptor,
    typeKey: string,
    structBaseSlot: bigint,
    targetSlot: bigint,
    slotHex: string,
    parentLabel: string,
    results: DecodedValue[],
    getSlotValue?: (slot: bigint) => string | undefined
  ): void {
    if (!typeInfo.members) return;

    const relativeSlot = targetSlot - structBaseSlot;

    for (const member of typeInfo.members) {
      const memberRelSlot = BigInt(member.slot);

      if (memberRelSlot !== relativeSlot) continue;

      const memberType = this.layout.types[member.type];
      if (!memberType) continue;

      const fullLabel = `${parentLabel}.${member.label}`;

      if (memberType.encoding === "inplace" && memberType.members) {
        // Nested struct
        const nestedBaseSlot = structBaseSlot + memberRelSlot;
        this.decodeStructMembers(
          memberType,
          member.type,
          nestedBaseSlot,
          targetSlot,
          slotHex,
          fullLabel,
          results,
          getSlotValue
        );
      } else if (memberType.encoding === "bytes") {
        // String/bytes member within struct
        const isString = memberType.label === "string";
        const decoded = StorageDecoder.decodeStringOrBytes(
          slotHex,
          targetSlot,
          getSlotValue || (() => undefined),
          isString
        );
        results.push({
          label: fullLabel,
          type: memberType.label,
          value: decoded,
          rawHex: slotHex,
          slot: targetSlot.toString(),
          offset: member.offset,
          size: 32,
        });
      } else if (memberType.encoding === "inplace") {
        // Simple type
        const sizeBytes = parseInt(memberType.numberOfBytes);
        const raw = StorageDecoder.extractFromSlot(
          slotHex,
          member.offset,
          sizeBytes
        );
        const rawHex = StorageDecoder.extractRawHex(
          slotHex,
          member.offset,
          sizeBytes
        );
        results.push({
          label: fullLabel,
          type: memberType.label,
          value: this.decodeTypedValue(raw, member.type),
          rawHex,
          slot: targetSlot.toString(),
          offset: member.offset,
          size: sizeBytes,
        });
      }
    }
  }

  /**
   * Decode fixed-size array elements within a specific slot.
   */
  private decodeFixedArrayInSlot(
    typeInfo: TypeDescriptor,
    arrayBaseSlot: bigint,
    targetSlot: bigint,
    slotHex: string,
    parentLabel: string,
    results: DecodedValue[],
    getSlotValue?: (slot: bigint) => string | undefined
  ): void {
    if (!typeInfo.base) return;

    const elementType = this.layout.types[typeInfo.base];
    if (!elementType) return;

    const elementBytes = parseInt(elementType.numberOfBytes);
    const totalBytes = parseInt(typeInfo.numberOfBytes);
    const numElements = Math.floor(totalBytes / elementBytes);

    for (let i = 0; i < numElements; i++) {
      const { slot, offset } = StorageDecoder.computeFixedArrayElementSlot(
        arrayBaseSlot,
        BigInt(i),
        elementBytes
      );

      if (slot !== targetSlot) continue;

      if (elementType.members) {
        // Array of structs
        this.decodeStructMembers(
          elementType,
          typeInfo.base,
          slot,
          targetSlot,
          slotHex,
          `${parentLabel}[${i}]`,
          results,
          getSlotValue
        );
      } else {
        const sizeBytes = elementBytes;
        const raw = StorageDecoder.extractFromSlot(slotHex, offset, sizeBytes);
        const rawHex = StorageDecoder.extractRawHex(slotHex, offset, sizeBytes);
        results.push({
          label: `${parentLabel}[${i}]`,
          type: elementType.label,
          value: this.decodeTypedValue(raw, typeInfo.base),
          rawHex,
          slot: targetSlot.toString(),
          offset,
          size: sizeBytes,
        });
      }
    }
  }

  /**
   * Decode a complete struct from storage, given its base slot and all necessary slot data.
   *
   * @param typeKey The type key for the struct (e.g., "t_struct(Order)_storage")
   * @param baseSlot The absolute base slot of the struct instance
   * @param getSlotValue Function to read slot values: (slotNumber) => "0x..."
   * @param parentLabel Optional label prefix for nested contexts
   */
  decodeStruct(
    typeKey: string,
    baseSlot: bigint,
    getSlotValue: (slot: bigint) => string | undefined,
    parentLabel: string = ""
  ): DecodedValue[] {
    const typeInfo = this.layout.types[typeKey];
    if (!typeInfo || !typeInfo.members) {
      throw new Error(`Type ${typeKey} is not a struct or not found`);
    }

    const results: DecodedValue[] = [];
    const numSlots = Math.ceil(parseInt(typeInfo.numberOfBytes) / 32);

    for (let i = 0; i < numSlots; i++) {
      const slotNum = baseSlot + BigInt(i);
      const slotHex = getSlotValue(slotNum) || "0x" + "0".repeat(64);
      this.decodeStructMembers(
        typeInfo,
        typeKey,
        baseSlot,
        slotNum,
        slotHex,
        parentLabel || typeKey.match(/\((\w+)\)/)?.[1] || "struct",
        results,
        getSlotValue
      );
    }

    return results;
  }

  /**
   * Decode a mapping entry. Computes the derived slot and decodes the value.
   *
   * @param mappingLabel The variable name of the mapping (e.g., "orders")
   * @param key The mapping key
   * @param getSlotValue Function to read slot values
   */
  decodeMappingEntry(
    mappingLabel: string,
    key: string | bigint,
    getSlotValue: (slot: bigint) => string | undefined
  ): DecodedValue[] {
    const entry = this.layout.storage.find((e) => e.label === mappingLabel);
    if (!entry) throw new Error(`Variable "${mappingLabel}" not found`);

    const typeInfo = this.layout.types[entry.type];
    if (!typeInfo || typeInfo.encoding !== "mapping") {
      throw new Error(`"${mappingLabel}" is not a mapping`);
    }

    const mappingSlot = BigInt(entry.slot);
    const keyType = typeInfo.key || "t_uint256";
    const valueSlot = StorageDecoder.computeMappingSlot(
      mappingSlot,
      key,
      keyType
    );

    const valueType = typeInfo.value!;
    const valueTypeInfo = this.layout.types[valueType];

    if (!valueTypeInfo) {
      throw new Error(`Value type ${valueType} not found`);
    }

    const label = `${mappingLabel}[${key}]`;

    if (valueTypeInfo.members) {
      // Value is a struct
      return this.decodeStruct(valueType, valueSlot, getSlotValue, label);
    } else if (
      valueTypeInfo.encoding === "mapping"
    ) {
      // Nested mapping — return the inner mapping info
      return [
        {
          label: label,
          type: valueTypeInfo.label,
          value: `(nested mapping - inner slot: ${valueSlot.toString()})`,
          rawHex: "0x",
          slot: valueSlot.toString(),
          offset: 0,
          size: 32,
        },
      ];
    } else {
      // Simple value type
      const slotHex = getSlotValue(valueSlot) || "0x" + "0".repeat(64);
      const sizeBytes = parseInt(valueTypeInfo.numberOfBytes);
      const raw = StorageDecoder.extractFromSlot(slotHex, 0, sizeBytes);
      const rawHex = StorageDecoder.extractRawHex(slotHex, 0, sizeBytes);
      return [
        {
          label,
          type: valueTypeInfo.label,
          value: this.decodeTypedValue(raw, valueType),
          rawHex,
          slot: valueSlot.toString(),
          offset: 0,
          size: sizeBytes,
        },
      ];
    }
  }

  /**
   * Decode a nested mapping entry (e.g., mapping(A => mapping(B => V))).
   */
  decodeNestedMappingEntry(
    mappingLabel: string,
    key1: string | bigint,
    key2: string | bigint,
    getSlotValue: (slot: bigint) => string | undefined
  ): DecodedValue[] {
    const entry = this.layout.storage.find((e) => e.label === mappingLabel);
    if (!entry) throw new Error(`Variable "${mappingLabel}" not found`);

    const outerType = this.layout.types[entry.type];
    if (!outerType || outerType.encoding !== "mapping") {
      throw new Error(`"${mappingLabel}" is not a mapping`);
    }

    const innerType = this.layout.types[outerType.value!];
    if (!innerType || innerType.encoding !== "mapping") {
      throw new Error(`"${mappingLabel}" is not a nested mapping`);
    }

    const mappingSlot = BigInt(entry.slot);
    const key1Type = outerType.key || "t_uint256";
    const key2Type = innerType.key || "t_uint256";

    const valueSlot = StorageDecoder.computeNestedMappingSlot(
      mappingSlot,
      key1,
      key1Type,
      key2,
      key2Type
    );

    const valueType = innerType.value!;
    const valueTypeInfo = this.layout.types[valueType];
    const label = `${mappingLabel}[${key1}][${key2}]`;

    if (valueTypeInfo.members) {
      return this.decodeStruct(valueType, valueSlot, getSlotValue, label);
    }

    const slotHex = getSlotValue(valueSlot) || "0x" + "0".repeat(64);
    const sizeBytes = parseInt(valueTypeInfo.numberOfBytes);
    const raw = StorageDecoder.extractFromSlot(slotHex, 0, sizeBytes);
    const rawHex = StorageDecoder.extractRawHex(slotHex, 0, sizeBytes);

    return [
      {
        label,
        type: valueTypeInfo.label,
        value: this.decodeTypedValue(raw, valueType),
        rawHex,
        slot: valueSlot.toString(),
        offset: 0,
        size: sizeBytes,
      },
    ];
  }

  /**
   * Decode a dynamic array element.
   */
  decodeDynamicArrayElement(
    arrayLabel: string,
    index: bigint,
    getSlotValue: (slot: bigint) => string | undefined
  ): DecodedValue[] {
    const entry = this.layout.storage.find((e) => e.label === arrayLabel);
    if (!entry) throw new Error(`Variable "${arrayLabel}" not found`);

    const typeInfo = this.layout.types[entry.type];
    if (!typeInfo || typeInfo.encoding !== "dynamic_array") {
      throw new Error(`"${arrayLabel}" is not a dynamic array`);
    }

    const baseType = typeInfo.base!;
    const elementTypeInfo = this.layout.types[baseType];
    const elementBytes = parseInt(elementTypeInfo.numberOfBytes);
    const arraySlot = BigInt(entry.slot);
    const label = `${arrayLabel}[${index}]`;

    const { slot: elemSlot, offset } =
      StorageDecoder.computeDynamicArrayElementSlot(
        arraySlot,
        index,
        elementBytes
      );

    if (elementTypeInfo.members) {
      // Array of structs
      return this.decodeStruct(baseType, elemSlot, getSlotValue, label);
    }

    const slotHex = getSlotValue(elemSlot) || "0x" + "0".repeat(64);
    const sizeBytes = elementBytes;
    const raw = StorageDecoder.extractFromSlot(slotHex, offset, sizeBytes);
    const rawHex = StorageDecoder.extractRawHex(slotHex, offset, sizeBytes);

    return [
      {
        label,
        type: elementTypeInfo.label,
        value: this.decodeTypedValue(raw, baseType),
        rawHex,
        slot: elemSlot.toString(),
        offset,
        size: sizeBytes,
      },
    ];
  }

  // ─── State Diff Decoding ───────────────────────────────────────────────

  /**
   * Decode a state diff into human-readable changes.
   *
   * Takes an array of slot diffs (slot number + old/new hex values)
   * and returns decoded before/after values for each variable.
   */
  decodeStateDiff(
    diffs: SlotDiff[],
    getSlotValue?: (slot: bigint) => string | undefined
  ): DecodedDiffEntry[] {
    const results: DecodedDiffEntry[] = [];

    for (const diff of diffs) {
      const slotNumber = BigInt(diff.slot);
      const fromDecoded = this.decodeSlot(slotNumber, diff.from, getSlotValue);
      const toDecoded = this.decodeSlot(slotNumber, diff.to, getSlotValue);

      // Match up decoded values by label
      const allLabels = new Set([
        ...fromDecoded.map((d) => d.label),
        ...toDecoded.map((d) => d.label),
      ]);

      for (const label of allLabels) {
        const from = fromDecoded.find((d) => d.label === label);
        const to = toDecoded.find((d) => d.label === label);

        results.push({
          label,
          type: (from || to)!.type,
          slot: diff.slot,
          offset: (from || to)!.offset,
          fromValue: from?.value ?? "(not present)",
          toValue: to?.value ?? "(not present)",
          fromRawHex: from?.rawHex ?? "0x",
          toRawHex: to?.rawHex ?? "0x",
          changed: from?.value !== to?.value,
        });
      }
    }

    return results;
  }

  /**
   * Format decoded state diff as a human-readable string.
   */
  static formatStateDiff(entries: DecodedDiffEntry[]): string {
    const lines: string[] = [];
    let currentSlot = "";

    for (const entry of entries) {
      if (entry.slot !== currentSlot) {
        currentSlot = entry.slot;
        lines.push("");
        lines.push(`Slot ${currentSlot}:`);
      }

      const marker = entry.changed ? "  ✓ CHANGED" : "";
      if (entry.changed) {
        lines.push(
          `  ${entry.label} (${entry.type}): ${entry.fromValue} → ${entry.toValue}${marker}`
        );
      } else {
        lines.push(
          `  ${entry.label} (${entry.type}): ${entry.fromValue} (unchanged)`
        );
      }
    }

    return lines.join("\n");
  }

  // ─── Full Contract State Decoder ───────────────────────────────────────

  /**
   * Decode ALL direct storage slots (non-mapping, non-dynamic-array) from the contract.
   * This covers all top-level variables, structs, fixed arrays, strings, etc.
   *
   * @param getSlotValue Function to read slot values from chain or snapshot
   */
  decodeAllDirectSlots(
    getSlotValue: (slot: bigint) => string | undefined
  ): DecodedValue[] {
    const results: DecodedValue[] = [];
    const processedSlots = new Set<string>();

    for (const entry of this.layout.storage) {
      const typeInfo = this.layout.types[entry.type];
      if (!typeInfo) continue;

      // Skip mappings and dynamic arrays (their values need keys/indices)
      if (
        typeInfo.encoding === "mapping" ||
        typeInfo.encoding === "dynamic_array"
      ) {
        const slotHex =
          getSlotValue(BigInt(entry.slot)) || "0x" + "0".repeat(64);
        if (typeInfo.encoding === "dynamic_array") {
          results.push({
            label: entry.label + ".length",
            type: "uint256",
            value: BigInt(slotHex).toString(),
            rawHex: slotHex,
            slot: entry.slot,
            offset: 0,
            size: 32,
          });
        } else {
          results.push({
            label: entry.label,
            type: typeInfo.label,
            value: "(mapping)",
            rawHex: "N/A",
            slot: entry.slot,
            offset: entry.offset,
            size: 32,
          });
        }
        continue;
      }

      const numSlots = Math.max(
        1,
        Math.ceil(parseInt(typeInfo.numberOfBytes) / 32)
      );

      for (let i = 0; i < numSlots; i++) {
        const slotNum = BigInt(entry.slot) + BigInt(i);
        const slotKey = slotNum.toString();

        if (processedSlots.has(slotKey)) continue;
        processedSlots.add(slotKey);

        const slotHex = getSlotValue(slotNum) || "0x" + "0".repeat(64);
        const decoded = this.decodeSlot(slotNum, slotHex, getSlotValue);
        results.push(...decoded);
      }
    }

    return results;
  }
}

// ─── Utility Functions ─────────────────────────────────────────────────────

/** Convert a hex string to a UTF-8 string */
function hexToUtf8(hex: string): string {
  const cleanHex = hex.replace("0x", "");
  let str = "";
  for (let i = 0; i < cleanHex.length; i += 2) {
    const code = parseInt(cleanHex.slice(i, i + 2), 16);
    if (code === 0) continue; // skip null bytes
    str += String.fromCharCode(code);
  }
  return str;
}

// ─── Convenience: Batch slot reader via ethers.js provider ─────────────────

/**
 * Create a getSlotValue function using an ethers.js provider.
 *
 * Usage:
 *   const provider = new JsonRpcProvider("https://...");
 *   const reader = createSlotReader(provider, "0xContractAddress");
 *   const value = await reader(0n);  // reads slot 0
 *
 * For state diffs (pre-fetched data), use the simpler map-based approach:
 *   const slots = new Map<string, string>();
 *   slots.set("0", "0x...");
 *   const reader = (slot: bigint) => slots.get(slot.toString());
 */
export function createSlotReaderFromMap(
  slotData: Record<string, string>
): (slot: bigint) => string | undefined {
  return (slot: bigint) => {
    const key = slot.toString();
    const hexKey = "0x" + slot.toString(16).padStart(64, "0");
    return slotData[key] || slotData[hexKey] || slotData[slot.toString(16)];
  };
}

/**
 * Create an async slot reader from an ethers.js provider.
 * Pre-fetches a range of slots and caches them.
 */
export async function prefetchSlots(
  provider: { getStorage: (address: string, slot: bigint) => Promise<string> },
  contractAddress: string,
  slots: bigint[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const promises = slots.map(async (slot) => {
    const value = await provider.getStorage(contractAddress, slot);
    result[slot.toString()] = value;
  });
  await Promise.all(promises);
  return result;
}

// ─── Export everything ─────────────────────────────────────────────────────

export default StorageDecoder;
