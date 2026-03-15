# Solidity Storage Layout & Decoding Guide

A comprehensive, A-to-Z guide for decoding Solidity contract storage slots—especially structs with packing—using the storage layout JSON, ABI, and raw slot data.

---

## Table of Contents

1. [Storage Layout Fundamentals](#1-storage-layout-fundamentals)
2. [Packing Rules](#2-packing-rules)
3. [Struct Layout in Detail](#3-struct-layout-in-detail)
4. [Dynamic Types (Arrays, Mappings, Strings, Bytes)](#4-dynamic-types)
5. [Inheritance and Storage](#5-inheritance-and-storage)
6. [The Storage Layout JSON Schema](#6-the-storage-layout-json-schema)
7. [The ABI and Its Role in Decoding](#7-the-abi-and-its-role-in-decoding)
8. [Decoding Algorithm: Step by Step](#8-decoding-algorithm-step-by-step)
9. [Slot Computation Formulas](#9-slot-computation-formulas)
10. [Bit-Level Extraction from Packed Slots](#10-bit-level-extraction-from-packed-slots)
11. [Worked Examples](#11-worked-examples)
12. [Building a User-Friendly State Diff Decoder](#12-building-a-user-friendly-state-diff-decoder)
13. [Edge Cases and Gotchas](#13-edge-cases-and-gotchas)
14. [Reference: Type Sizes](#14-reference-type-sizes)

---

## 1. Storage Layout Fundamentals

Solidity stores state variables in a flat key-value store where each **slot** is 32 bytes (256 bits) wide, addressed by a 256-bit key (slot number).

### Key principles:

- State variables are assigned storage slots **in declaration order**, starting from slot 0.
- Each slot is 32 bytes. Variables that fit are packed left-to-right within a slot (lower-order aligned / right-aligned in the slot's big-endian representation).
- **Constants** and **immutables** are NOT stored in storage (they are inlined in bytecode).
- Inherited contracts' variables come first (in C3 linearization order), then the child contract's variables.

### Storage is a mapping: `slot_number → 32_byte_value`

```
Slot 0:  0x0000000000000000000000000000000000000000000000000000000000000000
Slot 1:  0x0000000000000000000000000000000000000000000000000000000000000000
...
Slot N:  0x0000000000000000000000000000000000000000000000000000000000000000
```

Variables smaller than 32 bytes are stored at a **byte offset** within the slot (measured from the **least significant byte**, i.e., the right side of the hex representation).

---

## 2. Packing Rules

Solidity packs multiple variables into a single slot when possible, following these rules:

1. **The first item in a slot is stored lower-order aligned** (right-aligned in hex).
2. **Value types use only as many bytes as necessary** (e.g., `uint8` = 1 byte, `address` = 20 bytes, `bool` = 1 byte).
3. **If the next variable fits in the remaining space of the current slot, it is packed into it.** Otherwise, it starts a new slot.
4. **Structs and arrays always start a new slot.** Their members are packed as if they were top-level variables (within the struct's own contiguous slot range).
5. **Mappings and dynamic arrays always occupy a full slot** (which stores length or is unused, with actual data elsewhere).

### Packing example:

```solidity
contract Packed {
    uint128 a;    // slot 0, offset 0,  16 bytes
    uint64  b;    // slot 0, offset 16, 8 bytes
    uint64  c;    // slot 0, offset 24, 8 bytes  → all fit in slot 0 (16+8+8=32)
    uint256 d;    // slot 1, offset 0,  32 bytes  → needs full slot
    uint8   e;    // slot 2, offset 0,  1 byte
    bool    f;    // slot 2, offset 1,  1 byte
    address g;    // slot 2, offset 2,  20 bytes  → 1+1+20=22 ≤ 32, fits
}
```

### How the hex value looks in slot 0:

```
Slot 0 (hex, 32 bytes):
0x [c: 8 bytes] [b: 8 bytes] [a: 16 bytes]
   ←─ higher offset ──────── lower offset ─→

Example if a=100, b=200, c=300:
0x 000000000000012c 00000000000000c8 00000000000000000000000000000064
   c=300             b=200             a=100
```

**CRITICAL INSIGHT**: In the raw hex of a storage slot, lower-offset variables are on the **right** side, and higher-offset variables are on the **left** side. This is because Solidity uses **lower-order alignment** (least-significant-byte aligned).

---

## 3. Struct Layout in Detail

Structs follow the same packing rules as top-level variables, but:

- A struct **always starts at a new slot boundary**.
- Members are packed sequentially within the struct's slot range.
- After the struct, the next variable also starts at a new slot boundary.

### Example:

```solidity
struct OrderInfo {
    address maker;      // 20 bytes → slot +0, offset 0
    uint64  expiry;     // 8 bytes  → slot +0, offset 20  (20+8=28 ≤ 32, fits!)
    bool    cancelled;  // 1 byte   → slot +0, offset 28  (28+1=29 ≤ 32, fits!)
    uint256 amount;     // 32 bytes → slot +1, offset 0   (needs new slot)
    bytes32 orderHash;  // 32 bytes → slot +2, offset 0
}
// Total: 3 slots per OrderInfo instance
```

### Nested structs:

```solidity
struct Inner {
    uint128 x;   // 16 bytes
    uint128 y;   // 16 bytes  → packed into same slot as x
}

struct Outer {
    Inner  inner;    // starts at slot +0 (Inner occupies 1 slot)
    uint256 value;   // starts at slot +1
}
```

### Struct packing visualization:

```
OrderInfo at base slot S:

Slot S+0: |unused:3B|cancelled:1B|expiry:8B|maker:20B|
          ← bit 255                          bit 0 →

Slot S+1: |amount: 32B                              |

Slot S+2: |orderHash: 32B                           |
```

---

## 4. Dynamic Types

### Mappings

- The mapping variable itself occupies slot `p` (but the slot value is unused/zero).
- Value for key `k` is at slot: `keccak256(abi.encode(k, p))`
  - `k` is the key, left-padded to 32 bytes
  - `p` is the slot number, left-padded to 32 bytes
  - Concatenated (64 bytes total), then hashed

```
mapping(address => uint256) balances;  // at slot 3
// Balance of address 0xAbCd...1234:
// slot = keccak256(abi.encode(0xAbCd...1234, 3))
//      = keccak256(0x000000000000000000000000AbCd...1234 || 0x0000000000000000000000000000000000000000000000000000000000000003)
```

If the mapping value is a **struct**, the struct members start at the computed slot and use consecutive slots just like top-level storage:

```solidity
mapping(address => OrderInfo) orders;  // at slot 5
// For key 0xAbCd...1234:
// base = keccak256(abi.encode(0xAbCd...1234, 5))
// orders[key].maker     → slot base+0, offset 0
// orders[key].expiry    → slot base+0, offset 20
// orders[key].cancelled → slot base+0, offset 28
// orders[key].amount    → slot base+1, offset 0
// orders[key].orderHash → slot base+2, offset 0
```

### Nested Mappings

```solidity
mapping(address => mapping(uint256 => bool)) approvals;  // slot 7
// approvals[owner][id]:
// inner_slot = keccak256(abi.encode(owner, 7))
// final_slot = keccak256(abi.encode(id, inner_slot))
```

### Dynamic Arrays

- Slot `p` stores the **array length**.
- Array element `i` is at slot: `keccak256(abi.encode(p)) + i * elementSizeInSlots`
  - Note: the hash input is just the slot number (32 bytes), NOT the array contents.

```solidity
uint256[] values;  // at slot 4
// values.length is stored at slot 4
// values[0] is at keccak256(abi.encode(4)) + 0
// values[1] is at keccak256(abi.encode(4)) + 1
// values[i] is at keccak256(abi.encode(4)) + i
```

For arrays of structs:

```solidity
OrderInfo[] orders;  // at slot 6
// orders.length at slot 6
// orders[0] starts at keccak256(abi.encode(6)) + 0*3  (3 slots per OrderInfo)
// orders[1] starts at keccak256(abi.encode(6)) + 1*3
// orders[i] starts at keccak256(abi.encode(6)) + i*3
```

For arrays of packed types (e.g., `uint128[]`):

```solidity
uint128[] items;  // at slot 8
// Each uint128 is 16 bytes. Two fit per slot.
// items[0] → slot keccak256(abi.encode(8)) + 0, offset 0
// items[1] → slot keccak256(abi.encode(8)) + 0, offset 16
// items[2] → slot keccak256(abi.encode(8)) + 1, offset 0
// General: items[i] → slot base + (i * 16) / 32, offset (i * 16) % 32
```

### Strings and Bytes

- If length ≤ 31 bytes: data is stored in the **same slot**, with the **lowest byte** storing `length * 2`.
- If length ≥ 32 bytes: the slot stores `length * 2 + 1`, and actual data starts at `keccak256(abi.encode(p))`.

```
Short string "hello" (5 bytes) at slot 2:
Slot 2: 0x68656c6c6f00000000000000000000000000000000000000000000000000000a
         h e l l o  ...padding...                                       0a (= 5*2 = 10)

Long string detection: if (slotValue & 1) == 1, it's long-form.
```

---

## 5. Inheritance and Storage

Storage slots are allocated in **C3 linearization order** (base-most first):

```solidity
contract A {
    uint256 a;  // slot 0
}

contract B is A {
    uint256 b;  // slot 1
}

contract C is B {
    uint256 c;  // slot 2
}
```

For **diamond inheritance**, C3 linearization determines the unique ordering.

---

## 6. The Storage Layout JSON Schema

When you compile with `solc --storage-layout` or use Hardhat's `hardhat compile` (with storage layout enabled), you get a JSON like:

```json
{
  "storage": [
    {
      "astId": 3,
      "contract": "contracts/Example.sol:Example",
      "label": "owner",
      "offset": 0,
      "slot": "0",
      "type": "t_address"
    },
    {
      "astId": 7,
      "contract": "contracts/Example.sol:Example",
      "label": "balances",
      "offset": 0,
      "slot": "1",
      "type": "t_mapping(t_address,t_uint256)"
    },
    {
      "astId": 15,
      "contract": "contracts/Example.sol:Example",
      "label": "orderInfo",
      "offset": 0,
      "slot": "2",
      "type": "t_struct(OrderInfo)5_storage"
    }
  ],
  "types": {
    "t_address": {
      "encoding": "inplace",
      "label": "address",
      "numberOfBytes": "20"
    },
    "t_bool": {
      "encoding": "inplace",
      "label": "bool",
      "numberOfBytes": "1"
    },
    "t_uint256": {
      "encoding": "inplace",
      "label": "uint256",
      "numberOfBytes": "32"
    },
    "t_uint64": {
      "encoding": "inplace",
      "label": "uint64",
      "numberOfBytes": "8"
    },
    "t_mapping(t_address,t_uint256)": {
      "encoding": "mapping",
      "key": "t_address",
      "label": "mapping(address => uint256)",
      "numberOfBytes": "32",
      "value": "t_uint256"
    },
    "t_struct(OrderInfo)5_storage": {
      "encoding": "inplace",
      "label": "struct Example.OrderInfo",
      "members": [
        {
          "astId": 8,
          "contract": "contracts/Example.sol:Example",
          "label": "maker",
          "offset": 0,
          "slot": "0",
          "type": "t_address"
        },
        {
          "astId": 10,
          "contract": "contracts/Example.sol:Example",
          "label": "expiry",
          "offset": 20,
          "slot": "0",
          "type": "t_uint64"
        },
        {
          "astId": 12,
          "contract": "contracts/Example.sol:Example",
          "label": "cancelled",
          "offset": 28,
          "slot": "0",
          "type": "t_bool"
        },
        {
          "astId": 14,
          "contract": "contracts/Example.sol:Example",
          "label": "amount",
          "offset": 0,
          "slot": "1",
          "type": "t_uint256"
        }
      ],
      "numberOfBytes": "64"
    },
    "t_array(t_struct(OrderInfo)5_storage)dyn_storage": {
      "base": "t_struct(OrderInfo)5_storage",
      "encoding": "dynamic_array",
      "label": "struct Example.OrderInfo[]",
      "numberOfBytes": "32"
    }
  }
}
```

### Key fields explained:

| Field | Description |
|-------|-------------|
| `storage[].label` | Variable name |
| `storage[].slot` | Base slot number (as string) |
| `storage[].offset` | Byte offset within the slot (0-31) |
| `storage[].type` | Type identifier (key into `types` object) |
| `types[].encoding` | `"inplace"`, `"mapping"`, `"dynamic_array"`, or `"bytes"` |
| `types[].numberOfBytes` | Size of the type in bytes |
| `types[].members` | For structs: array of member descriptors (same shape as `storage[]`) |
| `types[].key` / `types[].value` | For mappings: key and value type identifiers |
| `types[].base` | For arrays: element type identifier |
| `members[].slot` | **Relative** slot within the struct (not absolute!) |
| `members[].offset` | Byte offset within that relative slot |

**IMPORTANT**: For struct members, the `slot` field is **relative to the struct's base slot**, not absolute. To get the absolute slot: `absolute_slot = struct_base_slot + member.slot`.

---

## 7. The ABI and Its Role in Decoding

The ABI is primarily for **function call encoding/decoding**, but it helps with storage decoding in these ways:

1. **Struct definitions**: In the ABI, structs appear as `tuple` types with `components`. This tells you the struct's fields and their types.

2. **Enum mappings**: The ABI shows enum types, which in storage are stored as `uint8`.

3. **Function signatures**: Help identify what variables exist and their types.

### ABI struct example:

```json
{
  "inputs": [
    {
      "components": [
        { "name": "maker", "type": "address" },
        { "name": "expiry", "type": "uint64" },
        { "name": "cancelled", "type": "bool" },
        { "name": "amount", "type": "uint256" },
        { "name": "orderHash", "type": "bytes32" }
      ],
      "name": "order",
      "type": "tuple"
    }
  ],
  "name": "fillOrder",
  "type": "function"
}
```

### What you need to decode storage:

| Data Source | What It Provides |
|-------------|-----------------|
| **Storage Layout JSON** | Slot numbers, offsets, type info, struct members |
| **ABI** | Human-readable type names, struct field names (for cross-referencing) |
| **Raw slot data** | The actual 32-byte values from `eth_getStorageAt` |
| **Contract source** (optional) | For understanding enums, constants, context |

**The storage layout JSON is the primary source for decoding.** The ABI supplements it with human-readable names and struct definitions for cases where you don't have the storage layout.

---

## 8. Decoding Algorithm: Step by Step

Given a **storage slot number** and its **raw 32-byte value**, here's how to decode it:

### Step 1: Identify what lives in this slot

Look up the slot number in the `storage` array. Multiple variables may share a slot (packing).

```typescript
function findVariablesInSlot(storageLayout, slotNumber) {
  return storageLayout.storage.filter(entry => {
    const baseSlot = BigInt(entry.slot);
    const typeInfo = storageLayout.types[entry.type];
    const numSlots = Math.ceil(Number(typeInfo.numberOfBytes) / 32);
    return slotNumber >= baseSlot && slotNumber < baseSlot + BigInt(numSlots);
  });
}
```

### Step 2: For each variable in the slot, determine extraction parameters

For simple types:
- `offset` = byte offset from LSB (from the storage layout JSON)
- `size` = numberOfBytes from the type info

For struct members, you need to resolve the member within the struct:
- `absolute_slot = struct_base_slot + member_relative_slot`
- `offset = member.offset`
- `size = type.numberOfBytes for that member`

### Step 3: Extract the raw bytes

```typescript
function extractValue(slotValue: bigint, offsetBytes: number, sizeBytes: number): bigint {
  const shift = BigInt(offsetBytes * 8);      // convert byte offset to bit shift
  const mask = (1n << BigInt(sizeBytes * 8)) - 1n;  // mask for the desired size
  return (slotValue >> shift) & mask;
}
```

### Step 4: Decode the raw value based on type

```typescript
function decodeValue(rawValue: bigint, typeLabel: string): any {
  if (typeLabel === 'address') {
    return '0x' + rawValue.toString(16).padStart(40, '0');
  }
  if (typeLabel === 'bool') {
    return rawValue !== 0n;
  }
  if (typeLabel.startsWith('uint')) {
    return rawValue;  // already unsigned
  }
  if (typeLabel.startsWith('int')) {
    const bits = parseInt(typeLabel.replace('int', ''));
    const maxPositive = (1n << BigInt(bits - 1)) - 1n;
    return rawValue > maxPositive ? rawValue - (1n << BigInt(bits)) : rawValue;
  }
  if (typeLabel.startsWith('bytes')) {
    // bytesN are stored LEFT-aligned (higher-order), not right-aligned!
    // But in packed storage, the raw extraction already handles this.
    return '0x' + rawValue.toString(16).padStart(sizeBytes * 2, '0');
  }
  if (typeLabel.startsWith('enum')) {
    return Number(rawValue);  // enums are uint8
  }
  // ... handle other types
}
```

### Step 5: Handle struct recursion

If the type is a struct, iterate over `types[typeKey].members` and recursively decode each member:

```typescript
function decodeStruct(storageLayout, typeKey, baseSlot, slots) {
  const typeInfo = storageLayout.types[typeKey];
  const result = {};

  for (const member of typeInfo.members) {
    const memberSlot = baseSlot + BigInt(member.slot);
    const slotValue = slots[memberSlot.toString()];  // raw 32-byte value
    const memberType = storageLayout.types[member.type];

    if (memberType.encoding === 'inplace' && !memberType.members) {
      // Simple type: extract and decode
      const raw = extractValue(slotValue, member.offset, Number(memberType.numberOfBytes));
      result[member.label] = decodeValue(raw, memberType.label);
    } else if (memberType.members) {
      // Nested struct: recurse
      result[member.label] = decodeStruct(storageLayout, member.type, memberSlot, slots);
    }
    // ... handle mappings, arrays within structs
  }

  return result;
}
```

---

## 9. Slot Computation Formulas

### Quick Reference Table

| Type | Slot Formula | Notes |
|------|-------------|-------|
| **Simple variable** | `slot` from layout | Direct |
| **Struct member** | `struct_slot + member.slot` | member.slot is relative |
| **Mapping value** | `keccak256(abi.encode(key, slot))` | key is padded to 32 bytes |
| **Nested mapping** | `keccak256(abi.encode(key2, keccak256(abi.encode(key1, slot))))` | Inside-out |
| **Mapping → struct member** | `keccak256(abi.encode(key, slot)) + member.slot` | Hash then add offset |
| **Dynamic array element** | `keccak256(abi.encode(slot)) + index * elementSlots` | Length at `slot` |
| **Dynamic array → struct** | `keccak256(abi.encode(slot)) + index * structSlots + member.slot` | Combine formulas |
| **Fixed array element** | `slot + index * elementSlots` | No hash needed |
| **String/bytes (short)** | `slot` | Data + length in same slot |
| **String/bytes (long)** | Data at `keccak256(abi.encode(slot))` | Length at `slot` |

### TypeScript implementations:

```typescript
import { keccak256, AbiCoder, zeroPadValue, toBeHex } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

// Mapping slot: keccak256(abi.encode(key, mappingSlot))
function getMappingSlot(mappingSlot: bigint, key: string | bigint): bigint {
  let keyBytes: string;
  if (typeof key === 'string' && key.startsWith('0x') && key.length === 42) {
    // address key
    keyBytes = coder.encode(['address', 'uint256'], [key, mappingSlot]);
  } else {
    // uint key
    keyBytes = coder.encode(['uint256', 'uint256'], [key, mappingSlot]);
  }
  return BigInt(keccak256(keyBytes));
}

// Dynamic array element slot: keccak256(abi.encode(arraySlot)) + index * elementSlots
function getArrayElementSlot(arraySlot: bigint, index: bigint, elementSlots: bigint): bigint {
  const baseDataSlot = BigInt(keccak256(coder.encode(['uint256'], [arraySlot])));
  return baseDataSlot + index * elementSlots;
}

// Nested mapping: mapping(K1 => mapping(K2 => V))
function getNestedMappingSlot(baseSlot: bigint, key1: string | bigint, key2: string | bigint): bigint {
  const innerSlot = getMappingSlot(baseSlot, key1);
  return getMappingSlot(innerSlot, key2);
}
```

---

## 10. Bit-Level Extraction from Packed Slots

This is the core of decoding packed structs. Given a raw slot value (32 bytes as a BigInt), extract a field at a given byte offset and size.

### The formula:

```
extracted_value = (slot_value >> (offset_bytes * 8)) & ((1 << (size_bytes * 8)) - 1)
```

### Visual example:

```
Slot value (hex): 0x 00000001 00000000671f2b80 000000000000000000000000AbCdEf1234567890

Assuming OrderInfo packed in this slot:
  - maker (address, 20B, offset 0):  Extract bits [0, 160)
  - expiry (uint64, 8B, offset 20):  Extract bits [160, 224)
  - cancelled (bool, 1B, offset 28): Extract bits [224, 232)

Step by step:
  maker     = (slotValue >> 0)   & ((1n << 160n) - 1n)  → 0xAbCdEf1234567890...
  expiry    = (slotValue >> 160n) & ((1n << 64n) - 1n)   → 0x671f2b80 (timestamp)
  cancelled = (slotValue >> 224n) & ((1n << 8n) - 1n)    → 0x01 (true)
```

### Complete extraction function:

```typescript
function extractFromSlot(
  slotHex: string,       // "0x..." 32-byte hex
  offsetBytes: number,   // byte offset (from LSB)
  sizeBytes: number      // number of bytes to extract
): bigint {
  const slotValue = BigInt(slotHex);
  const shift = BigInt(offsetBytes) * 8n;
  const mask = (1n << (BigInt(sizeBytes) * 8n)) - 1n;
  return (slotValue >> shift) & mask;
}

// For signed integers:
function extractSigned(
  slotHex: string,
  offsetBytes: number,
  sizeBytes: number
): bigint {
  const raw = extractFromSlot(slotHex, offsetBytes, sizeBytes);
  const bits = BigInt(sizeBytes) * 8n;
  const signBit = 1n << (bits - 1n);
  if (raw >= signBit) {
    return raw - (1n << bits);
  }
  return raw;
}
```

### Special case: `bytesN` types

Unlike integers, `bytesN` types (e.g., `bytes4`, `bytes20`) are stored **left-aligned** (higher-order) within their allocated space when they appear alone. However, when packed in a slot, the extraction with the standard offset/size formula still works correctly because the storage layout's offset accounts for the positioning.

```typescript
function extractBytesN(slotHex: string, offsetBytes: number, sizeBytes: number): string {
  const raw = extractFromSlot(slotHex, offsetBytes, sizeBytes);
  return '0x' + raw.toString(16).padStart(sizeBytes * 2, '0');
}
```

---

## 11. Worked Examples

### Example Contract:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ExampleDeFi {
    // Slot 0: owner (address = 20 bytes, offset 0) + paused (bool = 1 byte, offset 20)
    address public owner;           // slot 0, offset 0, 20 bytes
    bool public paused;             // slot 0, offset 20, 1 byte

    // Slot 1: totalOrders (uint256 = 32 bytes)
    uint256 public totalOrders;     // slot 1, offset 0, 32 bytes

    struct TokenInfo {
        address token;       // 20 bytes, slot +0, offset 0
        uint64  decimals;    // 8 bytes,  slot +0, offset 20 (packed with token!)
        bool    active;      // 1 byte,   slot +0, offset 28 (packed!)
        uint256 totalSupply; // 32 bytes, slot +1, offset 0 (new slot)
        string  name;        // dynamic,  slot +2 (takes 1 slot for pointer/short data)
    }

    struct Order {
        address maker;       // 20 bytes, slot +0, offset 0
        uint64  expiry;      // 8 bytes,  slot +0, offset 20
        bool    filled;      // 1 byte,   slot +0, offset 28
        uint256 amount;      // 32 bytes, slot +1, offset 0
        uint128 price;       // 16 bytes, slot +2, offset 0
        uint128 filledAmt;   // 16 bytes, slot +2, offset 16 (packed!)
    }

    // Slot 2-4: tokenInfo (struct, 3 slots)
    TokenInfo public tokenInfo;     // slot 2

    // Slot 5: orders mapping
    mapping(uint256 => Order) public orders;  // slot 5

    // Slot 6: dynamic array of orders
    Order[] public orderHistory;              // slot 6

    // Slot 7: nested mapping
    mapping(address => mapping(address => uint256)) public allowances;  // slot 7
}
```

### Example: Decode slot 0 (packed: owner + paused)

```
Raw slot 0 value: 0x0000000000000000000001005b38da6a701c568545dcfcb03fcb875f56beddc4

Extraction:
  owner  (offset=0, size=20):
    value = slot >> 0 & ((1<<160)-1) = 0x5b38da6a701c568545dcfcb03fcb875f56beddc4

  paused (offset=20, size=1):
    value = slot >> 160 & ((1<<8)-1) = 0x01 = true

Decoded: { owner: "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4", paused: true }
```

### Example: Decode Order struct from mapping

```
Given: orders[42] where orders mapping is at slot 5

Step 1: Compute base slot for orders[42]
  base = keccak256(abi.encode(42, 5))
  base = keccak256(0x000000000000000000000000000000000000000000000000000000000000002a
                    0000000000000000000000000000000000000000000000000000000000000005)
  base = 0x... (some 32-byte hash)

Step 2: Read 3 slots starting from base
  Slot base+0: 0x000000010000000067a8f2c0000000000000000000000000AbCd...1234
  Slot base+1: 0x0000000000000000000000000000000000000000000000008AC7230489E80000
  Slot base+2: 0x00000000000000004563918244F400000000000000000000DE0B6B3A7640000

Step 3: Decode each member
  maker (slot+0, off=0, 20B):  0xAbCd...1234
  expiry (slot+0, off=20, 8B): 1739146944 (unix timestamp)
  filled (slot+0, off=28, 1B): true
  amount (slot+1, off=0, 32B): 10000000000000000000 (10 ETH in wei)
  price (slot+2, off=0, 16B):  1000000000000000000 (1 ETH)
  filledAmt (slot+2, off=16, 16B): 5000000000000000000 (5 ETH)

Result:
{
  maker: "0xAbCd...1234",
  expiry: 1739146944,
  filled: true,
  amount: 10000000000000000000n,
  price: 1000000000000000000n,
  filledAmt: 5000000000000000000n
}
```

---

## 12. Building a User-Friendly State Diff Decoder

A state diff shows which storage slots changed between two blocks/transactions. To make this human-readable:

### Input:
```json
{
  "address": "0xContractAddress",
  "stateDiff": {
    "0x0000...0000": { "from": "0x00...00", "to": "0x00...01..." },
    "0x0000...0005": { "from": "0x00...00", "to": "0x00...ff..." },
    "0xabcd...1234": { "from": "0x00...00", "to": "0x00...42..." }
  }
}
```

### Algorithm:

1. **For each changed slot**, determine if it's a direct slot (in `storage[]`) or a derived slot (mapping/array).
2. **For direct slots**: Look up in `storage[]`, extract all packed variables, compare old vs new.
3. **For derived slots**: This is harder—you need to reverse-lookup what mapping/array produced this slot. This requires:
   - Knowing the keys used (from transaction input/logs)
   - Or brute-force checking: for each mapping in storage layout, check if `slot == keccak256(abi.encode(candidateKey, mappingSlot))`
4. **Format the output**:

```
Contract: 0xContractAddress (ExampleDeFi)

Slot 0 (packed):
  owner:  0x5B38...dC4  →  0x5B38...dC4  (unchanged)
  paused: false         →  true           ✓ CHANGED

Slot 5 → orders[42] (Order struct):
  orders[42].maker:     0xAbCd...1234  (unchanged)
  orders[42].filled:    false  →  true   ✓ CHANGED
  orders[42].filledAmt: 0      →  5 ETH  ✓ CHANGED
```

### Key insight for state diffs:

When a packed slot changes, you need to decode **both** the old and new values and compare each packed variable individually. Only some of the packed variables may have changed.

---

## 13. Edge Cases and Gotchas

### 1. Byte order confusion
- Storage values are **big-endian** when represented as hex.
- But packed variables are **lower-order aligned** (rightmost = offset 0).
- This means: `offset 0 = rightmost bytes`, `higher offset = leftward`.

### 2. `bytesN` vs `uintN`
- `uint32` stores value `0x12345678` as `0x...0000000012345678` (right-aligned in slot).
- `bytes4` stores value `0x12345678` as `0x12345678000000000000...0000` when alone in a slot.
- But when packed (offset > 0), both are correctly positioned by the compiler.
- **Always use the offset from the storage layout JSON**, which handles this.

### 3. Enums
- Stored as `uint8` in storage, regardless of how many variants.
- You need the source code or ABI to map the numeric value to the enum name.

### 4. Contract types (e.g., `IERC20 token`)
- Stored as `address` (20 bytes) in storage.

### 5. User-defined value types (Solidity ≥ 0.8.8)
- `type MyUint is uint256;` — stored identically to the underlying type.

### 6. Proxy contracts
- Storage layout belongs to the **implementation** contract, not the proxy.
- Make sure you're using the implementation's storage layout to decode the proxy's storage.

### 7. Gaps and reserved slots
- OpenZeppelin upgradeable contracts use `uint256[50] __gap;` to reserve slots.
- These show up in the storage layout and occupy 50 consecutive slots.

### 8. Zero values
- Uninitialized storage is all zeros. A slot reading `0x00...00` means all variables in that slot are at their default values.

### 9. Storage collisions in proxies
- EIP-1967 uses specific slots like `keccak256("eip1967.proxy.implementation") - 1` to avoid collisions.

---

## 14. Reference: Type Sizes

| Solidity Type | Size (bytes) | Storage Encoding |
|--------------|-------------|-----------------|
| `bool` | 1 | `0x00` or `0x01` |
| `uint8` | 1 | Right-aligned |
| `uint16` | 2 | Right-aligned |
| `uint32` | 4 | Right-aligned |
| `uint64` | 8 | Right-aligned |
| `uint128` | 16 | Right-aligned |
| `uint256` | 32 | Full slot |
| `int8` to `int256` | 1-32 | Two's complement, right-aligned |
| `address` | 20 | Right-aligned |
| `bytes1` to `bytes32` | 1-32 | **Left-aligned** when alone, but offset handles it when packed |
| `enum` | 1 | Stored as `uint8` |
| `contract` types | 20 | Stored as `address` |
| `mapping(K=>V)` | 32 | Slot stores nothing useful; values at hash-derived slots |
| `T[]` (dynamic array) | 32 | Slot stores length; elements at hash-derived slots |
| `T[N]` (fixed array) | `N * elementSlots * 32` | Inline, starting at base slot |
| `string` / `bytes` | 32 | Short: inline with length. Long: length in slot, data at hash-derived slots |
| `struct` | Sum of member slots × 32 | Members packed following standard rules |
