// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * PresaleVestingMerkle
 *
 * Hybrid vesting vault for presale & OTC allocations with PER-USER vesting clock.
 *
 * Vesting:
 * - 3 years total, monthly discrete unlocks (36 steps) — ~2.78% per month.
 * - Month is defined as 30 days.
 * - Unlock is DISCRETE: month 0 => 0/36, month 1 => 1/36, ..., month 36 => 36/36.
 *
 * KEY: vesting clock starts when tokens are first credited to the user.
 *  - Merkle activation: vestingStartOf[user] = block.timestamp at activateMerkle.
 *  - First admin top-up:  vestingStartOf[user] = block.timestamp at addInvestor*.
 *  - Subsequent top-ups don't reset the clock — they just add to allocation.
 *  - This means an OTC investor added 5 months after TGE still waits 3 years
 *    from THEIR own start.
 *
 * Adding more tokens to an existing user:
 *  - claimable = vested(totalAllocation, theirElapsed) - claimed
 *  - so part of newly added wei becomes claimable for already-elapsed months.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PresaleVestingMerkle is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------
    // Constants
    // -------------------------
    uint256 public constant DECIMALS = 1e18;
    uint256 public constant MONTH = 30 days;
    uint256 public constant DURATION_MONTHS = 36;
    uint256 public constant DURATION = DURATION_MONTHS * MONTH;

    /// @notice Owner can sweep stuck tokens only after this delay from contract deploy.
    uint256 public constant ADMIN_WITHDRAW_DELAY = 30 days;

    // -------------------------
    // Storage
    // -------------------------
    IERC20 public immutable token;
    uint64 public immutable deployedAt;

    bytes32 public merkleRoot;
    bool public started;
    bool public rootFrozen;

    // Per-user vesting start (set on first allocation — merkle OR admin).
    mapping(address => uint64) public vestingStartOf;

    // Merkle allocation (one-time activation).
    mapping(address => bool) public merkleActivated;
    mapping(address => uint256) public merkleAllocationWei;

    // Admin-added allocation (additive).
    mapping(address => uint256) public adminAllocationWei;

    // Total claimed by user.
    mapping(address => uint256) public claimedWei;

    // -------------------------
    // Events
    // -------------------------
    event MerkleRootSet(bytes32 root);
    event Started(uint64 at);
    event RootFrozen(bytes32 root);

    event Funded(address indexed from, uint256 amountWei);

    event MerkleActivated(address indexed account, uint256 totalWei, uint64 vestingStart);
    event InvestorAdded(address indexed account, uint256 addedWei, uint64 vestingStart);

    event Claimed(address indexed account, uint256 amountWei, uint256 totalClaimedWei);
    event Swept(address indexed to, uint256 amountWei);

    // -------------------------
    // Constructor
    // -------------------------
    constructor(
        address tokenAddress,
        bytes32 initialRoot,
        address initialOwner
    ) Ownable(initialOwner) {
        require(tokenAddress != address(0), "token is zero");
        token = IERC20(tokenAddress);
        merkleRoot = initialRoot;
        deployedAt = uint64(block.timestamp);
    }

    // -------------------------
    // Admin: root & start
    // -------------------------
    function setMerkleRoot(bytes32 newRoot) external onlyOwner {
        require(!rootFrozen, "root frozen");
        merkleRoot = newRoot;
        emit MerkleRootSet(newRoot);
    }

    /// @notice Open the contract for activations and claims. Freezes the merkle root.
    function start() external onlyOwner {
        if (started) return;
        require(merkleRoot != bytes32(0), "root not set");
        started = true;
        rootFrozen = true;
        emit Started(uint64(block.timestamp));
        emit RootFrozen(merkleRoot);
    }

    // -------------------------
    // Admin: funding
    // -------------------------
    function fund(uint256 amountWei) external onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amountWei);
        emit Funded(msg.sender, amountWei);
    }

    // -------------------------
    // Admin: add investors manually
    // -------------------------
    function addInvestorWei(address account, uint256 amountWei) external onlyOwner {
        _addInvestor(account, amountWei);
    }

    function addInvestorHuman(address account, uint256 amountTokens) external onlyOwner {
        _addInvestor(account, amountTokens * DECIMALS);
    }

    function addInvestorsWei(address[] calldata accounts, uint256[] calldata amountsWei) external onlyOwner {
        require(accounts.length == amountsWei.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _addInvestor(accounts[i], amountsWei[i]);
        }
    }

    function addInvestorsHuman(address[] calldata accounts, uint256[] calldata amountTokens) external onlyOwner {
        require(accounts.length == amountTokens.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _addInvestor(accounts[i], amountTokens[i] * DECIMALS);
        }
    }

    function _addInvestor(address account, uint256 amountWei) internal {
        require(account != address(0), "zero addr");
        require(amountWei > 0, "zero amount");
        adminAllocationWei[account] += amountWei;

        // Start the per-user clock if this is the user's first allocation.
        uint64 start_ = vestingStartOf[account];
        if (start_ == 0) {
            start_ = uint64(block.timestamp);
            vestingStartOf[account] = start_;
        }

        emit InvestorAdded(account, amountWei, start_);
    }

    // -------------------------
    // Admin: fund + add atomically (one tx for OTC sales)
    // -------------------------
    /// @notice Pull `amountWei` ANGT from owner (Safe) into this contract AND
    ///         credit `account` via _addInvestor — in a single onlyOwner call.
    /// @dev Requires the caller (owner) to have ERC20-approved this contract
    ///      to spend `amountWei` (or more) of `token`.
    function fundAndAddInvestorWei(address account, uint256 amountWei) public onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amountWei);
        _addInvestor(account, amountWei);
        emit Funded(msg.sender, amountWei);
    }

    function fundAndAddInvestorHuman(address account, uint256 amountTokens) external onlyOwner {
        fundAndAddInvestorWei(account, amountTokens * DECIMALS);
    }

    function fundAndAddInvestorsWei(
        address[] calldata accounts,
        uint256[] calldata amountsWei
    ) external onlyOwner {
        require(accounts.length == amountsWei.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            fundAndAddInvestorWei(accounts[i], amountsWei[i]);
        }
    }

    function fundAndAddInvestorsHuman(
        address[] calldata accounts,
        uint256[] calldata amountTokens
    ) external onlyOwner {
        require(accounts.length == amountTokens.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            fundAndAddInvestorWei(accounts[i], amountTokens[i] * DECIMALS);
        }
    }

    // -------------------------
    // Merkle: activate allocation once
    // -------------------------
    /**
     * @notice Activate merkle allocation ONCE.
     * @param totalAllocationAmountWei Total presale allocation (wei).
     * @param proof Merkle proof.
     *
     * Leaf: keccak256(abi.encodePacked(address, totalAllocationAmountWei))
     */
    function activateMerkle(uint256 totalAllocationAmountWei, bytes32[] calldata proof) public {
        require(started, "not started");
        require(!merkleActivated[msg.sender], "already activated");
        require(merkleRoot != bytes32(0), "root not set");
        require(totalAllocationAmountWei > 0, "zero amount");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, totalAllocationAmountWei));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "invalid proof");

        merkleActivated[msg.sender] = true;
        merkleAllocationWei[msg.sender] = totalAllocationAmountWei;

        // Per-user vesting clock starts here if not started by an earlier admin add.
        uint64 start_ = vestingStartOf[msg.sender];
        if (start_ == 0) {
            start_ = uint64(block.timestamp);
            vestingStartOf[msg.sender] = start_;
        }

        emit MerkleActivated(msg.sender, totalAllocationAmountWei, start_);
    }

    /// @notice Convenience: activate if needed and claim in one tx.
    function activateAndClaim(uint256 totalAllocationAmountWei, bytes32[] calldata proof) external nonReentrant {
        if (!merkleActivated[msg.sender]) {
            activateMerkle(totalAllocationAmountWei, proof);
        }
        _claim(msg.sender);
    }

    // -------------------------
    // Vesting math (per-user clock, monthly discrete unlock)
    // -------------------------
    function totalAllocationWei(address account) public view returns (uint256) {
        return merkleAllocationWei[account] + adminAllocationWei[account];
    }

    function monthsElapsedOf(address account) public view returns (uint256) {
        uint64 start_ = vestingStartOf[account];
        if (start_ == 0 || block.timestamp < start_) return 0;
        uint256 elapsed = block.timestamp - uint256(start_);
        uint256 m = elapsed / MONTH;
        if (m > DURATION_MONTHS) return DURATION_MONTHS;
        return m;
    }

    function vestedWei(address account) public view returns (uint256) {
        uint256 total = totalAllocationWei(account);
        uint256 m = monthsElapsedOf(account);
        return (total * m) / DURATION_MONTHS;
    }

    function claimableWei(address account) public view returns (uint256) {
        uint256 v = vestedWei(account);
        uint256 c = claimedWei[account];
        if (v <= c) return 0;
        return v - c;
    }

    function nextUnlockAt(address account) public view returns (uint256) {
        uint64 start_ = vestingStartOf[account];
        if (start_ == 0) return 0;
        if (block.timestamp < start_) return uint256(start_) + MONTH;

        uint256 m = monthsElapsedOf(account);
        if (m >= DURATION_MONTHS) return 0;

        return uint256(start_) + (m + 1) * MONTH;
    }

    /// @notice One-call UI helper.
    function getAccountInfo(address account)
        external
        view
        returns (
            uint256 totalWei,
            uint256 vestedNowWei,
            uint256 claimedSoFarWei,
            uint256 claimableNowWei,
            uint256 monthsElapsedNow,
            uint64 vestingStart,
            uint256 nextUnlockTimestamp
        )
    {
        totalWei = totalAllocationWei(account);
        monthsElapsedNow = monthsElapsedOf(account);
        vestedNowWei = (totalWei * monthsElapsedNow) / DURATION_MONTHS;
        claimedSoFarWei = claimedWei[account];
        claimableNowWei = vestedNowWei > claimedSoFarWei ? (vestedNowWei - claimedSoFarWei) : 0;
        vestingStart = vestingStartOf[account];
        nextUnlockTimestamp = nextUnlockAt(account);
    }

    // -------------------------
    // Claim
    // -------------------------
    function claim() external nonReentrant {
        require(started, "not started");
        _claim(msg.sender);
    }

    function _claim(address account) internal {
        uint256 amt = claimableWei(account);
        require(amt > 0, "nothing to claim");

        claimedWei[account] += amt;
        token.safeTransfer(account, amt);

        emit Claimed(account, amt, claimedWei[account]);
    }

    // -------------------------
    // Admin: sweep stuck tokens
    // -------------------------
    /// @notice Withdraw tokens from contract. Locked for 30 days after deploy.
    function sweep(address to, uint256 amountWei) external onlyOwner {
        require(to != address(0), "zero addr");
        require(block.timestamp >= uint256(deployedAt) + ADMIN_WITHDRAW_DELAY, "admin withdraw locked");
        token.safeTransfer(to, amountWei);
        emit Swept(to, amountWei);
    }
}
