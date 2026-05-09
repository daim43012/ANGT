// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Vesting (multi-cohort, daily unlock, UTC-aligned)
 *
 * Each addInvestor / fundAndAddInvestor creates an INDEPENDENT vesting cohort
 * for the recipient. Top-ups never modify or reset existing cohorts.
 *
 * Per-cohort rules:
 *   - 1080 days total (= 36 months × 30 days), linear daily unlock
 *   - cohort.startMidnightUtc = floor(block.timestamp / 1 day) * 1 day
 *     (today's UTC midnight at the moment of addition)
 *   - vested(c) = c.amount * daysElapsed / 1080, capped at amount
 *   - daysElapsed advances at 00:00 UTC for ALL cohorts simultaneously
 *
 * Account-level views aggregate across all cohorts. claim() iterates all
 * cohorts of msg.sender, pays out vested-but-unclaimed total, marks each.
 *
 * No merkle path — all allocations are admin-driven via Safe / owner address.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Vesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ===================================================================
    // Constants
    // ===================================================================
    uint256 public constant DECIMALS = 1e18;
    uint256 public constant DURATION_DAYS = 1080;
    /// @notice Owner can sweep stuck tokens only after this delay from deploy.
    uint256 public constant ADMIN_WITHDRAW_DELAY = 30 days;

    // ===================================================================
    // Storage
    // ===================================================================
    IERC20 public immutable token;
    uint64 public immutable deployedAt;
    bool public started;

    struct Cohort {
        uint64 startMidnightUtc; // 00:00 UTC of the cohort's start day
        uint128 amountWei;       // total cohort allocation
        uint128 claimedWei;      // already claimed from this cohort
    }

    mapping(address => Cohort[]) private _cohortsOf;

    // Append-only registry of unique investor addresses for off-chain enumeration.
    address[] private _investors;
    mapping(address => bool) private _isInvestor;

    // ===================================================================
    // Events
    // ===================================================================
    event Started(uint64 at);
    event Funded(address indexed from, uint256 amountWei);
    event InvestorAdded(
        address indexed account,
        uint256 indexed cohortIndex,
        uint256 amountWei,
        uint64 startMidnightUtc
    );
    event Claimed(address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    // ===================================================================
    // Constructor
    // ===================================================================
    constructor(address tokenAddress, address initialOwner) Ownable(initialOwner) {
        require(tokenAddress != address(0), "token zero");
        token = IERC20(tokenAddress);
        deployedAt = uint64(block.timestamp);
    }

    // ===================================================================
    // Admin: lifecycle
    // ===================================================================
    /// @notice Open the contract for claims. Idempotent.
    function start() external onlyOwner {
        if (started) return;
        started = true;
        emit Started(uint64(block.timestamp));
    }

    // ===================================================================
    // Admin: funding (without allocation)
    // ===================================================================
    /// @notice Pull `amountWei` ANGT from owner without creating a cohort.
    /// @dev Requires owner to have ERC20-approved this contract.
    function fund(uint256 amountWei) external onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amountWei);
        emit Funded(msg.sender, amountWei);
    }

    // ===================================================================
    // Admin: add investor (no funding, just bookkeeping)
    // ===================================================================
    function addInvestorWei(address account, uint256 amountWei) external onlyOwner {
        _addCohort(account, amountWei);
    }

    function addInvestorHuman(address account, uint256 amountTokens) external onlyOwner {
        _addCohort(account, amountTokens * DECIMALS);
    }

    function addInvestorsWei(
        address[] calldata accounts,
        uint256[] calldata amountsWei
    ) external onlyOwner {
        require(accounts.length == amountsWei.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _addCohort(accounts[i], amountsWei[i]);
        }
    }

    function addInvestorsHuman(
        address[] calldata accounts,
        uint256[] calldata amountTokens
    ) external onlyOwner {
        require(accounts.length == amountTokens.length, "len mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            _addCohort(accounts[i], amountTokens[i] * DECIMALS);
        }
    }

    // ===================================================================
    // Admin: fund + add atomically (one tx for OTC sales)
    // ===================================================================
    /// @notice Pull tokens from owner AND create a fresh cohort for `account`.
    /// @dev Requires owner to have ERC20-approved this contract for `amountWei`+.
    function fundAndAddInvestorWei(address account, uint256 amountWei) public onlyOwner {
        token.safeTransferFrom(msg.sender, address(this), amountWei);
        _addCohort(account, amountWei);
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

    function _addCohort(address account, uint256 amountWei) internal {
        require(account != address(0), "zero addr");
        require(amountWei > 0, "zero amount");
        require(amountWei <= type(uint128).max, "amount too large");

        // Floor to today's UTC midnight.
        uint64 startMidnight = uint64((block.timestamp / 1 days) * 1 days);

        _cohortsOf[account].push(
            Cohort({
                startMidnightUtc: startMidnight,
                amountWei: uint128(amountWei),
                claimedWei: 0
            })
        );

        if (!_isInvestor[account]) {
            _isInvestor[account] = true;
            _investors.push(account);
        }

        emit InvestorAdded(
            account,
            _cohortsOf[account].length - 1,
            amountWei,
            startMidnight
        );
    }

    // ===================================================================
    // Admin: sweep (recover stuck tokens, locked for 30 days post-deploy)
    // ===================================================================
    function sweep(address to, uint256 amountWei) external onlyOwner {
        require(to != address(0), "zero addr");
        require(
            block.timestamp >= uint256(deployedAt) + ADMIN_WITHDRAW_DELAY,
            "admin withdraw locked"
        );
        token.safeTransfer(to, amountWei);
        emit Swept(to, amountWei);
    }

    // ===================================================================
    // Math
    // ===================================================================
    function _vestedWeiOfCohort(Cohort memory c) internal view returns (uint256) {
        if (block.timestamp < uint256(c.startMidnightUtc)) return 0;
        uint256 elapsed = block.timestamp - uint256(c.startMidnightUtc);
        uint256 d = elapsed / 1 days;
        if (d >= DURATION_DAYS) return uint256(c.amountWei);
        return (uint256(c.amountWei) * d) / DURATION_DAYS;
    }

    // ===================================================================
    // Views: cohorts (positions)
    // ===================================================================
    function cohortCount(address account) external view returns (uint256) {
        return _cohortsOf[account].length;
    }

    function cohortAt(address account, uint256 i) external view returns (Cohort memory) {
        require(i < _cohortsOf[account].length, "index out of range");
        return _cohortsOf[account][i];
    }

    /// @notice Returns ALL cohorts for `account`. May be expensive for large N — prefer cohortAt for paged UI.
    function cohortsOf(address account) external view returns (Cohort[] memory) {
        return _cohortsOf[account];
    }

    /// @notice Detailed per-cohort info for UI rendering.
    function cohortInfoAt(address account, uint256 i)
        external
        view
        returns (
            uint64 startMidnightUtc,
            uint256 amountWei,
            uint256 claimedFromCohortWei,
            uint256 vestedFromCohortWei,
            uint256 claimableFromCohortWei,
            uint256 daysElapsed
        )
    {
        require(i < _cohortsOf[account].length, "index out of range");
        Cohort memory c = _cohortsOf[account][i];
        startMidnightUtc = c.startMidnightUtc;
        amountWei = uint256(c.amountWei);
        claimedFromCohortWei = uint256(c.claimedWei);
        vestedFromCohortWei = _vestedWeiOfCohort(c);
        claimableFromCohortWei = vestedFromCohortWei > claimedFromCohortWei
            ? vestedFromCohortWei - claimedFromCohortWei
            : 0;
        if (block.timestamp >= uint256(c.startMidnightUtc)) {
            uint256 d = (block.timestamp - uint256(c.startMidnightUtc)) / 1 days;
            daysElapsed = d > DURATION_DAYS ? DURATION_DAYS : d;
        }
    }

    // ===================================================================
    // Views: account-level totals (sum across cohorts)
    // ===================================================================
    function totalAllocationWei(address account) public view returns (uint256 sum) {
        Cohort[] storage cs = _cohortsOf[account];
        for (uint256 i = 0; i < cs.length; i++) sum += uint256(cs[i].amountWei);
    }

    function vestedWei(address account) public view returns (uint256 sum) {
        Cohort[] storage cs = _cohortsOf[account];
        for (uint256 i = 0; i < cs.length; i++) sum += _vestedWeiOfCohort(cs[i]);
    }

    function claimedWei(address account) public view returns (uint256 sum) {
        Cohort[] storage cs = _cohortsOf[account];
        for (uint256 i = 0; i < cs.length; i++) sum += uint256(cs[i].claimedWei);
    }

    function claimableWei(address account) public view returns (uint256) {
        uint256 v = vestedWei(account);
        uint256 c = claimedWei(account);
        return v > c ? v - c : 0;
    }

    /// @notice One-call UI helper.
    function getAccountInfo(address account)
        external
        view
        returns (
            uint256 cohortsCount,
            uint256 totalWei,
            uint256 vestedNowWei,
            uint256 claimedSoFarWei,
            uint256 claimableNowWei
        )
    {
        Cohort[] storage cs = _cohortsOf[account];
        cohortsCount = cs.length;
        for (uint256 i = 0; i < cs.length; i++) {
            totalWei += uint256(cs[i].amountWei);
            vestedNowWei += _vestedWeiOfCohort(cs[i]);
            claimedSoFarWei += uint256(cs[i].claimedWei);
        }
        claimableNowWei = vestedNowWei > claimedSoFarWei
            ? vestedNowWei - claimedSoFarWei
            : 0;
    }

    // ===================================================================
    // Views: investor registry (admin enumeration)
    // ===================================================================
    function investorCount() external view returns (uint256) {
        return _investors.length;
    }

    function investorAt(uint256 i) external view returns (address) {
        require(i < _investors.length, "index out of range");
        return _investors[i];
    }

    function isInvestor(address account) external view returns (bool) {
        return _isInvestor[account];
    }

    /// @notice Page through investors for off-chain enumeration without unbounded gas.
    function investorsPaginated(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page)
    {
        uint256 n = _investors.length;
        if (offset >= n) return new address[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = _investors[offset + i];
        }
    }

    // ===================================================================
    // User: claim across all cohorts
    // ===================================================================
    function claim() external nonReentrant {
        require(started, "not started");
        Cohort[] storage cs = _cohortsOf[msg.sender];
        uint256 total = 0;
        for (uint256 i = 0; i < cs.length; i++) {
            uint256 vested = _vestedWeiOfCohort(cs[i]);
            uint256 already = uint256(cs[i].claimedWei);
            if (vested > already) {
                uint256 due = vested - already;
                cs[i].claimedWei = uint128(already + due);
                total += due;
            }
        }
        require(total > 0, "nothing to claim");
        token.safeTransfer(msg.sender, total);
        emit Claimed(msg.sender, total);
    }
}
