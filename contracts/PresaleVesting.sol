// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * PresaleVestingMerkle
 *
 * Hybrid vesting vault for presale allocations:
 * - Merkle-based initial presale list (separate from your airdrop list/root)
 * - Manual admin top-ups for OTC / post-listing investors
 *
 * Vesting:
 * - 3 years, monthly unlocks (36 steps)
 * - Month is defined as 30 days (standard on-chain approximation)
 * - Unlock is DISCRETE by months: month 0 => 0/36, month 1 => 1/36, ..., month 36 => 36/36
 *
 * Key behavior (your requirement):
 * - If an investor already claimed for month 1, and then you add more tokens,
 *   the newly added tokens immediately become partially claimable for the already elapsed months.
 *   This is achieved by: claimable = vested(totalAllocation) - claimed
 *
 * Merkle activation:
 * - User activates their merkle allocation ONCE by providing (totalTokensHuman, proof).
 * - Contract stores the allocation in wei so later claims don't need proof.
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

    // Optional safety lock for admin sweep
    uint256 public constant ADMIN_WITHDRAW_DELAY = 30 days;

    // -------------------------
    // Storage
    // -------------------------
    IERC20 public immutable token;

    bytes32 public merkleRoot;

    /// @dev Vesting starts at this timestamp.
    /// If you prefer "startTime = block.timestamp at start()", I can adapt, but this version uses a fixed startTime.
    uint64 public immutable startTime;

    bool public started;
    bool public rootFrozen;

    // Merkle allocations (activated once)
    mapping(address => bool) public merkleActivated;
    mapping(address => uint256) public merkleAllocationWei;

    // Admin-added allocations (can be increased multiple times)
    mapping(address => uint256) public adminAllocationWei;

    // Total claimed so far (covers both merkle + admin portions)
    mapping(address => uint256) public claimedWei;

    // -------------------------
    // Events
    // -------------------------
    event MerkleRootSet(bytes32 root);
    event Started(uint64 at);
    event RootFrozen(bytes32 root);

    event Funded(address indexed from, uint256 amountWei);

    event MerkleActivated(address indexed account, uint256 totalWei);
    event InvestorAdded(address indexed account, uint256 addedWei);

    event Claimed(address indexed account, uint256 amountWei, uint256 totalClaimedWei);

    event Swept(address indexed to, uint256 amountWei);

    // -------------------------
    // Constructor
    // -------------------------
    constructor(
        address tokenAddress,
        bytes32 initialRoot,
        uint64 _startTime,
        address initialOwner
    ) Ownable(initialOwner) {
        require(tokenAddress != address(0), "token is zero");
        token = IERC20(tokenAddress);
        merkleRoot = initialRoot;
        startTime = _startTime;
    }

    // -------------------------
    // Admin: root & start
    // -------------------------
    function setMerkleRoot(bytes32 newRoot) external onlyOwner {
        require(!rootFrozen, "root frozen");
        merkleRoot = newRoot;
        emit MerkleRootSet(newRoot);
    }

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
    /**
     * @notice Pull tokens from owner into this contract (owner must approve first).
     * Alternative: you can just ERC20.transfer() directly to this contract address.
     */
    function fund(uint256 amountWei) external onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amountWei);
        emit Funded(msg.sender, amountWei);
    }

    // -------------------------
    // Admin: add investors manually (human amounts)
    // -------------------------
    /**
     * @notice Add allocation in "human tokens" (e.g. 1500 means 1500.0 tokens for 18 decimals token).
     * This is additive: repeated calls increase allocation.
     *
     * Behavior you wanted:
     * - If months already elapsed, part of this newly added amount becomes immediately claimable
     *   because vested() uses totalAllocation and claimable = vested - claimed.
     */
    function addInvestorHuman(address account, uint256 amountTokens) external onlyOwner {
        require(account != address(0), "zero addr");
        uint256 amountWei = amountTokens * DECIMALS;
        adminAllocationWei[account] += amountWei;
        emit InvestorAdded(account, amountWei);
    }

    function addInvestorsHuman(address[] calldata accounts, uint256[] calldata amountTokens) external onlyOwner {
        require(accounts.length == amountTokens.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            address a = accounts[i];
            require(a != address(0), "zero addr");
            uint256 amountWei = amountTokens[i] * DECIMALS;
            adminAllocationWei[a] += amountWei;
            emit InvestorAdded(a, amountWei);
        }
    }

    // -------------------------
    // Merkle: activate allocation once
    // -------------------------
    /**
     * @notice Activate merkle allocation ONCE.
     * @param totalTokensHuman Total presale allocation in human units (as in presale/claims.json).
     * @param proof Merkle proof for (msg.sender, totalWei).
     */
    function activateMerkle(uint256 totalTokensHuman, bytes32[] calldata proof) public {
        require(started, "not started");
        require(block.timestamp >= startTime, "vesting not started");
        require(!merkleActivated[msg.sender], "already activated");
        require(merkleRoot != bytes32(0), "root not set");

        uint256 totalWei = totalTokensHuman * DECIMALS;

        // leaf must match your buildMerkle.ts logic:
        // solidityPackedKeccak256(["address","uint256"], [address, amountWei])
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, totalWei));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "invalid proof");

        merkleActivated[msg.sender] = true;
        merkleAllocationWei[msg.sender] = totalWei;

        emit MerkleActivated(msg.sender, totalWei);
    }

    /**
     * @notice Convenience: activate if needed and claim in one tx.
     */
    function activateAndClaim(uint256 totalTokensHuman, bytes32[] calldata proof) external nonReentrant {
        if (!merkleActivated[msg.sender]) {
            activateMerkle(totalTokensHuman, proof);
        }
        _claim(msg.sender);
    }

    // -------------------------
    // Vesting math (monthly unlock)
    // -------------------------
    function totalAllocationWei(address account) public view returns (uint256) {
        return merkleAllocationWei[account] + adminAllocationWei[account];
    }

    function monthsElapsed() public view returns (uint256) {
        if (block.timestamp < startTime) return 0;
        uint256 elapsed = block.timestamp - startTime;
        uint256 m = elapsed / MONTH;
        if (m > DURATION_MONTHS) return DURATION_MONTHS;
        return m;
    }

    /**
     * @notice Total vested amount (discrete monthly unlock).
     */
    function vestedWei(address account) public view returns (uint256) {
        uint256 total = totalAllocationWei(account);
        uint256 m = monthsElapsed();
        return (total * m) / DURATION_MONTHS;
    }

    function claimableWei(address account) public view returns (uint256) {
        uint256 v = vestedWei(account);
        uint256 c = claimedWei[account];
        if (v <= c) return 0;
        return v - c;
    }

    /**
     * @notice Timestamp of the next unlock boundary (helpful for UI).
     * Returns 0 if vesting not started yet (block.timestamp < startTime) or fully vested.
     */
    function nextUnlockAt() public view returns (uint256) {
        if (block.timestamp < startTime) return 0;

        uint256 m = monthsElapsed();
        if (m >= DURATION_MONTHS) return 0;

        // next boundary is startTime + (m+1)*MONTH
        return uint256(startTime) + (m + 1) * MONTH;
    }

    /**
     * @notice One-call UI helper.
     */
    function getAccountInfo(address account)
        external
        view
        returns (
            uint256 totalWei,
            uint256 vestedNowWei,
            uint256 claimedSoFarWei,
            uint256 claimableNowWei,
            uint256 monthsElapsedNow,
            uint256 nextUnlockTimestamp
        )
    {
        totalWei = totalAllocationWei(account);
        monthsElapsedNow = monthsElapsed();
        vestedNowWei = (totalWei * monthsElapsedNow) / DURATION_MONTHS;
        claimedSoFarWei = claimedWei[account];
        claimableNowWei = vestedNowWei > claimedSoFarWei ? (vestedNowWei - claimedSoFarWei) : 0;
        nextUnlockTimestamp = nextUnlockAt();
    }

    // -------------------------
    // Claim
    // -------------------------
    function claim() external nonReentrant {
        require(started, "not started");
        require(block.timestamp >= startTime, "vesting not started");
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
    // Admin: sweep
    // -------------------------
    /**
     * @notice Withdraw tokens from the contract.
     * Safety lock: at least 30 days after startTime.
     * If you want stricter: require(block.timestamp >= startTime + DURATION).
     */
    function sweep(address to, uint256 amountWei) external onlyOwner {
        require(started, "not started");
        require(to != address(0), "zero addr");
        require(block.timestamp >= startTime + ADMIN_WITHDRAW_DELAY, "admin withdraw locked");

        token.safeTransfer(to, amountWei);
        emit Swept(to, amountWei);
    }
}
