// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * FlyANGT (ANGT) — ERC20 с фиксированным total supply.
 * Весь supply (500 000 000 ANGT) минтится один раз в constructor на treasury (Safe).
 * Owner также назначается на treasury — чтобы Safe управлял токеном.
 */
contract FlyANGT is ERC20, Ownable {
    uint256 public constant TOTAL_SUPPLY = 500_000_000 * 10 ** 18;

    constructor(address treasury) ERC20("FlyANGT", "ANGT") Ownable(treasury) {
        require(treasury != address(0), "treasury is zero");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
