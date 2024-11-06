import { Blockchain, SandboxContract, TreasuryContract, internal, BlockchainSnapshot, SendMessageResult, defaultConfigSeqno, BlockchainTransaction } from '@ton/sandbox';
import { Cell, toNano, beginCell, Address, Transaction, storeAccountStorage, Sender, Dictionary, storeMessage, fromNano, DictionaryValue } from '@ton/core';
import { JettonWallet } from '../wrappers/JettonWallet';
import { jettonContentToCell, JettonMinter, jettonMinterConfigToCell, JettonMinterContent, LockType } from '../wrappers/JettonMinter';
import '@ton/test-utils';
import {findTransaction, findTransactionRequired} from '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress, getRandomTon, differentAddress, getRandomInt, testJettonTransfer, testJettonInternalTransfer, testJettonNotification, testJettonBurnNotification } from './utils';
import { Op, Errors } from '../wrappers/JettonConstants';
import { calcStorageFee, collectCellStats, computeCellForwardFees, computeFwdFees, computeFwdFeesVerbose, computeGasFee, computeMessageForwardFees, FullFees, GasPrices, getGasPrices, getMsgPrices, getStoragePrices, computedGeneric, storageGeneric, MsgPrices, setGasPrice, setMsgPrices, setStoragePrices, StorageStats, StorageValue } from '../gasUtils';
import { sha256 } from 'ton-crypto';

/*
   These tests check compliance with the TEP-74 and TEP-89,
   but also checks some implementation details.
   If you want to keep only TEP-74 and TEP-89 compliance tests,
   you need to remove/modify the following tests:
     mint tests (since minting is not covered by standard)
     exit_codes
     prove pathway
*/

//jetton params


let send_gas_fee: bigint;
let send_fwd_fee: bigint;
let receive_gas_fee: bigint;
let burn_gas_fee: bigint;
let burn_notification_fee: bigint;
let min_tons_for_storage: bigint;

