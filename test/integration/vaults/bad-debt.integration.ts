import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault } from "typechain-types";

import { MAX_UINT256, ONE_GWEI } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  DEFAULT_TIER_PARAMS,
  finalizeWQViaElVault,
  getProtocolContext,
  getReportTimeElapsed,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: Vault with bad debt", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let otherOwner: HardhatEthersSigner;
  let daoAgent: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    const { lido, stakingVaultFactory, vaultHub, elRewardsVault } = ctx.contracts;
    originalSnapshot = await Snapshot.take();

    await waitNextAvailableReportTime(ctx);
    await finalizeWQViaElVault(ctx);
    await setBalance(elRewardsVault.address, 0);

    [, owner, nodeOperator, otherOwner, daoAgent] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    // Going to bad debt
    await dashboard.fund({ value: ether("10") }); // TV = 11 ETH
    await dashboard.mintShares(owner, await dashboard.remainingMintingCapacityShares(0n));

    // Slash 10 ETH
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      slashingReserve: ether("1"),
      waitForNextRefSlot: true,
    });

    expect(await dashboard.totalValue()).to.be.lessThan(
      await lido.getPooledEthBySharesRoundUp(await dashboard.liabilityShares()),
    );

    // Indicates bad debt
    expect(await vaultHub.healthShortfallShares(stakingVault)).to.be.equal(MAX_UINT256);

    // Grant a role to the DAO agent
    await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), daoAgent);
  });

  const getFirstEvent = (receipt: ContractTransactionReceipt, eventName: string) => {
    const events = ctx.getEvents(receipt, eventName);
    expect(events.length).to.be.greaterThan(0);
    return events[0];
  };

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Socialization", () => {
    let acceptorStakingVault: StakingVault;
    let acceptorDashboard: Dashboard;

    beforeEach(async () => {
      const { stakingVaultFactory } = ctx.contracts;
      // create vault acceptor
      ({ stakingVault: acceptorStakingVault, dashboard: acceptorDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      ));
    });

    it("Vault's debt can be socialized", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No more bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      expect(await acceptorDashboard.liabilityShares()).to.be.equal(badDebtShares);
      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(true);
    });

    it("Socialization bypasses jail restrictions", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido, operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Put acceptor vault in jail to test bypass functionality
      await operatorGrid.connect(agentSigner).setVaultJailStatus(acceptorStakingVault, true);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Socialization should succeed even though acceptor vault is in jail
      // because socializeBadDebt uses _overrideLimits: true
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      // Verify bad debt was transferred despite jail restriction
      expect(await acceptorDashboard.liabilityShares()).to.equal(badDebtShares);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true; // Still in jail
    });

    it("Socialization doesn't lead to bad debt in acceptor", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("1") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(
        vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares),
      ).to.emit(vaultHub, "BadDebtSocialized");

      expect(await dashboard.liabilityShares()).to.be.greaterThan(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "Still some bad debt left",
      );

      expect(
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue())),
      ).to.be.lessThan(badDebtShares, "bad debt should decrease");

      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(false);
      expect(await acceptorDashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await acceptorDashboard.totalValue()),
        "No bad debt in acceptor vault",
      );
    });

    it("Socialization lead to bad debt beacon chain deposits pause", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("2") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.false;

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .and.to.emit(acceptorStakingVault, "BeaconChainDepositsPaused");

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("OperatorGrid shareLimits can't prevent socialization", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      await setUpOperatorGrid(
        ctx,
        [nodeOperator],
        [{ noShareLimit: await acceptorDashboard.liabilityShares(), tiers: [DEFAULT_TIER_PARAMS] }],
      );
      await changeTier(ctx, acceptorDashboard, otherOwner, nodeOperator);

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);
    });
  });

  describe("Internalization", () => {
    it("Vault's bad debt can be internalized", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtWrittenOffToBeInternalized")
        .withArgs(stakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      await waitNextAvailableReportTime(ctx);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares);

      const { reportTx } = await report(ctx, { waitNextReportTime: false });
      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(badDebtShares)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(badDebtShares);

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n);
    });
  });

  describe("Report simulation (accounting)", () => {
    it("simulateOracleReport result matches handleOracleReport while bad debt", async () => {
      const { lido, hashConsensus, accounting, elRewardsVault, withdrawalVault, withdrawalQueue, vaultHub } =
        ctx.contracts;

      const clRebase = ether("50");
      const elRewards = ether("100");
      const withdrawalVaultBalance = ether("100");
      const withdrawalRequestAmount = ether("20");

      await lido.connect(otherOwner).submit(ZeroAddress, { value: withdrawalRequestAmount });
      await lido.connect(otherOwner).approve(withdrawalQueue.address, withdrawalRequestAmount);
      await withdrawalQueue.connect(otherOwner).requestWithdrawals([withdrawalRequestAmount], otherOwner.address);
      const withdrawalRequestId = await withdrawalQueue.getLastRequestId();

      await setBalance(elRewardsVault.address, elRewards);
      await setBalance(withdrawalVault.address, withdrawalVaultBalance);

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));
      await vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares);

      const refSlot = (await hashConsensus.getCurrentFrame()).refSlot;
      const { genesisTime, secondsPerSlot } = await hashConsensus.getChainConfig();
      const reportTimestamp = genesisTime + refSlot * secondsPerSlot;
      const { timeElapsed } = await getReportTimeElapsed(ctx);

      const params = { clDiff: clRebase, reportElVault: true, reportWithdrawalsVault: true, dryRun: true };
      const { data: reportData } = await report(ctx, params);

      const externalSharesBefore = await lido.getExternalShares();
      const totalSharesBefore = await lido.getTotalShares();
      const internalSharesBefore = totalSharesBefore - externalSharesBefore;

      const elRewardsBalanceBefore = await ethers.provider.getBalance(elRewardsVault);
      const withdrawalVaultBalanceBefore = await ethers.provider.getBalance(withdrawalVault);

      const simulated = await accounting.simulateOracleReport({
        timestamp: reportTimestamp,
        timeElapsed,
        clValidators: reportData.numValidators,
        clBalance: BigInt(reportData.clBalanceGwei) * ONE_GWEI,
        withdrawalVaultBalance: reportData.withdrawalVaultBalance,
        elRewardsVaultBalance: reportData.elRewardsVaultBalance,
        sharesRequestedToBurn: reportData.sharesRequestedToBurn,
        withdrawalFinalizationBatches: reportData.withdrawalFinalizationBatches,
        simulatedShareRate: reportData.simulatedShareRate,
      });

      const { reportTx } = await report(ctx, { ...params, dryRun: false });

      const reportTxReceipt = await reportTx!.wait();
      const tokenRebasedEvent = getFirstEvent(reportTxReceipt!, "TokenRebased");

      expect(simulated.preTotalShares).to.equal(tokenRebasedEvent.args.preTotalShares);
      expect(simulated.preTotalPooledEther).to.equal(tokenRebasedEvent.args.preTotalEther);
      expect(simulated.postTotalShares).to.equal(tokenRebasedEvent.args.postTotalShares);
      expect(simulated.postTotalPooledEther).to.equal(tokenRebasedEvent.args.postTotalEther);

      const externalSharesAfter = await lido.getExternalShares();
      const totalSharesAfter = await lido.getTotalShares();
      const totalPooledEtherAfter = await lido.getTotalPooledEther();

      const elRewardsBalanceAfter = await ethers.provider.getBalance(elRewardsVault);
      const withdrawalVaultBalanceAfter = await ethers.provider.getBalance(withdrawalVault);

      expect(elRewardsBalanceBefore - simulated.elRewardsVaultTransfer).to.equal(elRewardsBalanceAfter);
      expect(withdrawalVaultBalanceBefore - simulated.withdrawalsVaultTransfer).to.equal(withdrawalVaultBalanceAfter);

      const [withdrawalRequestData] = await withdrawalQueue.getWithdrawalStatus([withdrawalRequestId]);
      const actualBadDebtInternalized = externalSharesBefore - externalSharesAfter;

      expect(simulated.etherToFinalizeWQ).to.equal(withdrawalRequestAmount);
      expect(simulated.etherToFinalizeWQ).to.equal(withdrawalRequestData.amountOfStETH);
      expect(simulated.sharesToFinalizeWQ).to.equal(withdrawalRequestData.amountOfShares);
      expect(simulated.sharesToBurnForWithdrawals).to.equal(withdrawalRequestData.amountOfShares);
      expect(simulated.totalSharesToBurn).to.equal(totalSharesBefore - totalSharesAfter + simulated.sharesToMintAsFees);

      expect(simulated.postInternalShares).to.equal(totalSharesAfter - externalSharesAfter);
      expect(simulated.postInternalShares).to.equal(
        internalSharesBefore - simulated.totalSharesToBurn + simulated.sharesToMintAsFees + actualBadDebtInternalized,
      );

      expect(simulated.postInternalEther).to.equal(totalPooledEtherAfter - (await lido.getExternalEther()));
      expect(simulated.sharesToMintAsFees).to.equal(tokenRebasedEvent.args.sharesMintedAsFees);

      const elRewardsReceived = ctx.getEvents(reportTxReceipt!, "ELRewardsReceived");
      expect(simulated.elRewardsVaultTransfer).to.equal(elRewardsReceived[0].args.amount);
    });
  });
});
