// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RwaYieldVault} from "../src/RwaYieldVault.sol";

contract DeployRwaVault is Script {
    function run() external returns (RwaYieldVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS");

        vm.startBroadcast(deployerKey);
        vault = new RwaYieldVault(IERC20(usdc), keeper);
        vm.stopBroadcast();

        console2.log("RwaYieldVault deployed:", address(vault));
        console2.log("USDC asset:", usdc);
        console2.log("Designated keeper:", keeper);
    }
}
