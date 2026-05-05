// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MerkleAirdrop is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;

    bytes32 public merkleRoot;

    uint64 public immutable startTime;
    uint64 public immutable endTime;
    uint256 public constant ADMIN_WITHDRAW_DELAY = 30 days;

    bool public started;
    bool public rootFrozen;

    mapping(address => bool) public claimed;

    event MerkleRootSet(bytes32 root);
    event Started(uint64 at);
    event RootFrozen(bytes32 root);
    event Claimed(address indexed account, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    constructor(
        address tokenAddress,
        bytes32 initialRoot,
        uint64 _startTime,
        uint64 _endTime,
        address initialOwner
    ) Ownable(initialOwner) {
        require(tokenAddress != address(0), "token is zero");
        require(_endTime == 0 || _endTime > _startTime, "bad time");
        token = IERC20(tokenAddress);
        merkleRoot = initialRoot;
        startTime = _startTime;
        endTime = _endTime;
    }

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

    function claim(
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        require(started, "not started");
        require(endTime == 0 || block.timestamp <= endTime, "ended");
        require(!claimed[msg.sender], "already claimed");

        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(proof, merkleRoot, leaf), "invalid proof");

        claimed[msg.sender] = true;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function sweep(address to, uint256 amount) external onlyOwner {
        require(started, "not started");
        require(
            block.timestamp >= startTime + ADMIN_WITHDRAW_DELAY,
            "admin withdraw locked"
        );
        token.safeTransfer(to, amount);
    }
}
