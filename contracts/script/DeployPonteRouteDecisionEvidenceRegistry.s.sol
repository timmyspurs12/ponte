// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PonteRouteDecisionEvidenceRegistry} from "../src/PonteRouteDecisionEvidenceRegistry.sol";

/// @dev Minimal Foundry cheatcode surface required by this deployment script.
/// The script deliberately accepts no private key or credential argument.
interface VmRegistryDeployment {
    function envOr(string calldata name, address defaultValue) external returns (address value);

    function startBroadcast() external;

    function stopBroadcast() external;
}

/// @title DeployPonteRouteDecisionEvidenceRegistry
/// @notice Later operator-run Arbitrum Sepolia deployment script for the immutable V1 registry.
/// @dev This script contains no key, address, RPC endpoint, or synthetic-registry fallback.
contract DeployPonteRouteDecisionEvidenceRegistry {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

    error UnsupportedDeploymentChain(uint256 actualChainId);
    error AdministratorAddressRequired();
    error InitialAttestorAddressRequired();
    error AdministratorAndAttestorMustDiffer(address sharedAddress);

    VmRegistryDeployment private constant vm =
        VmRegistryDeployment(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Validates the active EVM chain and registry constructor roles before broadcast.
    /// @dev Public to make the no-network deployment preconditions directly unit-testable.
    function validateConfiguration(address administrator, address initialAttestor) public view {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) {
            revert UnsupportedDeploymentChain(block.chainid);
        }
        if (administrator == address(0)) revert AdministratorAddressRequired();
        if (initialAttestor == address(0)) revert InitialAttestorAddressRequired();
        if (administrator == initialAttestor) {
            revert AdministratorAndAttestorMustDiffer(administrator);
        }
    }

    /// @notice Reads the two required constructor addresses from the operator environment.
    /// @dev Missing variables become address(0), then receive explicit configuration errors.
    function configurationFromEnvironment() public returns (address administrator, address initialAttestor) {
        administrator = vm.envOr("PONTE_REGISTRY_ADMIN", address(0));
        initialAttestor = vm.envOr("PONTE_REGISTRY_INITIAL_ATTESTOR", address(0));
        validateConfiguration(administrator, initialAttestor);
    }

    /// @notice Deploys only after all configuration guards have passed.
    /// @dev Foundry chooses the broadcaster externally, for example through an operator-managed account.
    function run() external returns (PonteRouteDecisionEvidenceRegistry registry) {
        (address administrator, address initialAttestor) = configurationFromEnvironment();

        vm.startBroadcast();
        registry = new PonteRouteDecisionEvidenceRegistry(administrator, initialAttestor);
        vm.stopBroadcast();
    }
}
