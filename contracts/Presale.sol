// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);
}

abstract contract Ownable {
    address public owner;

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    error NotOwner();

    constructor(address initialOwner) {
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}

abstract contract ReentrancyGuard {
    uint256 private _status = 1;
    error Reentrancy();

    modifier nonReentrant() {
        if (_status != 1) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }
}

abstract contract Pausable is Ownable {
    bool public paused;

    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error PausedError();

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }
}

contract PresaleTimeWeeks is Pausable, ReentrancyGuard {
    // --------- config ---------
    mapping(address => bool) public isPayToken;
    address public treasury;

    // Presale window
    uint64 public startTime; // unix time
    uint64 public endTime; // unix time (0 = no end)
    uint32 public weekDuration; // seconds (обычно 7 days)

    // Week override (ручной контроль, если надо "заморозить" неделю)
    bool public weekOverrideEnabled;
    uint32 public weekOverride; // 1..N

    // Price per week in micro-USD (1e6)
    // week starts at 1
    uint256[] private _priceByWeekMicro;

    // Total sold in token wei (1e18)
    uint256 public totalSoldWei;
    uint256 public constant MAX_TOKENS_WEI = 250_000_000 * 1e18;

    // --------- events ---------
    event Purchased(
        address indexed buyer,
        address indexed payToken,
        uint256 payAmount, // 6 decimals (micro USDT/USDC)
        uint256 tokenAmountWei, // 18 decimals (ANGT wei)
        uint256 weekRef,
        uint256 priceRef
    );

    event TreasuryUpdated(
        address indexed oldTreasury,
        address indexed newTreasury
    );
    event PayTokenUpdated(address indexed token, bool allowed);

    event WindowUpdated(uint64 startTime, uint64 endTime);
    event WeekDurationUpdated(uint32 oldDuration, uint32 newDuration);

    event WeekOverrideUpdated(bool enabled, uint32 week);
    event PriceSet(uint32 indexed week, uint256 priceUsdMicro);
    event PriceAppended(uint32 indexed week, uint256 priceUsdMicro);

    // --------- errors ---------
    error ZeroAddress();
    error InvalidToken();
    error InvalidAmount();
    error InvalidPrice();
    error TooSmall();
    error NotActive();
    error BadTime();
    error TransferFailed();
    error NoPrices();
    error CapExceeded();

    constructor(
        address usdt,
        address usdc,
        address treasury_,
        uint64 startTime_,
        uint64 endTime_,
        uint32 weekDuration_,
        uint256[] memory pricesMicro // prices for week1..weekN in micro-USD
    ) Ownable(msg.sender) {
        if (usdt == address(0) || usdc == address(0) || treasury_ == address(0))
            revert ZeroAddress();
        if (weekDuration_ == 0) revert InvalidAmount();
        if (pricesMicro.length == 0) revert NoPrices();

        uint64 effectiveStart = startTime_ == 0
            ? uint64(block.timestamp)
            : startTime_;

        if (endTime_ != 0 && endTime_ <= effectiveStart) revert BadTime();

        isPayToken[usdt] = true;
        isPayToken[usdc] = true;

        treasury = treasury_;
        startTime = effectiveStart;
        endTime = endTime_;
        weekDuration = weekDuration_;

        for (uint256 i = 0; i < pricesMicro.length; i++) {
            if (pricesMicro[i] == 0) revert InvalidPrice();
            _priceByWeekMicro.push(pricesMicro[i]);
            emit PriceAppended(uint32(i + 1), pricesMicro[i]);
        }

        emit PayTokenUpdated(usdt, true);
        emit PayTokenUpdated(usdc, true);
        emit TreasuryUpdated(address(0), treasury_);
        emit WindowUpdated(effectiveStart, endTime_);
        emit WeekDurationUpdated(0, weekDuration_);
    }

    // ---------- admin ----------
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setPayToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        isPayToken[token] = allowed;
        emit PayTokenUpdated(token, allowed);
    }

    function setWindow(
        uint64 newStartTime,
        uint64 newEndTime
    ) external onlyOwner {
        if (newStartTime == 0) revert BadTime();
        if (newEndTime != 0 && newEndTime <= newStartTime) revert BadTime();
        startTime = newStartTime;
        endTime = newEndTime;
        emit WindowUpdated(newStartTime, newEndTime);
    }

    function setWeekDuration(uint32 newDuration) external onlyOwner {
        if (newDuration == 0) revert InvalidAmount();
        emit WeekDurationUpdated(weekDuration, newDuration);
        weekDuration = newDuration;
    }

    /// @notice Заморозить неделю (и цену) вручную.
    /// enabled=true: currentWeek() вернёт weekOverride
    function setWeekOverride(bool enabled, uint32 week_) external onlyOwner {
        if (enabled) {
            if (week_ == 0) revert InvalidAmount();
            weekOverride = week_;
        }
        weekOverrideEnabled = enabled;
        emit WeekOverrideUpdated(enabled, weekOverride);
    }

    /// @notice Установить цену конкретной недели (1..N). Можно править расписание.
    function setPriceForWeek(
        uint32 week,
        uint256 priceMicro
    ) external onlyOwner {
        if (week == 0) revert InvalidAmount();
        if (priceMicro == 0) revert InvalidPrice();

        uint256 idx = uint256(week - 1);
        if (idx >= _priceByWeekMicro.length) revert InvalidAmount();

        _priceByWeekMicro[idx] = priceMicro;
        emit PriceSet(week, priceMicro);
    }

    /// @notice Добавить новую неделю в конец (продление пресейла по той же/новой цене).
    function appendWeekPrice(uint256 priceMicro) external onlyOwner {
        if (priceMicro == 0) revert InvalidPrice();
        _priceByWeekMicro.push(priceMicro);
        emit PriceAppended(uint32(_priceByWeekMicro.length), priceMicro);
    }

    /// @notice Быстро закрыть пресейл: pause + endTime = now.
    function closePresale() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
        endTime = uint64(block.timestamp);
        emit WindowUpdated(startTime, endTime);
    }

    // ---------- views ----------
    function pricesLength() external view returns (uint256) {
        return _priceByWeekMicro.length;
    }

    function priceForWeek(
        uint32 week
    ) public view returns (uint256 priceMicro) {
        if (week == 0) return 0;
        uint256 idx = uint256(week - 1);
        if (idx >= _priceByWeekMicro.length) {
            // после последней недели держим последнюю цену
            return _priceByWeekMicro[_priceByWeekMicro.length - 1];
        }
        return _priceByWeekMicro[idx];
    }

    function isActive() public view returns (bool) {
        if (paused) return false;
        if (block.timestamp < startTime) return false;
        if (endTime != 0 && block.timestamp > endTime) return false;
        return true;
    }

    function currentWeek() public view returns (uint32 week) {
        if (weekOverrideEnabled) return weekOverride;

        if (block.timestamp < startTime) return 0;
        uint256 elapsed = block.timestamp - uint256(startTime);
        uint256 w = (elapsed / uint256(weekDuration)) + 1;
        if (w > type(uint32).max) return type(uint32).max;
        return uint32(w);
    }

    function currentPriceUsdMicro() public view returns (uint256) {
        uint32 w = currentWeek();
        if (w == 0) return 0;
        return priceForWeek(w);
    }

    /// @notice Quote tokens in wei (1e18) for a given payAmount (6 decimals).
    function quote(
        uint256 payAmount
    ) external view returns (uint256 tokenAmountWei) {
        uint256 p = currentPriceUsdMicro();
        if (payAmount == 0 || p == 0) return 0;
        return (payAmount * 1e18) / p;
    }

    // ---------- main ----------
    function buy(
        address payToken,
        uint256 payAmount
    ) external nonReentrant whenNotPaused returns (uint256 tokenAmountWei) {
        if (!isPayToken[payToken]) revert InvalidToken();
        if (payAmount == 0) revert InvalidAmount();
        if (!isActive()) revert NotActive();

        uint32 w = currentWeek();
        uint256 p = priceForWeek(w);
        if (p == 0) revert InvalidPrice();

        uint256 tokensWei = (payAmount * 1e18) / p;
        if (tokensWei == 0) revert TooSmall();
        if (totalSoldWei + tokensWei > MAX_TOKENS_WEI) revert CapExceeded();

        // Сразу отправляем оплату в treasury (Safe)
        _safeTransferFrom(payToken, msg.sender, treasury, payAmount);

        totalSoldWei += tokensWei;

        emit Purchased(
            msg.sender,
            payToken,
            payAmount,
            tokensWei,
            uint256(w),
            p
        );
        return tokensWei;
    }

    // ---------- safe token helpers ----------
    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        // supports tokens that return bool OR return nothing (USDT-like)
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(
                IERC20.transferFrom.selector,
                from,
                to,
                amount
            )
        );
        if (!ok) revert TransferFailed();
        if (data.length > 0) {
            if (!abi.decode(data, (bool))) revert TransferFailed();
        }
    }
}