describe('JettonWallet', () => {
    let jwallet_code_raw = new Cell(); // true code
    let jwallet_code = new Cell();     // library cell with reference to jwallet_code_raw
    let minter_code = new Cell();
    let blockchain: Blockchain;
    let deployer:SandboxContract<TreasuryContract>;
    let notDeployer:SandboxContract<TreasuryContract>;
    let jettonMinter:SandboxContract<JettonMinter>;
    let userWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;
    let walletStats: StorageStats;
    let msgPrices: MsgPrices;
    let gasPrices: GasPrices;
    let storagePrices: StorageValue;
    let storageDuration: number;
    let stateInitStats: StorageStats;
    let defaultOverhead: bigint;
    let defaultContent: JettonMinterContent;
    let adminCanMintSnapshot: BlockchainSnapshot;
    let adminCanNotMint: BlockchainSnapshot;

    let printTxGasStats: (name: string, trans: Transaction) => bigint;
    let estimateBodyFee: (body: Cell, force_ref: boolean, prices?: MsgPrices) => FullFees;
    let estimateBurnFwd: (prices?: MsgPrices) => bigint;
    let forwardOverhead: (prices: MsgPrices, stats: StorageStats) => bigint;
    let estimateAdminTransferFwd: (amount: bigint, custom_payload: Cell | null,
                                   forward_amount: bigint, forward_payload: Cell | null,
                                   prices?: MsgPrices) => bigint;
    let estimateTransferFwd: (amount: bigint, fwd_amount: bigint,
                              fwd_payload: Cell | null,
                              custom_payload: Cell | null,
                              prices?: MsgPrices) => bigint;
    let calcSendFees: (send_fee: bigint,
                       recv_fee: bigint,
                       fwd_fee: bigint,
                       fwd_amount: bigint,
                       storage_fee: bigint,
                       state_init?: bigint) => bigint;
    let testBurnFees: (fees: bigint, to: Address, amount: bigint, exp: number, custom: Cell | null, prices?:MsgPrices) => Promise<Array<BlockchainTransaction>>;
    let testSendFees: (fees: bigint,
                       fwd_amount: bigint,
                       fwd: Cell | null,
                       custom: Cell | null,
                       exp: boolean) => Promise<void>;
    let testAdminTransfer: (ton_amount: bigint, transfer_amount: bigint,
                            from: Address, fwd_amount: bigint,
                            fwd: Cell | null, custom: Cell | null,
                            exp: number) => Promise<void>;
    let testAdminBurn: (ton_amount: bigint, burn_amount: bigint,
                   burn_addr: Address, response: Address,
                   custom_payload: Cell | null, exp: number) => Promise<Array<BlockchainTransaction>>;


    beforeAll(async () => {
        jwallet_code_raw   = await compile('JettonWallet');
        minter_code    = await compile('JettonMinter');
        blockchain     = await Blockchain.create();
        blockchain.now = Math.floor(Date.now() / 1000);
        deployer       = await blockchain.treasury('deployer');
        notDeployer    = await blockchain.treasury('notDeployer');
        walletStats    = new StorageStats(1033, 3);
        msgPrices      = getMsgPrices(blockchain.config, 0);
        gasPrices      = getGasPrices(blockchain.config, 0);
        storagePrices  = getStoragePrices(blockchain.config);
        storageDuration= 5 * 365 * 24 * 3600;
        stateInitStats = new StorageStats(931, 3);
        defaultContent = {name: "TestJetton", 
            description: "Jetton description",
            image: "https://bitcoincash-example.github.io/website/logo.png",
            decimals: "9",
            symbol: "TJT"
            };

        //jwallet_code is library
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${jwallet_code_raw.hash().toString('hex')}`), jwallet_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;
        let lib_prep = beginCell().storeUint(2,8).storeBuffer(jwallet_code_raw.hash()).endCell();
        jwallet_code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});

        console.log('jetton minter code hash = ', minter_code.hash().toString('hex'));
        console.log('jetton wallet code hash = ', jwallet_code.hash().toString('hex'));

        jettonMinter   = blockchain.openContract(
            JettonMinter.createFromConfig(
              {
                 admin: deployer.address,
                 wallet_code: jwallet_code,
                 jetton_content: {name: "TestJetton", 
                 description: "Jetton description",
                 image: "https://bitcoincash-example.github.io/website/logo.png",
                 decimals: "9",
                 symbol: "TJT"
                 }           
              },
              minter_code));
        userWallet = async (address:Address) => blockchain.openContract(
                          JettonWallet.createFromAddress(
                            await jettonMinter.getWalletAddress(address)
                          )
                     );

        printTxGasStats = (name, transaction) => {
            const txComputed = computedGeneric(transaction);
            console.log(`${name} used ${txComputed.gasUsed} gas`);
            console.log(`${name} gas cost: ${txComputed.gasFees}`);
            return txComputed.gasFees;
        }

        estimateBodyFee = (body, force_ref, prices) => {
            const curPrice = prices || msgPrices;
            const mockAddr = new Address(0, Buffer.alloc(32, 'A'));
            const testMsg = internal({
                from: mockAddr,
                to: mockAddr,
                value: toNano('1'),
                body
            });
            const packed = beginCell().store(storeMessage(testMsg, {forceRef: force_ref})).endCell();
            const stats  = collectCellStats(packed, [], true);
            return computeFwdFeesVerbose(prices || msgPrices,  stats.cells, stats.bits);
        }
        estimateBurnFwd = (prices) => {
            const curPrices = prices || msgPrices;
            return computeFwdFees(curPrices, 1n, 754n)
        }
        forwardOverhead     = (prices, stats) => {
            // Meh, kinda lazy way of doing that, but tests are bloated enough already
            return computeFwdFees(prices, stats.cells, stats.bits) - prices.lumpPrice;
        }
        estimateAdminTransferFwd = (jetton_amount, custom_payload,
                                    forward_amount, forward_payload, prices) => {
            const mockAddr = randomAddress(0);
            const curPrices = prices || msgPrices;
            const body = JettonMinter.forceTransferMessage(jetton_amount, mockAddr,
                                                           mockAddr, custom_payload,
                                                           forward_amount, forward_payload);
            const estimate = estimateBodyFee(body, false, curPrices);
            const reverse  = estimate.remaining * 65536n / (65536n - curPrices.firstFrac);
            expect(reverse).toBeGreaterThanOrEqual(estimate.total);
            return reverse;
        }
        estimateTransferFwd = (jetton_amount, fwd_amount,fwd_payload, custom_payload, prices) => {
            // Purpose is to account for the first biggest one fwd fee.
            // So, we use fwd_amount here only for body calculation

            const mockFrom = randomAddress(0);
            const mockTo   = randomAddress(0);

            const body     = JettonWallet.transferMessage(jetton_amount, mockTo,
                                                          mockFrom, custom_payload,
                                                          fwd_amount, fwd_payload);

            const curPrices = prices || msgPrices;
            const feesRes   = estimateBodyFee(body, true, curPrices);
            const reverse   = feesRes.remaining * 65536n / (65536n - curPrices.firstFrac);
            expect(reverse).toBeGreaterThanOrEqual(feesRes.total);
            return reverse;
        }

        calcSendFees = (send, recv, fwd, fwd_amount, storage, state_init) => {
            const overhead = state_init || defaultOverhead;
            const fwdTotal = fwd_amount + (fwd_amount > 0n ? fwd * 2n : fwd) + overhead;
            const execute  = send+ recv;
            return fwdTotal + send + recv + storage + 1n;
        }

        testBurnFees = async (fees, to, amount, exp, custom_payload, prices) => {
            const burnWallet = await userWallet(deployer.address);
            let initialJettonBalance   = await burnWallet.getJettonBalance();
            let initialTotalSupply     = await jettonMinter.getTotalSupply();
            let burnTxs: Array<BlockchainTransaction> = [];
            const burnBody = JettonWallet.burnMessage(amount,to, custom_payload);
            const burnSender = blockchain.sender(deployer.address);
            const sendRes  = await blockchain.sendMessage(internal({
                from: deployer.address,
                to: burnWallet.address,
                value: fees,
                forwardFee: estimateBodyFee(burnBody, false,prices || msgPrices).remaining,
                body: burnBody,
            }));
            if(exp == 0) {
                burnTxs.push(findTransactionRequired(sendRes.transactions, {
                    on: burnWallet.address,
                    from: deployer.address,
                    op: Op.burn,
                    success: true
                }));
                // We expect burn to succeed, but no excess
                burnTxs.push(findTransactionRequired(sendRes.transactions, {
                    on: jettonMinter.address,
                    from: burnWallet.address,
                    op: Op.burn_notification,
                    success: true
                })!);

                expect(await burnWallet.getJettonBalance()).toEqual(initialJettonBalance - amount);
                expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply - amount);
            } else {
                expect(sendRes.transactions).toHaveTransaction({
                    on: burnWallet.address,
                    from: deployer.address,
                    op: Op.burn,
                    success: false,
                    exitCode: exp
                });
                expect(sendRes.transactions).not.toHaveTransaction({
                    on: jettonMinter.address,
                    from: burnWallet.address,
                    op: Op.burn_notification
                });
                expect(await burnWallet.getJettonBalance()).toEqual(initialJettonBalance);
                expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
            }

            return burnTxs;
        }
        testSendFees = async (fees, fwd_amount, fwd_payload, custom_payload, exp) => {
            const deployerJettonWallet = await userWallet(deployer.address);
            let initialJettonBalance   = await deployerJettonWallet.getJettonBalance();
            const someUserAddr         = randomAddress(0);
            const someWallet           = await userWallet(someUserAddr);

            let jettonAmount = 1n;
            const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(),
                                                                       fees,
                                                                       jettonAmount,
                                                                       someUserAddr,
                                                                       deployer.address,
                                                                       custom_payload,
                                                                       fwd_amount,
                                                                       fwd_payload);

            if(exp) {
                expect(sendResult.transactions).toHaveTransaction({
                    on: someWallet.address,
                    op: Op.internal_transfer,
                    success: true
                });
                if(fwd_amount > 0n) {
                    expect(sendResult.transactions).toHaveTransaction({
                        on: someUserAddr,
                        from: someWallet.address,
                        op: Op.transfer_notification,
                        body: (x) => {
                            if(fwd_payload === null) {
                                return true;
                            }
                            return x!.beginParse().preloadRef().equals(fwd_payload);
                        },
                        // We do not test for success, because receiving contract would be uninitialized
                    });
                }
                expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - jettonAmount);
                expect(await someWallet.getJettonBalance()).toEqual(jettonAmount);
            }
            else {
                expect(sendResult.transactions).toHaveTransaction({
                    on: deployerJettonWallet.address,
                    from: deployer.address,
                    op: Op.transfer,
                    aborted: true,
                    success: false,
                    exitCode: Errors.not_enough_gas
                });
                expect(sendResult.transactions).not.toHaveTransaction({
                    on: someWallet.address
                });
            }
        };
        testAdminTransfer = async (ton_amount, jetton_amount,
                                   from, fwd_amount,
                                   fwd, custom, exp) => {
            const to = randomAddress(0);
            const srcWallet = await userWallet(from);
            const dstWallet = await userWallet(to);
            let initialFromBalance   = await srcWallet.getJettonBalance();
            let initialToBalace      = await dstWallet.getJettonBalance();

            const sendResult = await jettonMinter.sendForceTransfer(deployer.getSender(),
                                                                    jetton_amount, to, from,
                                                                    custom, fwd_amount,
                                                                    fwd, ton_amount);
            expect(sendResult.transactions).toHaveTransaction({
                on: jettonMinter.address,
                from: deployer.address,
                op: Op.call_to,
                success: exp == 0,
                exitCode: exp
            });
            if(exp == 0) {
                expect(sendResult.transactions).toHaveTransaction({
                    on: srcWallet.address,
                    from: jettonMinter.address,
                    op: Op.transfer,
                    body: (x) => testJettonTransfer(x!, {
                        amount: jetton_amount
                    }),
                    success: true
                });
                if(fwd_amount > 0n) {
                    expect(sendResult.transactions).toHaveTransaction({
                        on: to,
                        op: Op.transfer_notification,
                        body: (x) => testJettonNotification(x!, {
                            amount: jetton_amount
                        })
                    });
                }

                expect(await srcWallet.getJettonBalance()).toEqual(initialFromBalance - jetton_amount);

                expect(await dstWallet.getJettonBalance()).toEqual(initialToBalace + jetton_amount);
            }
            else {
                expect(sendResult.transactions).not.toHaveTransaction({
                    on: dstWallet.address,
                    from: srcWallet.address,
                    op: Op.transfer
                });

                expect(await srcWallet.getJettonBalance()).toEqual(initialFromBalance);
                expect(await dstWallet.getJettonBalance()).toEqual(initialToBalace);
            }
        }
        testAdminBurn = async (ton_amount, burn_amount, burn_addr, response_addr, cuntom_payload, exp) => {
            const burnWallet = await userWallet(burn_addr);

            const balanceBefore = await burnWallet.getJettonBalance();
            const supplyBefore  = await jettonMinter.getTotalSupply();

            const res = await jettonMinter.sendForceBurn(deployer.getSender(), burn_amount,
                                                         burn_addr, response_addr, ton_amount);
            let burnTxs: Array<BlockchainTransaction> = [];
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                on: jettonMinter.address,
                op: Op.call_to,
                success: exp == 0,
                exitCode: exp
            });

            if(exp == 0) {
                burnTxs.push(findTransactionRequired(res.transactions, {
                    on: burnWallet.address,
                    from: jettonMinter.address,
                    op: Op.burn,
                    value: ton_amount,
                    success: true,
                }));

                burnTxs.push(findTransactionRequired(res.transactions, {
                    on: jettonMinter.address,
                    from: burnWallet.address,
                    op: Op.burn_notification,
                    body: (x) => testJettonBurnNotification(x!, {
                        amount: burn_amount,
                        response_address: response_addr
                    }),
                    success: true
                }));
                /*
                expect(res.transactions).toHaveTransaction({
                    on: deployer.address,
                    from: jettonMinter.address,
                    op: Op.excesses,
                    success: true
                });
                */

                expect(await burnWallet.getJettonBalance()).toEqual(balanceBefore - burn_amount);
                expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore - burn_amount);
            }
            else {
                expect(res.transactions).not.toHaveTransaction({
                    on: jettonMinter.address,
                    from: burnWallet.address,
                    op: Op.burn_notification
                });
                expect(await burnWallet.getJettonBalance()).toEqual(balanceBefore);
                expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore);
            }
            return burnTxs;
        }

        defaultOverhead = forwardOverhead(msgPrices, stateInitStats);
    });

    // implementation detail
    it('should deploy', async () => {
        const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('10'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
        });
        // Make sure it didn't bounce
        expect(deployResult.transactions).not.toHaveTransaction({
            on: deployer.address,
            from: jettonMinter.address,
            inMessageBounced: true
        });
    });
    // implementation detail
    it('minter admin should be able to mint jettons only once', async () => {
        adminCanMintSnapshot = blockchain.snapshot();
        // can mint from deployer
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = toNano('1000.23');
        const mintResult = await jettonMinter.sendMint(deployer.getSender(), deployer.address, initialJettonBalance, null, null, null, toNano('0.05'), toNano('1'));

        const mintTx = findTransactionRequired(mintResult.transactions, {
            from: jettonMinter.address,
            to: deployerJettonWallet.address,
            deploy: true,
            success: true
        });

        printTxGasStats("Mint transaction:", mintTx);
		/*
		 * No excess in this jetton
        expect(mintResult.transactions).toHaveTransaction({ // excesses
            from: deployerJettonWallet.address,
            to: jettonMinter.address
        });
		*/

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply + initialJettonBalance);
        initialTotalSupply += initialJettonBalance;
        // can mint from deployer again
        let additionalJettonBalance = toNano('2.31');
        let secondMint = await jettonMinter.sendMint(deployer.getSender(), deployer.address, additionalJettonBalance, null, null, null, toNano('0.05'), toNano('1'));
        findTransactionRequired(secondMint.transactions, {
            from: deployer.address,
            to: jettonMinter.address,
            deploy: false,
            success: false
        });
    });

    // implementation detail
    it('not a minter admin should not be able to mint jettons', async () => {
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const unAuthMintResult = await jettonMinter.sendMint(notDeployer.getSender(), deployer.address, toNano('777'), null, null, null, toNano('0.05'), toNano('1'));

        expect(unAuthMintResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_owner, // error::unauthorized_mint_request
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('minter admin can change admin', async () => {
        adminCanNotMint = blockchain.snapshot();
        await blockchain.loadFrom(adminCanMintSnapshot);
        const adminBefore = await jettonMinter.getAdminAddress();
        expect(adminBefore).toEqualAddress(deployer.address);
        let res = await jettonMinter.sendChangeAdmin(deployer.getSender(), notDeployer.address);
        expect(res.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true
        });

        res = await jettonMinter.sendClaimAdmin(notDeployer.getSender());

        expect(res.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            success: true
        });

	const adminAfter = await jettonMinter.getAdminAddress();
        expect(adminAfter).toEqualAddress(notDeployer.address);
        await jettonMinter.sendChangeAdmin(notDeployer.getSender(), deployer.address);
        await jettonMinter.sendClaimAdmin(deployer.getSender());
        expect(await jettonMinter.getAdminAddress()).toEqualAddress(deployer.address);

    });
    it('not a minter admin can not change admin', async () => {
        const adminBefore = await jettonMinter.getAdminAddress();
        expect(adminBefore).toEqualAddress(deployer.address);
        let changeAdmin = await jettonMinter.sendChangeAdmin(notDeployer.getSender(), notDeployer.address);
        expect(await jettonMinter.getAdminAddress()).toEqualAddress(deployer.address);
        expect(changeAdmin.transactions).toHaveTransaction({
            from: notDeployer.address,
            on: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_owner, // error::unauthorized_change_admin_request
        });
        
    });
    it('only address specified in change admin action should be able to claim admin', async () => {
        const adminBefore = await jettonMinter.getAdminAddress();
        expect(adminBefore).toEqualAddress(deployer.address);
        let changeAdmin = await jettonMinter.sendChangeAdmin(deployer.getSender(), notDeployer.address);
        expect(changeAdmin.transactions).toHaveTransaction({
            from: deployer.address,
            on: jettonMinter.address,
            success: true
        });

        // At this point transfer_admin is set to notDeployer.address
        const sneaky = differentAddress(notDeployer.address);
        changeAdmin = await jettonMinter.sendClaimAdmin(blockchain.sender(sneaky));
        expect(changeAdmin.transactions).toHaveTransaction({
            from: sneaky,
            on: jettonMinter.address,
            success: false,
            aborted: true
        });
        await blockchain.loadFrom(adminCanNotMint);
    });





    it('storage stats', async() => {
        const prev = blockchain.snapshot();

        const deployerJettonWallet = await userWallet(deployer.address);
        const smc   = await blockchain.getContract(deployerJettonWallet.address);
        const actualStats = collectCellStats(beginCell().store(storeAccountStorage(smc.account.account!.storage)).endCell(), []);
        console.log("Jetton wallet actual storage stats:", actualStats);
        expect(walletStats.cells).toBeGreaterThanOrEqual(actualStats.cells);
        expect(walletStats.bits).toBeGreaterThanOrEqual(actualStats.bits);
        console.log("Jetton estimated max storage stats:", walletStats);
        blockchain.now =  blockchain.now! + storageDuration;
        const res = await deployerJettonWallet.sendBurn(deployer.getSender(), toNano('1'), 0n, null, null);
        const storagePhase = storageGeneric(res.transactions[1]);
        // min_tons_for_storage = storagePhase.storageFeesCollected;
        min_tons_for_storage = calcStorageFee(storagePrices, walletStats, BigInt(storageDuration));
        await blockchain.loadFrom(prev);
    });
    it('wallet owner should be able to send jettons', async () => {
        const prev = blockchain.snapshot();
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        const balanceBefore = (await blockchain.getContract(notDeployerJettonWallet.address)).balance;
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), toNano('0.17'), //tons
               sentAmount, notDeployer.address,
               deployer.address, null, forwardAmount, null);
        expect(sendResult.transactions).toHaveTransaction({ //excesses
            on : deployer.address,
            from: notDeployerJettonWallet.address,
            op: Op.excesses,
            success: true
        });

        expect(sendResult.transactions).toHaveTransaction({ //notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
            value: forwardAmount
        });

        const balanceAfter = (await blockchain.getContract(notDeployerJettonWallet.address)).balance;
        // Make sure we're not draining balance
        expect(balanceAfter).toBeGreaterThanOrEqual(balanceBefore);
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        //sent amount should be unlocked after unlock time
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
        await blockchain.loadFrom(prev);
    });



    it('not wallet owner should not be able to send jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        let initialTotalSupply = await jettonMinter.getTotalSupply();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        const sendResult = await deployerJettonWallet.sendTransfer(notDeployer.getSender(), toNano('0.1'), //tons
               sentAmount, notDeployer.address,
               deployer.address, null, toNano('0.05'), null);
        expect(sendResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_owner, //error::unauthorized_transfer
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2);
        expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('impossible to send too much jettons', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = initialJettonBalance + 1n;
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), toNano('0.1'), //tons
               sentAmount, notDeployer.address,
               deployer.address, null, forwardAmount, null);
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.balance_error, //error::not_enough_jettons
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2);
    });


    describe('Malformed transfer', () => {
        let sendTransferPayload: (from: Address, to: Address, payload: Cell) => Promise<SendMessageResult>;
        let assertFailTransfer: <T extends Transaction> (from: Address, to: Address, txs: Array<T>, codes: Array<number>) => void;
        beforeAll(() => {
            sendTransferPayload = async (from, to, payload) => {
                return await blockchain.sendMessage(internal({
                    from,
                    to,
                    body: payload,
                    value: toNano('1')
                }));
            };
            assertFailTransfer = (from, to, txs, codes) => {
                expect(txs).toHaveTransaction({
                    on: to,
                    from,
                    aborted: true,
                    success: false,
                    exitCode: (c) => codes.includes(c!)
                });
                expect(txs).not.toHaveTransaction({
                    from: to,
                    op: Op.internal_transfer
                });
            }
        });
        it('malfored custom payload', async () => {
            const deployerJettonWallet    = await userWallet(deployer.address);
            const notDeployerJettonWallet = await userWallet(notDeployer.address);

            let sentAmount     = toNano('0.5');
            let forwardPayload = beginCell().storeUint(getRandomInt(100000, 200000), 128).endCell();
            let customPayload  = beginCell().storeUint(getRandomInt(100000, 200000), 128).endCell();

            let forwardTail    = beginCell().storeCoins(toNano('0.05')).storeMaybeRef(forwardPayload);
            const msgTemplate  = beginCell().storeUint(0xf8a7ea5, 32).storeUint(0, 64) // op, queryId
                                            .storeCoins(sentAmount).storeAddress(notDeployer.address)
                                            .storeAddress(deployer.address)
            let testPayload  = beginCell()
                                .storeBuilder(msgTemplate)
                                .storeBit(true)
                                .storeBuilder(forwardTail)
                               .endCell();

            let errCodes = [9, Errors.invalid_mesage];
            let res = await sendTransferPayload(deployer.address,
                                                deployerJettonWallet.address,
                                                testPayload);
            assertFailTransfer(deployer.address, deployerJettonWallet.address,
                       res.transactions, errCodes);

            testPayload = beginCell()
                             .storeBuilder(msgTemplate)
                             .storeBit(false)
                             .storeRef(customPayload)
                             .storeBuilder(forwardTail)
                           .endCell();
            res = await sendTransferPayload(deployer.address,
                                            deployerJettonWallet.address,
                                            testPayload);
            assertFailTransfer(deployer.address, deployerJettonWallet.address,
                       res.transactions, errCodes);
            // Now self test that we didnt screw the payloads ourselves
            testPayload = beginCell()
                             .storeBuilder(msgTemplate)
                             .storeBit(true)
                             .storeRef(customPayload)
                             .storeBuilder(forwardTail)
                           .endCell();

            res = await sendTransferPayload(deployer.address,
                                            deployerJettonWallet.address,
                                            testPayload);

            expect(res.transactions).toHaveTransaction({
                on: deployerJettonWallet.address,
                from: deployer.address,
                op: Op.transfer,
                success: true
            });
        });
        it('malformed forward payload', async() => {

            const deployerJettonWallet    = await userWallet(deployer.address);
            const notDeployerJettonWallet = await userWallet(notDeployer.address);

            let sentAmount     = toNano('0.5');
            let forwardAmount  = getRandomTon(0.01, 0.05); // toNano('0.05');
            let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
            let msgTemplate    = beginCell().storeUint(0xf8a7ea5, 32).storeUint(0, 64) // op, queryId
                                            .storeCoins(sentAmount).storeAddress(notDeployer.address)
                                            .storeAddress(deployer.address)
                                            .storeMaybeRef(null)
                                            .storeCoins(toNano('0.05')) // No forward payload indication
            let errCodes = [9, Errors.invalid_mesage];
            let res = await sendTransferPayload(deployer.address,
                                                deployerJettonWallet.address, msgTemplate.endCell());

            assertFailTransfer(deployer.address, deployerJettonWallet.address,
                               res.transactions,errCodes);

            // Now test that we can't send message without payload if either flag is set
            let testPayload = beginCell().storeBuilder(msgTemplate).storeBit(true).endCell();
            res =  await sendTransferPayload(deployer.address,
                                             deployerJettonWallet.address, testPayload);

            assertFailTransfer(deployer.address, deployerJettonWallet.address,
                               res.transactions,errCodes);
            // Now valid payload
            testPayload = beginCell().storeBuilder(msgTemplate).storeBit(true).storeRef(forwardPayload).endCell();

            res =  await sendTransferPayload(deployer.address,
                                             deployerJettonWallet.address, testPayload);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: deployerJettonWallet.address,
                op: Op.transfer,
                success: true,
            });
        });
    });

    it('correctly sends forward_payload', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        // Make sure payload is different, so cell load is charged for each individual payload.
        let customPayload  = beginCell().storeUint(0xfedcba0987654321n, 128).endCell();
        // Let's use this case for fees calculation
        // Put the forward payload into custom payload, to make sure maximum possible gas used during computation
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), toNano('0.17'), //tons
               sentAmount, notDeployer.address,
               deployer.address, customPayload, forwardAmount, forwardPayload);
        expect(sendResult.transactions).toHaveTransaction({ //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });
        /*
        transfer_notification#7362d09c query_id:uint64 amount:(VarUInteger 16)
                                      sender:MsgAddress forward_payload:(Either Cell ^Cell)
                                      = InternalMsgBody;
        */
        expect(sendResult.transactions).toHaveTransaction({ //notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address,
            value: forwardAmount,
            body: beginCell().storeUint(Op.transfer_notification, 32).storeUint(0, 64) //default queryId
                              .storeCoins(sentAmount)
                              .storeAddress(deployer.address)
                              .storeUint(1, 1)
                              .storeRef(forwardPayload)
                  .endCell()
        });
        const transferTx = findTransactionRequired(sendResult.transactions, {
            on: deployerJettonWallet.address,
            from: deployer.address,
            op: Op.transfer,
            success: true
        });
        send_gas_fee = printTxGasStats("Jetton transfer", transferTx);
        // send_gas_fee = computeGasFee(gasPrices, 9255n);

        const receiveTx = findTransactionRequired(sendResult.transactions, {
            on: notDeployerJettonWallet.address,
            from: deployerJettonWallet.address,
            op: Op.internal_transfer,
            success: true
        });
        receive_gas_fee = printTxGasStats("Receive jetton", receiveTx);
        // receive_gas_fee = computeGasFee(gasPrices, 10355n);

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
    });

    it('no forward_ton_amount - no forward', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        let initialJettonBalance2 = await notDeployerJettonWallet.getJettonBalance();
        let sentAmount = toNano('0.5');
        let forwardAmount = 0n;
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), toNano('0.1'), //tons
               sentAmount, notDeployer.address,
               deployer.address, null, forwardAmount, forwardPayload);
        expect(sendResult.transactions).toHaveTransaction({ //excesses
            from: notDeployerJettonWallet.address,
            to: deployer.address,
        });

        expect(sendResult.transactions).not.toHaveTransaction({ //no notification
            from: notDeployerJettonWallet.address,
            to: notDeployer.address
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - sentAmount);
        expect(await notDeployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance2 + sentAmount);
    });

    it('check revert on not enough tons for forward', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
        await deployer.send({value:toNano('1'), bounce:false, to: deployerJettonWallet.address});
        let sentAmount = toNano('0.1');
        let forwardAmount = toNano('0.3');
        let forwardPayload = beginCell().storeUint(0x1234567890abcdefn, 128).endCell();
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), forwardAmount, // not enough tons, no tons for gas
               sentAmount, notDeployer.address,
               deployer.address, null, forwardAmount, forwardPayload);
        expect(sendResult.transactions).toHaveTransaction({
            from: deployer.address,
            on: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_enough_gas, //error::not_enough_tons
        });
        // Make sure value bounced
        expect(sendResult.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            on: deployer.address,
            inMessageBounced: true,
            success: true
        });

        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
    });



    // implementation detail
    it('wallet does not accept internal_transfer not from wallet', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
/*
  internal_transfer  query_id:uint64 amount:(VarUInteger 16) from:MsgAddress
                     response_address:MsgAddress
                     forward_ton_amount:(VarUInteger 16)
                     forward_payload:(Either Cell ^Cell)
                     = InternalMsgBody;
*/
        let internalTransfer = beginCell().storeUint(0x178d4519, 32).storeUint(0, 64) //default queryId
                              .storeCoins(toNano('0.01'))
                              .storeAddress(deployer.address)
                              .storeAddress(deployer.address)
                              .storeCoins(toNano('0.05'))
                              .storeUint(0, 1)
                  .endCell();
        const sendResult = await blockchain.sendMessage(internal({
                    from: notDeployer.address,
                    to: deployerJettonWallet.address,
                    body: internalTransfer,
                    value:toNano('0.3')
                }));
        expect(sendResult.transactions).toHaveTransaction({
            from: notDeployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.not_valid_wallet, //error::unauthorized_incoming_transfer
        });
        expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
    });

    // Yeah, you got that right
    // Wallet owner should not be able to burn it's jettons
    it('wallet owner should be able to burn jettons', async () => {
           const deployerJettonWallet = await userWallet(deployer.address);
            let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
            let initialTotalSupply = await jettonMinter.getTotalSupply();
            let burnAmount = toNano('0.01');
            const sendResult = await deployerJettonWallet.sendBurn(deployer.getSender(), toNano('0.1'), // ton amount
                                 burnAmount, deployer.address, null); // amount, response address, custom payload
            expect(sendResult.transactions).toHaveTransaction({
               from: deployer.address,
               to: deployerJettonWallet.address,
               aborted: false,
            });
            expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance-burnAmount);
            expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply-burnAmount);

            const actualSent   = printTxGasStats("Burn transaction", sendResult.transactions[1]);
            const actualRecv   = printTxGasStats("Burn notification transaction", sendResult.transactions[2]);
            burn_gas_fee          = actualSent;
            burn_notification_fee = actualRecv;
            /*
            burn_gas_fee = computeGasFee(gasPrices, 5791n);
            burn_notification_fee = computeGasFee(gasPrices, 6775n);
            expect(burn_gas_fee).toBeGreaterThanOrEqual(actualSent);
            expect(burn_notification_fee).toBeGreaterThanOrEqual(actualRecv);
            */
    });

    it('not wallet owner should not be able to burn jettons', async () => {
              const deployerJettonWallet = await userWallet(deployer.address);
              let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
              let initialTotalSupply = await jettonMinter.getTotalSupply();
              let burnAmount = toNano('0.01');
              const sendResult = await deployerJettonWallet.sendBurn(notDeployer.getSender(), toNano('0.1'), // ton amount
                                    burnAmount, deployer.address, null); // amount, response address, custom payload
              expect(sendResult.transactions).toHaveTransaction({
                 from: notDeployer.address,
                 to: deployerJettonWallet.address,
                 aborted: true,
                 exitCode: Errors.not_owner, //error::unauthorized_transfer
                });
              expect(await deployerJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
              expect(await jettonMinter.getTotalSupply()).toEqual(initialTotalSupply);
    });

    it('wallet owner can not burn more jettons than it has', async () => {
                const deployerJettonWallet = await userWallet(deployer.address);
                let initialJettonBalance = await deployerJettonWallet.getJettonBalance();
                let initialTotalSupply = await jettonMinter.getTotalSupply();
                let burnAmount = initialJettonBalance + 1n;
                let msgValue   = toNano('1');
                await testBurnFees(msgValue, deployer.address, burnAmount, Errors.balance_error, null);
    });



    it('minter should only accept burn messages from jetton wallets', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        const burnAmount = toNano('1');
        const burnNotification = (amount: bigint, addr: Address) => {
        return beginCell()
                .storeUint(Op.burn_notification, 32)
                .storeUint(0, 64)
                .storeCoins(amount)
                .storeAddress(addr)
                .storeAddress(deployer.address)
               .endCell();
        }

        let res = await blockchain.sendMessage(internal({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            body: burnNotification(burnAmount, randomAddress(0)),
            value: toNano('0.1')
        }));

        expect(res.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            aborted: true,
            exitCode: Errors.not_valid_wallet// Unauthorized burn
        });

        res = await blockchain.sendMessage(internal({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            body: burnNotification(burnAmount, deployer.address),
            value: toNano('0.1')
        }));

        expect(res.transactions).toHaveTransaction({
            from: deployerJettonWallet.address,
            to: jettonMinter.address,
            success: true
        });
   });

    // TEP-89
    it('report correct discovery address', async () => {
        let discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), deployer.address, true);
        /*
          take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress owner_address:(Maybe ^MsgAddress) = InternalMsgBody;
        */
        const deployerJettonWallet = await userWallet(deployer.address);

        const discoveryTx = findTransactionRequired(discoveryResult.transactions, {
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell().storeUint(Op.take_wallet_address, 32).storeUint(0, 64)
                              .storeAddress(deployerJettonWallet.address)
                              .storeUint(1, 1)
                              .storeRef(beginCell().storeAddress(deployer.address).endCell())
                  .endCell()
        });

        printTxGasStats("Discovery transaction", discoveryTx);

        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), notDeployer.address, true);
        const notDeployerJettonWallet = await userWallet(notDeployer.address);
        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell().storeUint(Op.take_wallet_address, 32).storeUint(0, 64)
                              .storeAddress(notDeployerJettonWallet.address)
                              .storeUint(1, 1)
                              .storeRef(beginCell().storeAddress(notDeployer.address).endCell())
                  .endCell()
        });

        // do not include owner address
        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(), notDeployer.address, false);
        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell().storeUint(Op.take_wallet_address, 32).storeUint(0, 64)
                              .storeAddress(notDeployerJettonWallet.address)
                              .storeUint(0, 1)
                  .endCell()
        });

    });



    it('Correctly handles not valid address in discovery', async () =>{
        const badAddr       = randomAddress(-1);
        let discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(),
                                                               badAddr,
                                                               false);

        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell().storeUint(Op.take_wallet_address, 32).storeUint(0, 64)
                             .storeUint(0, 2) // addr_none
                             .storeUint(0, 1)
                  .endCell()

        });

        // Include address should still be available

        discoveryResult = await jettonMinter.sendDiscovery(deployer.getSender(),
                                                           badAddr,
                                                           true); // Include addr

        expect(discoveryResult.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: deployer.address,
            body: beginCell().storeUint(Op.take_wallet_address, 32).storeUint(0, 64)
                             .storeUint(0, 2) // addr_none
                             .storeUint(1, 1)
                             .storeRef(beginCell().storeAddress(badAddr).endCell())
                  .endCell()

        });
    });

   

    it('can not send to masterchain', async () => {
        const deployerJettonWallet = await userWallet(deployer.address);
        let sentAmount = toNano('0.5');
        let forwardAmount = toNano('0.05');
        const sendResult = await deployerJettonWallet.sendTransfer(deployer.getSender(), toNano('0.1'), //tons
               sentAmount, Address.parse("Ef8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAU"),
               deployer.address, null, forwardAmount, null);
        expect(sendResult.transactions).toHaveTransaction({ //excesses
            from: deployer.address,
            to: deployerJettonWallet.address,
            aborted: true,
            exitCode: Errors.wrong_workchain //error::wrong_workchain
        });
    });

    describe('Remove governance', () => {
        // Idea is to check that previous governance functionality is removed completely
        let testPayload: (payload: Cell, from: Address, to: Address, code: number) => Promise<SendMessageResult>;
        beforeAll(() => {
            testPayload = async (payload, from, to, code) => {
                const res = await blockchain.sendMessage(internal({
                    from,
                    to,
                    body: payload,
                    value: toNano('1')
                }));
                expect(res.transactions).toHaveTransaction({
                    on: to,
                    from,
                    aborted: code !== 0,
                    exitCode: code
                });

                return res;
            }
        });
        it('minter should not be able to force burn tokens', async () => {
            const notDeployerWallet = await userWallet(notDeployer.address);

            const burnMessage = JettonWallet.burnMessage(1n, null, null);
            const balanceBefore = await notDeployerWallet.getJettonBalance();
            expect(balanceBefore).toBeGreaterThan(0n);

            const res = await testPayload(burnMessage, jettonMinter.address, notDeployerWallet.address, Errors.not_owner);
            expect(res.transactions).not.toHaveTransaction({
                on: jettonMinter.address,
                from: notDeployerWallet.address,
                inMessageBounced: false
            });

            expect(await notDeployerWallet.getJettonBalance()).toEqual(balanceBefore);

            // Self check
            await testPayload(burnMessage, notDeployer.address, notDeployerWallet.address, 0);
            expect(await notDeployerWallet.getJettonBalance()).toEqual(balanceBefore - 1n);
        });
        it('minter should not be able to force transfer tokens', async () => {
            const testAddr = randomAddress();
            const testJetton = await userWallet(testAddr);
            const notDeployerWallet = await userWallet(notDeployer.address);
            const balanceBefore = await notDeployerWallet.getJettonBalance();
            expect(balanceBefore).toBeGreaterThan(0n);

            const transferMsg = JettonWallet.transferMessage(1n, testAddr, notDeployer.address, null, 0n, null);

            let res = await testPayload(transferMsg, jettonMinter.address, notDeployerWallet.address, Errors.not_owner);
            expect(await notDeployerWallet.getJettonBalance()).toEqual(balanceBefore);
            expect(res.transactions).not.toHaveTransaction({
                on: testJetton.address,
                from: notDeployerWallet.address
            });
            // Self check
            res = await testPayload(transferMsg, notDeployer.address, notDeployerWallet.address, 0);
            expect(await notDeployerWallet.getJettonBalance()).toEqual(balanceBefore - 1n);
            expect(await testJetton.getJettonBalance()).toBe(1n);
        });

    });

    describe('Bounces', () => {
        it('minter should restore supply on internal_transfer bounce', async () => {
            adminCanNotMint = blockchain.snapshot();
            await blockchain.loadFrom(adminCanMintSnapshot);
            const deployerJettonWallet    = await userWallet(deployer.address);
            const mintAmount = BigInt(getRandomInt(1000, 2000));
            const mintMsg    = JettonMinter.mintMessage(deployer.address, mintAmount, null, null, null, toNano('0.1'), toNano('0.3'));

            const supplyBefore = await jettonMinter.getTotalSupply();
            const minterSmc = await blockchain.getContract(jettonMinter.address);

            // Sending message but only processing first step of tx chain
            let res = minterSmc.receiveMessage(internal({
                from: deployer.address,
                to: jettonMinter.address,
                body: mintMsg,
                value: toNano('1')
            }));

            expect(res.outMessagesCount).toEqual(1);
            const outMsgSc = res.outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.internal_transfer);
            expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore + mintAmount);

            minterSmc.receiveMessage(internal({
                from: deployerJettonWallet.address,
                to: jettonMinter.address,
                bounced: true,
                body: beginCell().storeUint(0xFFFFFFFF, 32).storeSlice(outMsgSc).endCell(),
                value: toNano('0.95')
            }));

            // Supply should change back
            expect(await jettonMinter.getTotalSupply()).toEqual(supplyBefore);
        });
        it('wallet should restore balance on internal_transfer bounce', async () => {
            await blockchain.loadFrom(adminCanNotMint);
            const deployerJettonWallet    = await userWallet(deployer.address);
            const notDeployerJettonWallet = await userWallet(notDeployer.address);
            const balanceBefore           = await deployerJettonWallet.getJettonBalance();
            const txAmount = BigInt(getRandomInt(100, 200));
            const transferMsg = JettonWallet.transferMessage(txAmount, notDeployer.address, deployer.address, null, 0n, null);

            const walletSmc = await blockchain.getContract(deployerJettonWallet.address);

            const res = walletSmc.receiveMessage(internal({
                from: deployer.address,
                to: deployerJettonWallet.address,
                body: transferMsg,
                value: toNano('1')
            }));

            expect(res.outMessagesCount).toEqual(1);

            const outMsgSc = res.outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.internal_transfer);

            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore - txAmount);

            walletSmc.receiveMessage(internal({
                from: notDeployerJettonWallet.address,
                to: walletSmc.address,
                bounced: true,
                body: beginCell().storeUint(0xFFFFFFFF, 32).storeSlice(outMsgSc).endCell(),
                value: toNano('0.95')
            }));

            // Balance should roll back
            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore);
        });
        it('wallet should restore balance on burn_notification bounce', async () => {
            const deployerJettonWallet = await userWallet(deployer.address);
            const balanceBefore        = await deployerJettonWallet.getJettonBalance();
            const burnAmount = BigInt(getRandomInt(100, 200));

            const burnMsg   = JettonWallet.burnMessage(burnAmount, deployer.address, null);

            const walletSmc = await blockchain.getContract(deployerJettonWallet.address);

            const res = walletSmc.receiveMessage(internal({
                from: deployer.address,
                to: deployerJettonWallet.address,
                body: burnMsg,
                value: toNano('1')
            }));

            expect(res.outMessagesCount).toEqual(1);

            const outMsgSc = res.outMessages.get(0)!.body.beginParse();
            expect(outMsgSc.preloadUint(32)).toEqual(Op.burn_notification);

            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore - burnAmount);

            walletSmc.receiveMessage(internal({
                from: jettonMinter.address,
                to: walletSmc.address,
                bounced: true,
                body: beginCell().storeUint(0xFFFFFFFF, 32).storeSlice(outMsgSc).endCell(),
                value: toNano('0.95')
            }));

            // Balance should roll back
            expect(await deployerJettonWallet.getJettonBalance()).toEqual(balanceBefore);
        });
    });





});