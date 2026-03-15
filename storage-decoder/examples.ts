/**
 * Worked Examples: End-to-End Storage Slot Decoding
 *
 * This file demonstrates how to use the StorageDecoder to decode
 * various storage patterns. Each example uses hardcoded slot values
 * that represent realistic on-chain data.
 *
 * Run with: npx ts-node examples.ts (or npx tsx examples.ts)
 */

import StorageDecoder, {
  createSlotReaderFromMap,
  StorageLayout,
  EnumDefinitions,
  SlotDiff,
} from "./decode-storage";

// ─── Storage Layout (matching ExampleStorageContract.sol) ────────────────

const storageLayout: StorageLayout = require("./storageLayout.example.json");

// ─── Enum Definitions ────────────────────────────────────────────────────

const enumDefs: EnumDefinitions = {
  OrderStatus: ["Open", "Filled", "Cancelled", "Expired"],
  Side: ["Buy", "Sell"],
};

// ─── ABI (relevant portions) ─────────────────────────────────────────────

const abi: any[] = []; // Not strictly needed for decoding with storage layout

// ─── Create Decoder Instance ─────────────────────────────────────────────

const decoder = new StorageDecoder(storageLayout, abi, enumDefs);

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 1: Decode Packed Slot (owner + initialized)
// ═══════════════════════════════════════════════════════════════════════════

console.log("═".repeat(80));
console.log("EXAMPLE 1: Decode packed slot 0 (owner + initialized)");
console.log("═".repeat(80));

// Slot 0 contains:
//   - owner (address, 20 bytes, offset 0)
//   - initialized (bool, 1 byte, offset 20)
//
// Raw value: the address 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4
//            with initialized=true (0x01) at byte offset 20
//
// In hex (remember: lower offset = rightmost):
//   0x 0000000000000000000001 5b38da6a701c568545dcfcb03fcb875f56beddc4
//      ↑ padding + initialized  ↑ owner address (20 bytes at offset 0)

const slot0Value =
  "0x0000000000000000000000015b38da6a701c568545dcfcb03fcb875f56beddc4";

const slot0Decoded = decoder.decodeSlot(0n, slot0Value);
console.log("\nRaw slot value:", slot0Value);
console.log("\nDecoded variables:");
for (const v of slot0Decoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
  console.log(`    → raw: ${v.rawHex}, offset: ${v.offset}, size: ${v.size}`);
}

// Manual verification:
console.log("\n--- Manual Verification ---");
const ownerRaw = StorageDecoder.extractFromSlot(slot0Value, 0, 20);
console.log(
  "  owner =",
  "0x" + ownerRaw.toString(16).padStart(40, "0")
);
const initRaw = StorageDecoder.extractFromSlot(slot0Value, 20, 1);
console.log("  initialized =", initRaw !== 0n);

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 2: Decode FeeConfig Struct (tightly packed, 1 slot)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 2: Decode FeeConfig struct in slot 2");
console.log("═".repeat(80));

// FeeConfig at slot 2:
//   makerFee  (uint64, 8B, off=0):  500  = 0x00000000000001F4
//   takerFee  (uint64, 8B, off=8):  1000 = 0x00000000000003E8
//   rebateBps (uint32, 4B, off=16): 50   = 0x00000032
//   feesEnabled (bool, 1B, off=20): true = 0x01
//
// Packed into slot 2 (right-to-left):
//   0x 000000000000000000000001 00000032 00000000000003e8 00000000000001f4
//      ↑pad + feesEnabled        ↑rebate   ↑takerFee        ↑makerFee

const slot2Value =
  "0x00000000000000000000000100000032000000000000003e800000000000001f4";

