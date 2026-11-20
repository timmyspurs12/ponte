// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {DeployPonteRouteDecisionEvidenceRegistry} from "../script/DeployPonteRouteDecisionEvidenceRegistry.s.sol";

interface VmDeploymentTest {
    function chainId(uint256 newChainId) external;

    function expectRevert(bytes4 revertData) external;

    function expectRevert(bytes calldata revertData) external;
}

/// @dev Unit tests for the deployment script's configuration guard only.
/// No test invokes run(), starts a broadcast, creates a signer, or contacts an RPC endpoint.
contract DeployPonteRouteDecisionEvidenceRegistryTest {
    error AssertionFailed();

    VmDeploymentTest private constant vm = VmDeploymentTest(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ADMINISTRATOR = address(0xA11CE);
    address private constant INITIAL_ATTESTOR = address(0xA771E570);

    DeployPonteRouteDecisionEvidenceRegistry private deployment;

    function setUp() public {
        deployment = new DeployPonteRouteDecisionEvidenceRegistry();
        vm.chainId(421614);
    }

    function testAcceptsArbitrumSepoliaWithSeparatedNonzeroRoles() public view {
        deployment.validateConfiguration(ADMINISTRATOR, INITIAL_ATTESTOR);
        _assertEq(deployment.ARBITRUM_SEPOLIA_CHAIN_ID(), 421614);
    }

    function testRejectsIncorrectChainBeforeAnyBroadcast() public {
        vm.chainId(31337);
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployPonteRouteDecisionEvidenceRegistry.UnsupportedDeploymentChain.selector, uint256(31337)
            )
        );
        deployment.validateConfiguration(ADMINISTRATOR, INITIAL_ATTESTOR);
    }

    function testRejectsZeroAdministrator() public {
        vm.expectRevert(DeployPonteRouteDecisionEvidenceRegistry.AdministratorAddressRequired.selector);
        deployment.validateConfiguration(address(0), INITIAL_ATTESTOR);
    }

    function testRejectsZeroInitialAttestor() public {
        vm.expectRevert(DeployPonteRouteDecisionEvidenceRegistry.InitialAttestorAddressRequired.selector);
        deployment.validateConfiguration(ADMINISTRATOR, address(0));
    }

    function testRejectsIdenticalAdministratorAndInitialAttestor() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployPonteRouteDecisionEvidenceRegistry.AdministratorAndAttestorMustDiffer.selector, ADMINISTRATOR
            )
        );
        deployment.validateConfiguration(ADMINISTRATOR, ADMINISTRATOR);
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert AssertionFailed();
    }
}
