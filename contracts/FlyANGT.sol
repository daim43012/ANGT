// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * FlyANGT (ANGT) — простой ERC20 с фиксированным total supply.
 * Весь supply минтится один раз в constructor на treasury address.
 */
contract FlyANGT is ERC20, Ownable {
    uint256 public constant TOTAL_SUPPLY = 200_000_000 * 10 ** 18;

    constructor(address treasury) ERC20("FlyANGT", "ANGT") Ownable(msg.sender) {
        require(treasury != address(0), "treasury is zero");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