// Wait - let's compute this correctly
// makerFee = 500 = 0x1f4 → 8 bytes at offset 0 = rightmost 16 hex chars
// takerFee = 1000 = 0x3e8 → 8 bytes at offset 8 = next 16 hex chars
// rebateBps = 50 = 0x32 → 4 bytes at offset 16 = next 8 hex chars
// feesEnabled = 1 → 1 byte at offset 20 = next 2 hex chars
//
// Building right to left:
//   makerFee:    00000000000001f4 (16 hex)
//   takerFee:    00000000000003e8 (16 hex)
//   rebateBps:   00000032 (8 hex)
//   feesEnabled: 01 (2 hex)
//   padding:     000000000000000000000000 (22 hex to fill 64 total)
// Total: 22+2+8+16+16 = 64 hex chars ✓

const slot2Correct =
  "0x00000000000000000000000100000032000000000000003e800000000000001f4";

console.log("\nRaw slot value:", slot2Correct);
const slot2Decoded = decoder.decodeSlot(2n, slot2Correct);
console.log("\nDecoded FeeConfig struct members:");
for (const v of slot2Decoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 3: Decode packed slot with enums and address (slot 3)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 3: Decode slot 3 (globalStatus + version + maxOrders + feeRecipient)");
console.log("═".repeat(80));

// Slot 3 contains:
//   globalStatus (enum/uint8, 1B, off=0): Open = 0
//   version (uint8, 1B, off=1): 1
//   maxOrdersPerUser (uint16, 2B, off=2): 100 = 0x0064
//   feeRecipient (address, 20B, off=4): 0xdead...beef
//
// Building right to left (64 hex chars):
//   globalStatus: 00 (2 hex)
//   version:      01 (2 hex)
//   maxOrders:    0064 (4 hex)
//   feeRecipient: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef (40 hex)
//   padding:      0000000000000000 (16 hex to fill to 64)

const slot3Value =
  "0x0000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef00640100";

console.log("\nRaw slot value:", slot3Value);
const slot3Decoded = decoder.decodeSlot(3n, slot3Value);
console.log("\nDecoded variables:");
for (const v of slot3Decoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 4: Decode a Mapping → Struct (Order from orders mapping)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 4: Decode orders[42] (mapping → struct)");
console.log("═".repeat(80));

// Step 1: Compute the base slot for orders[42]
// orders mapping is at slot 5
// key = 42 (uint256), slot = 5
// base = keccak256(abi.encode(42, 5))

const ordersSlot = 5n;
const orderKey = 42n;
const orderBaseSlot = StorageDecoder.computeMappingSlot(ordersSlot, orderKey);
console.log(
  "\nComputed base slot for orders[42]:",
  "0x" + orderBaseSlot.toString(16)
);

// Step 2: Prepare the raw slot values for this Order struct (4 slots)
// Order struct:
//   Slot +0: maker(20B,off=0) + expiry(8B,off=20) + side(1B,off=28) + filled(1B,off=29)
//   Slot +1: amount (32B)
//   Slot +2: price(16B,off=0) + filledAmount(16B,off=16)
//   Slot +3: orderHash (32B)

// Let's create realistic values:
//   maker = 0xAbCdEf0123456789AbCdEf0123456789AbCdEf01
//   expiry = 1735689600 (2025-01-01 00:00:00 UTC) = 0x67748580
//   side = Sell (1) = 0x01
//   filled = false (0) = 0x00
//   amount = 1000000000000000000 (1 ETH in wei) = 0xDE0B6B3A7640000
//   price = 3500000000000000000000 (3500 USDC with 18 dec) = 0xBD...
//   filledAmount = 0
//   orderHash = 0xaabbccdd...

// Slot +0: [2B padding][filled:1B][side:1B][expiry:8B][maker:20B]
const orderSlot0 =
  "0x000000000001000000006774858000000000abcdef0123456789abcdef0123456789abcdef01";
// Actually let me compute this properly with 64 hex chars
// maker (20B at off 0) = abcdef0123456789abcdef0123456789abcdef01 (40 hex)
// expiry (8B at off 20) = 0000000067748580 (16 hex)
// side (1B at off 28) = 01 (2 hex)
// filled (1B at off 29) = 00 (2 hex)
// padding (2B at off 30) = 0000 (4 hex)
// Total = 40+16+2+2+4 = 64 ✓
const orderSlot0Correct =
  "0x0000000100000000677485800000000000000000abcdef0123456789abcdef01";
// Hmm, that's not right either. Let me think about this carefully.
//
// Slot is 32 bytes = 64 hex chars.
// Variables are packed from the right (LSB):
//   Bytes [0-19]  (offset 0-19, 20 bytes): maker
//   Bytes [20-27] (offset 20-27, 8 bytes): expiry
//   Byte  [28]    (offset 28, 1 byte): side
//   Byte  [29]    (offset 29, 1 byte): filled
//   Bytes [30-31] (offset 30-31, 2 bytes): unused
//
// In big-endian hex representation (how getStorageAt returns it):
//   The rightmost bytes are the lowest-addressed (offset 0).
//   So offset 0 (maker) is on the RIGHT side of the hex string.
//
// Hex string positions (0x + 64 hex chars):
//   Position [2..5]   = bytes [31..30] = unused (4 hex chars)
//   Position [6..7]   = byte  [29]     = filled (2 hex chars)
//   Position [8..9]   = byte  [28]     = side (2 hex chars)
//   Position [10..25]  = bytes [27..20] = expiry (16 hex chars)
//   Position [26..65]  = bytes [19..0]  = maker (40 hex chars)

const orderSlot0Final =
  "0x00000001000000006774858000000000abcdef0123456789abcdef0123456789abcdef01";
// Let me count: 0x + "0000" + "00" + "01" + "0000000067748580" + "00000000abcdef0123456789abcdef0123456789abcdef01"
// Hmm that doesn't look right. Let me just carefully build it.

// Byte 31 (leftmost) = 0x00    → hex pos 2-3
// Byte 30            = 0x00    → hex pos 4-5
// Byte 29 (filled=0) = 0x00    → hex pos 6-7
// Byte 28 (side=1)   = 0x01    → hex pos 8-9
// Byte 27            = 0x00    → hex pos 10-11 (expiry high byte)
// Byte 26            = 0x00    → hex pos 12-13
// Byte 25            = 0x00    → hex pos 14-15
// Byte 24            = 0x00    → hex pos 16-17
// Byte 23            = 0x67    → hex pos 18-19
// Byte 22            = 0x74    → hex pos 20-21
// Byte 21            = 0x85    → hex pos 22-23
// Byte 20 (exp low)  = 0x80    → hex pos 24-25
// Byte 19            = 0xab    → hex pos 26-27 (maker high byte)
// Byte 18            = 0xcd    → hex pos 28-29
// ... (maker continues)
// Byte 0 (maker low) = 0x01    → hex pos 64-65

// So: 0x 0000 00 01 0000000067748580 abcdef0123456789abcdef0123456789abcdef01
// Count: "0x" + 4 + 2 + 2 + 16 + 40 = 64 ✓

const o0 =
  "0x000000010000000067748580abcdef0123456789abcdef0123456789abcdef01";
// Count: 2("0x") + 62... hmm let me count the hex chars after 0x
// 00000001 0000000067748580 abcdef0123456789abcdef0123456789abcdef01
// 8         16                40 = 64 ✓

const o1 =
  "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000";
// amount = 1 ETH = 10^18 = 0xDE0B6B3A7640000

const o2 =
  "0x00000000000000000000000000000000000000000000000000038d7ea4c68000";
// price = 1000000000000000 (0.001 ETH) at offset 0 (16 bytes)
// filledAmount = 0 at offset 16 (16 bytes)
// Actually, let's set:
// price = 0x00000000000000000DE0B6B3A7640000 (1 ETH, 16B at offset 0)
// filledAmount = 0x00000000000000000000000000000000 (0, 16B at offset 16)
// Hex: [filledAmount:32hex][price:32hex]
const o2Correct =
  "0x000000000000000000000000000000000000000000000000000000000de0b6b3a7640000";
// That's too long. Let me be more careful:
// 16 bytes = 32 hex chars each
// filledAmount (high, offset 16): 00000000000000000000000000000000 (32 hex)
// price (low, offset 0):          0000000000000000de0b6b3a7640000 should be 32 hex
// de0b6b3a7640000 = 15 hex → pad to 32: 00000000000000000de0b6b3a7640000

const slot2_order =
  "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000";
// This is just price with filledAmount=0. Total 64 hex chars ✓

const o3 =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// orderHash = 0xaaaa...aaaa

// Build slot data map
const orderSlots: Record<string, string> = {};
orderSlots[orderBaseSlot.toString()] = o0;
orderSlots[(orderBaseSlot + 1n).toString()] = o1;
orderSlots[(orderBaseSlot + 2n).toString()] = slot2_order;
orderSlots[(orderBaseSlot + 3n).toString()] = o3;

const slotReader = createSlotReaderFromMap(orderSlots);

// Step 3: Decode the full struct
console.log("\nDecoding orders[42] struct across 4 slots:");
const orderDecoded = decoder.decodeMappingEntry("orders", 42n, slotReader);
for (const v of orderDecoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
  console.log(`    → slot: ${v.slot}, offset: ${v.offset}, raw: ${v.rawHex}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 5: Decode a State Diff
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 5: State Diff - paused flag toggled + totalOrders incremented");
console.log("═".repeat(80));

// Scenario: A transaction changes:
// 1. Slot 0: initialized stays true, but let's say owner doesn't change
//    Before: owner = 0x5b38..., initialized = true
//    After:  owner = 0x5b38..., initialized = true (no actual change, but let's demo)
// 2. Slot 1: totalOrders changes from 41 to 42

const stateDiff: SlotDiff[] = [
  {
    slot: "0",
    from: "0x0000000000000000000000015b38da6a701c568545dcfcb03fcb875f56beddc4",
    to: "0x0000000000000000000000015b38da6a701c568545dcfcb03fcb875f56beddc4",
  },
  {
    slot: "1",
    from: "0x0000000000000000000000000000000000000000000000000000000000000029",
    to: "0x000000000000000000000000000000000000000000000000000000000000002a",
  },
];

const diffResults = decoder.decodeStateDiff(stateDiff);
console.log("\nDecoded State Diff:");
console.log(StorageDecoder.formatStateDiff(diffResults));

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 6: Decode Nested Mapping (allowances[from][to])
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 6: Nested mapping - allowances[alice][bob]");
console.log("═".repeat(80));

const alice = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4";
const bob = "0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2";

// Compute the slot
const allowanceSlot = StorageDecoder.computeNestedMappingSlot(
  8n, // allowances is at slot 8
  alice,
  "t_address",
  bob,
  "t_address"
);
console.log(
  "\nComputed slot for allowances[alice][bob]:",
  "0x" + allowanceSlot.toString(16)
);

// Prepare data
const allowanceData: Record<string, string> = {};
allowanceData[allowanceSlot.toString()] =
  "0x0000000000000000000000000000000000000000000000056bc75e2d63100000";
// = 100 * 10^18 = 100 tokens

const allowanceDecoded = decoder.decodeNestedMappingEntry(
  "allowances",
  alice,
  bob,
  createSlotReaderFromMap(allowanceData)
);

console.log("\nDecoded allowances[alice][bob]:");
for (const v of allowanceDecoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 7: Dynamic Array Element (orderHistory[0])
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 7: Dynamic array - orderHistory[0]");
console.log("═".repeat(80));

// orderHistory is at slot 7
// Length is stored at slot 7
// Element 0 starts at keccak256(abi.encode(7))
// Each Order is 4 slots (128 bytes)

const arrayBase = StorageDecoder.computeDynamicArrayElementSlot(7n, 0n, 128);
console.log(
  "\nComputed slot for orderHistory[0]:",
  "0x" + arrayBase.slot.toString(16)
);
console.log("Offset:", arrayBase.offset);

// Reuse the same order data from Example 4
const arraySlots: Record<string, string> = {};
arraySlots[arrayBase.slot.toString()] = o0;
arraySlots[(arrayBase.slot + 1n).toString()] = o1;
arraySlots[(arrayBase.slot + 2n).toString()] = slot2_order;
arraySlots[(arrayBase.slot + 3n).toString()] = o3;

const arrayDecoded = decoder.decodeDynamicArrayElement(
  "orderHistory",
  0n,
  createSlotReaderFromMap(arraySlots)
);

console.log("\nDecoded orderHistory[0]:");
for (const v of arrayDecoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 8: Fixed Array (fixedPrices[0..3])
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 8: Fixed array - fixedPrices[0..3] (uint128[4] at slot 10)");
console.log("═".repeat(80));

// uint128[4] at slot 10
// Each uint128 = 16 bytes. Two fit per slot.
// fixedPrices[0] → slot 10, offset 0 (16 bytes)
// fixedPrices[1] → slot 10, offset 16 (16 bytes)
// fixedPrices[2] → slot 11, offset 0 (16 bytes)
// fixedPrices[3] → slot 11, offset 16 (16 bytes)

// Slot 10: [prices[1]:16B at offset 16][prices[0]:16B at offset 0]
// prices[0] = 1500 * 10^18 = 0x51B34E0A76... (let's use simpler values)
// prices[0] = 100 = 0x64
// prices[1] = 200 = 0xC8
const slot10Value =
  "0x000000000000000000000000000000c800000000000000000000000000000064";
// [16B: prices[1]=200][16B: prices[0]=100]

const slot11Value =
  "0x0000000000000000000000000000012c00000000000000000000000000000190";
// [16B: prices[3]=300][16B: prices[2]=400]
// Wait, 0x190 = 400, 0x12c = 300

console.log("\nSlot 10:", slot10Value);
console.log("Slot 11:", slot11Value);

const fixedDecoded10 = decoder.decodeSlot(10n, slot10Value);
const fixedDecoded11 = decoder.decodeSlot(11n, slot11Value);

console.log("\nDecoded from slot 10:");
for (const v of fixedDecoded10) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}
console.log("Decoded from slot 11:");
for (const v of fixedDecoded11) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 9: Short String Decoding
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log('EXAMPLE 9: Short string - description = "Hello DeFi"');
console.log("═".repeat(80));

// "Hello DeFi" = 10 bytes = 0x48656c6c6f2044654669
// Short string encoding: data (left-aligned) + length*2 in lowest byte
// length = 10, length*2 = 20 = 0x14
//
// Slot value: 0x48656c6c6f20446546690000000000000000000000000000000000000000 14
// But the length byte is the LOWEST byte (rightmost), and data is in HIGH bytes (leftmost)

const slot4String =
  "0x48656c6c6f204465466900000000000000000000000000000000000000000014";

console.log("\nRaw slot 4:", slot4String);

const stringDecoded = decoder.decodeSlot(4n, slot4String);
console.log("\nDecoded:");
for (const v of stringDecoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 10: UserProfile with Nested Struct
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 10: UserProfile mapping with nested FeeConfig struct");
console.log("═".repeat(80));

// userProfiles mapping at slot 6
// For user alice: keccak256(abi.encode(alice, 6))
const profileBaseSlot = StorageDecoder.computeMappingSlot(6n, alice, "t_address");
console.log(
  "\nComputed slot for userProfiles[alice]:",
  "0x" + profileBaseSlot.toString(16)
);

// UserProfile:
//   slot +0: user(20B,off=0) + nonce(4B,off=20) + active(1B,off=24)
//   slot +1: customFees.makerFee(8B,off=0) + takerFee(8B,off=8) + rebateBps(4B,off=16) + feesEnabled(1B,off=20)
//   slot +2: totalVolume (32B)
//   slot +3: username (string, short)

// alice = 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4
// nonce = 7 = 0x07
// active = true = 0x01
const profileSlot0 =
  "0x00000000000000000000000000000001000000075b38da6a701c568545dcfcb03fcb875f56beddc4";
// Hmm that's too long. Let me be careful.
// Byte offsets:
//   user (20B, off 0) → rightmost 40 hex chars
//   nonce (4B, off 20) → next 8 hex chars
//   active (1B, off 24) → next 2 hex chars
//   unused (7B, off 25-31) → 14 hex chars
// Total: 14 + 2 + 8 + 40 = 64 ✓

// 5b38da6a701c568545dcfcb03fcb875f56beddc4 = alice (40 hex)
// 00000007 = nonce (8 hex)
// 01 = active (2 hex)
// 00000000000000 = padding (14 hex)
// Total: 14+2+8+40 = 64 ✓
const profileS0 =
  "0x00000000000000010000000700000000" + "5b38da6a701c568545dcfcb03fcb875f56beddc4";
// Hmm wait that's 32+40 = 72. Not right.
// Let me just carefully construct 64 hex chars:
// [padding 14][active 2][nonce 8][user 40] = 64
const pS0 =
  "0x0000000000000001000000075b38da6a701c568545dcfcb03fcb875f56beddc4";
// Count after 0x: 14+2+8+40 = 64 ✓

// customFees: makerFee=250, takerFee=500, rebateBps=25, feesEnabled=true
// [padding 22][feesEnabled 2][rebateBps 8][takerFee 16][makerFee 16]
const pS1 =
  "0x000000000000000000000001000000190000000000000001f4000000000000000fa";
// That's 65. Let me count more carefully.
// makerFee = 250 = 0xFA → 16 hex padded: 00000000000000fa
// takerFee = 500 = 0x1F4 → 16 hex padded: 00000000000001f4
// rebateBps = 25 = 0x19 → 8 hex padded: 00000019
// feesEnabled = true → 2 hex: 01
// padding → 22 hex: 0000000000000000000000
// Total: 22+2+8+16+16 = 64 ✓
const pS1Correct =
  "0x000000000000000000000001000000190000000000000001f400000000000000fa";

// totalVolume = 5 ETH = 5 * 10^18 = 0x4563918244F40000
const pS2 =
  "0x000000000000000000000000000000000000000000000000" + "4563918244f40000";

// username = "alice" (5 bytes) → short string
// "alice" = 0x616c696365
// length = 5, length*2 = 10 = 0x0a
const pS3 =
  "0x616c69636500000000000000000000000000000000000000000000000000000a";

const profileData: Record<string, string> = {};
profileData[profileBaseSlot.toString()] = pS0;
profileData[(profileBaseSlot + 1n).toString()] = pS1Correct;
profileData[(profileBaseSlot + 2n).toString()] = pS2;
profileData[(profileBaseSlot + 3n).toString()] = pS3;

const profileDecoded = decoder.decodeMappingEntry(
  "userProfiles",
  alice,
  createSlotReaderFromMap(profileData)
);

console.log("\nDecoded userProfiles[alice]:");
for (const v of profileDecoded) {
  console.log(`  ${v.label} (${v.type}): ${v.value}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 11: Complete State Diff with Struct Changes
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 11: Real-world State Diff - Order fill transaction");
console.log("═".repeat(80));

// Scenario: fillOrder(42, 0.5 ETH) changes:
// - totalOrders: unchanged
// - orders[42].filled: false → true
// - orders[42].filledAmount: 0 → 0.5 ETH

// We can demonstrate this with direct slot diffs:
// Slot +0 of orders[42]: filled changes from 0 to 1
// Slot +2 of orders[42]: filledAmount changes from 0 to 500000000000000000

// orders[42] slot +0 before (filled=false):
const beforeSlot0 =
  "0x000000010000000067748580abcdef0123456789abcdef0123456789abcdef01";
// After (filled=true): byte 29 changes from 00 to 01
// But wait, we already have side=1 at byte 28. Let me re-examine.
// The "before" above has: byte 28=01 (side=Sell), byte 29=00 (filled=false)
// Hmm, looking at the hex: 00 00 00 01 means:
// byte 31=00, 30=00, 29=00, 28=01
// That means filled(off=29)=0 and side(off=28)=1. ✓

// After: filled=true means byte 29 = 01
// 00 00 01 01 → bytes 31=00, 30=00, 29=01, 28=01
const afterSlot0 =
  "0x000001010000000067748580abcdef0123456789abcdef0123456789abcdef01";

// orders[42] slot +2 before: price=0xDE0B6B3A7640000, filledAmount=0
const beforeSlot2 = slot2_order;
// After: filledAmount = 500000000000000000 = 0x6F05B59D3B20000 (16 bytes at offset 16)
// [filledAmount:32hex][price:32hex]
// price = 0de0b6b3a7640000 (already from before)
const afterSlot2 =
  "0x000000000000000006f05b59d3b200000000000000000000" + "0de0b6b3a7640000";
// Count: I need exactly 64 hex chars after 0x
// filledAmount (16B, 32 hex): 00000000000000006f05b59d3b200000
// price (16B, 32 hex): 0000000000000000de0b6b3a7640000
// Hmm 0de0b6b3a7640000 is 16 hex, need 32. Let me pad:
// price = 000000000000000de0b6b3a7640000 → that's 30 hex, need 32
// 10^18 = 0xDE0B6B3A7640000 (15 hex) → padded to 32: 0000000000000000de0b6b3a7640000 → 31 hex
// Actually 0xDE0B6B3A7640000 = let me count: D E 0 B 6 B 3 A 7 6 4 0 0 0 0 = 15 hex
// Padded to 32 hex: 00000000000000000de0b6b3a7640000
// 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 d e 0 b 6 b 3 a 7 6 4 0 0 0 0 = 32 ✓

const afterSlot2Correct =
  "0x00000000000000006f05b59d3b20000000000000000000000de0b6b3a7640000";
// Count: 32+32 = 64 ✓

const orderFillDiff: SlotDiff[] = [
  {
    slot: orderBaseSlot.toString(),
    from: beforeSlot0,
    to: afterSlot0,
  },
  {
    slot: (orderBaseSlot + 2n).toString(),
    from: beforeSlot2,
    to: afterSlot2Correct,
  },
];

// But we need the decoder to know these slots belong to orders[42]...
// For derived slots (mapping values), the decoder can't automatically resolve them
// because it doesn't know the key. This is a known limitation.
// In practice, you'd need transaction context (the input data) to determine keys.

// Let's demonstrate with direct slots instead:
const directDiff: SlotDiff[] = [
  {
    slot: "0",
    from: "0x0000000000000000000000015b38da6a701c568545dcfcb03fcb875f56beddc4",
    to: "0x0000000000000000000000015b38da6a701c568545dcfcb03fcb875f56beddc4",
  },
  {
    slot: "1",
    from: "0x0000000000000000000000000000000000000000000000000000000000000029",
    to: "0x000000000000000000000000000000000000000000000000000000000000002a",
  },
  {
    slot: "3",
    from: "0x0000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef00640100",
    to: "0x0000000000000000deadbeefdeadbeefdeadbeefdeadbeefdeadbeef00640102",
  },
];

const fullDiffResults = decoder.decodeStateDiff(directDiff);
console.log("\nDecoded State Diff (direct slots):");
console.log(StorageDecoder.formatStateDiff(fullDiffResults));

// ═══════════════════════════════════════════════════════════════════════════
// EXAMPLE 12: How to Use This in Practice with ethers.js
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n" + "═".repeat(80));
console.log("EXAMPLE 12: Pseudocode for real-world usage with ethers.js");
console.log("═".repeat(80));

console.log(`
// ─── Real-world usage with ethers.js ─────────────────────────────

import { JsonRpcProvider } from 'ethers';
import StorageDecoder, { prefetchSlots, createSlotReaderFromMap } from './decode-storage';

// 1. Load the storage layout (from Hardhat compilation artifacts)
const storageLayout = require('./artifacts/contracts/MyContract.sol/MyContract.json').storageLayout;
// Or from solc output: solc --storage-layout MyContract.sol

// 2. Load the ABI
const abi = require('./artifacts/contracts/MyContract.sol/MyContract.json').abi;

// 3. Define enum mappings (from source code)
const enums = {
  OrderStatus: ['Open', 'Filled', 'Cancelled', 'Expired'],
  Side: ['Buy', 'Sell'],
};

// 4. Create the decoder
const decoder = new StorageDecoder(storageLayout, abi, enums);

// 5. Connect to a provider
const provider = new JsonRpcProvider('https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY');
const contractAddress = '0xYourContract...';

// 6a. Read and decode a specific slot
const slot0 = await provider.getStorage(contractAddress, 0);
const decoded = decoder.decodeSlot(0n, slot0);
console.log(decoded);

// 6b. Decode a mapping entry
async function readSlot(slot: bigint): Promise<string> {
  return await provider.getStorage(contractAddress, slot);
}

// Cache slots we'll need (Order struct = 4 slots)
const orderBaseSlot = StorageDecoder.computeMappingSlot(5n, 42n);
const orderSlots = await prefetchSlots(provider, contractAddress, [
  orderBaseSlot,
  orderBaseSlot + 1n,
  orderBaseSlot + 2n,
  orderBaseSlot + 3n,
]);
const reader = createSlotReaderFromMap(orderSlots);
const order = decoder.decodeMappingEntry('orders', 42n, reader);
console.log(order);

// 7. Decode state diffs from a transaction trace
// Use debug_traceTransaction or trace_replayTransaction to get stateDiff
// Then pass it to decoder.decodeStateDiff()

// 8. For proxy contracts: use the IMPLEMENTATION's storage layout
//    but read from the PROXY's address
const implStorageLayout = require('./artifacts/.../Implementation.json').storageLayout;
const proxyDecoder = new StorageDecoder(implStorageLayout, abi, enums);
// Then read slots from the proxy address, but decode using implementation layout
`);

// ─── Summary ─────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(80));
console.log("SUMMARY");
console.log("═".repeat(80));
console.log(`
Key takeaways for decoding Solidity storage:

1. STORAGE LAYOUT JSON is your primary reference
   - Get it from: solc --storage-layout, Hardhat artifacts, or forge inspect

2. SLOT VALUES are 32 bytes, big-endian hex
   - Read with: eth_getStorageAt(address, slot)
   - Lower offset = rightmost bytes

3. PACKED VARIABLES use bit extraction:
   value = (slotValue >> (offset * 8)) & ((1 << (size * 8)) - 1)

4. STRUCT MEMBERS have RELATIVE slot offsets
   absolute_slot = struct_base_slot + member.slot

5. MAPPINGS use keccak256 for slot derivation:
   slot = keccak256(abi.encode(key, mappingSlot))

6. DYNAMIC ARRAYS store length at base slot, data at keccak256(baseSlot)

7. STRINGS: check lowest bit - 0=short (inline), 1=long (data at hash)

8. STATE DIFFS need both old and new values decoded to show what changed

9. DERIVED SLOTS (mapping/array values) need key/index context to identify

10. PROXY CONTRACTS: use implementation's layout, proxy's storage address
`);
