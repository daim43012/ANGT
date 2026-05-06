// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * AllocationRegistry
 *
 * Immutable on-chain record of how the FlyANGT supply was distributed at TGE.
 * Anyone (Polygonscan, frontend, auditors) can read the allocation map.
 *
 * Once deployed, the registry CANNOT be modified — it's a transparent witness
 * that "Owner got X, Devs got Y, Market makers got Z, Treasury holds the rest".
 *
 * Note: this contract does NOT move tokens. Actual transfers happen separately
 * from the Safe (treasury). Registry simply documents the intent and amounts.
 */
contract AllocationRegistry {
    struct Allocation {
        string  label;       // "Owner", "Devs", "Market makers", "Treasury", "Airdrop", "Presale Vesting"
        address recipient;   // wallet or contract that receives the allocation
        uint256 amountWei;   // ANGT amount in 1e18 units
        bool    vested;      // true if subject to vesting / locked
        string  note;        // optional context
    }

    address public immutable token;
    uint256 public immutable totalSupplyDocumented;
    uint64  public immutable createdAt;

    Allocation[] private _allocations;

    event AllocationRecorded(uint256 indexed index, string label, address indexed recipient, uint256 amountWei, bool vested);

    constructor(
        address tokenAddress,
        uint256 totalSupplyWei,
        Allocation[] memory entries
    ) {
        require(tokenAddress != address(0), "token is zero");
        require(entries.length > 0, "no entries");

        token = tokenAddress;
        totalSupplyDocumented = totalSupplyWei;
        createdAt = uint64(block.timestamp);

        uint256 sum = 0;
        for (uint256 i = 0; i < entries.length; i++) {
            Allocation memory a = entries[i];
            require(a.recipient != address(0), "zero recipient");
            require(a.amountWei > 0, "zero amount");
            sum += a.amountWei;

            _allocations.push(a);
            emit AllocationRecorded(i, a.label, a.recipient, a.amountWei, a.vested);
        }

        require(sum == totalSupplyWei, "sum != totalSupply");
    }

    function count() external view returns (uint256) {
        return _allocations.length;
    }

    function get(uint256 index) external view returns (Allocation memory) {
        require(index < _allocations.length, "out of range");
        return _allocations[index];
    }

    function all() external view returns (Allocation[] memory) {
        return _allocations;
    }
}
