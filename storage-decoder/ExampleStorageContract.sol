// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Example contract demonstrating various storage layout patterns.
 * Used for testing the storage slot decoder.
 *
 * This contract is intentionally designed to showcase:
 * - Packed variables in a single slot
 * - Struct packing
 * - Nested structs
 * - Mappings of structs
 * - Dynamic arrays of structs
 * - Nested mappings
 * - String/bytes storage
 * - Enums
 * - Inheritance
 */

contract Owned {
    address public owner;       // slot 0, offset 0, 20 bytes
    bool public initialized;    // slot 0, offset 20, 1 byte (PACKED with owner!)
}

contract ExampleStorage is Owned {
    // ─── Enums ───────────────────────────────────────────
    enum OrderStatus { Open, Filled, Cancelled, Expired }
    enum Side { Buy, Sell }

    // ─── Structs ─────────────────────────────────────────

    // Tightly packed struct (all fit in 1 slot)
    struct FeeConfig {
        uint64  makerFee;     // 8 bytes, slot +0, offset 0
        uint64  takerFee;     // 8 bytes, slot +0, offset 8
        uint32  rebateBps;    // 4 bytes, slot +0, offset 16
        bool    feesEnabled;  // 1 byte,  slot +0, offset 20
        // Total: 21 bytes → 1 slot
    }

    // Multi-slot packed struct
    struct Order {
        address maker;          // 20 bytes, slot +0, offset 0
        uint64  expiry;         // 8 bytes,  slot +0, offset 20 (packed!)
        Side    side;           // 1 byte,   slot +0, offset 28 (packed! enum=uint8)
        bool    filled;         // 1 byte,   slot +0, offset 29 (packed!)
        // slot +0 total: 30 bytes (2 bytes wasted)

        uint256 amount;         // 32 bytes, slot +1, offset 0

        uint128 price;          // 16 bytes, slot +2, offset 0
        uint128 filledAmount;   // 16 bytes, slot +2, offset 16 (packed!)

        bytes32 orderHash;      // 32 bytes, slot +3, offset 0
    }
    // Total: 4 slots per Order

    // Struct containing another struct (nested)
    struct UserProfile {
        address     user;         // 20 bytes, slot +0, offset 0
        uint32      nonce;        // 4 bytes,  slot +0, offset 20 (packed!)
        bool        active;       // 1 byte,   slot +0, offset 24 (packed!)

        FeeConfig   customFees;   // 1 slot,   slot +1 (struct starts new slot)

        uint256     totalVolume;  // 32 bytes, slot +2, offset 0

        string      username;     // dynamic,  slot +3
    }
    // Total: 4 slots per UserProfile

    // ─── State Variables ─────────────────────────────────

    // Inherited: owner (slot 0, offset 0), initialized (slot 0, offset 20)

    // Slot 1: totalOrders (uint256, 32 bytes)
    uint256 public totalOrders;

    // Slot 2: feeConfig (FeeConfig struct, 1 slot)
    FeeConfig public feeConfig;

    // Slot 3: globalStatus packed
    OrderStatus public globalStatus;  // 1 byte, slot 3, offset 0
    uint8 public version;             // 1 byte, slot 3, offset 1
    uint16 public maxOrdersPerUser;   // 2 bytes, slot 3, offset 2
    address public feeRecipient;      // 20 bytes, slot 3, offset 4
    // Total: 24 bytes packed in slot 3

    // Slot 4: description (string, dynamic)
    string public description;

    // Slot 5: orders mapping
    mapping(uint256 => Order) public orders;

    // Slot 6: userProfiles mapping
    mapping(address => UserProfile) public userProfiles;

    // Slot 7: orderHistory dynamic array
    Order[] public orderHistory;

    // Slot 8: allowances nested mapping
    mapping(address => mapping(address => uint256)) public allowances;

    // Slot 9: balances mapping
    mapping(address => uint256) public balances;

    // Slot 10: fixedArray (fixed-size array, inline)
    uint128[4] public fixedPrices;

    // Slot 12: smallData (bytes, dynamic)
    bytes public smallData;

    // ─── Functions for populating test data ──────────────

    function initialize(
        address _owner,
        address _feeRecipient,
        string calldata _description
    ) external {
        owner = _owner;
        initialized = true;
        feeRecipient = _feeRecipient;
        description = _description;
        version = 1;
        maxOrdersPerUser = 100;
        globalStatus = OrderStatus.Open;
    }

    function setFeeConfig(
        uint64 _makerFee,
        uint64 _takerFee,
        uint32 _rebateBps,
        bool _feesEnabled
    ) external {
        feeConfig = FeeConfig(_makerFee, _takerFee, _rebateBps, _feesEnabled);
    }

    function createOrder(
        uint64 _expiry,
        Side _side,
        uint256 _amount,
        uint128 _price,
        bytes32 _orderHash
    ) external returns (uint256 orderId) {
        orderId = totalOrders++;
        orders[orderId] = Order({
            maker: msg.sender,
            expiry: _expiry,
            side: _side,
            filled: false,
            amount: _amount,
            price: _price,
            filledAmount: 0,
            orderHash: _orderHash
        });
        orderHistory.push(orders[orderId]);
    }

    function fillOrder(uint256 _orderId, uint128 _fillAmount) external {
        Order storage order = orders[_orderId];
        order.filledAmount += _fillAmount;
        if (order.filledAmount >= order.price) {
            order.filled = true;
        }
    }

    function setUserProfile(
        address _user,
        uint32 _nonce,
        FeeConfig calldata _fees,
        string calldata _username
    ) external {
        userProfiles[_user] = UserProfile({
            user: _user,
            nonce: _nonce,
            active: true,
            customFees: _fees,
            totalVolume: 0,
            username: _username
        });
    }

    function setAllowance(address _from, address _to, uint256 _amount) external {
        allowances[_from][_to] = _amount;
    }

    function setBalance(address _user, uint256 _amount) external {
        balances[_user] = _amount;
    }

    function setFixedPrice(uint256 _index, uint128 _price) external {
        fixedPrices[_index] = _price;
    }

    function setSmallData(bytes calldata _data) external {
        smallData = _data;
    }
}
