import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, Sender, SendMode, toNano, BitBuilder } from '@ton/ton';
import { JettonWallet } from './JettonWallet';
import { Op, Errors } from './JettonConstants';
import { Sha256 } from "@aws-crypto/sha256-js";

export type JettonMinterContent = {
    name: string,
    description: string,
    image: string,
    decimals: string,
    symbol: string
};
export type JettonMinterConfig = {
    admin: Address,
    wallet_code: Cell,
    jetton_content: JettonMinterContent
};
export type JettonMinterConfigFull = {
    supply: bigint,
    admin: Address,
    //Makes no sense to update transfer admin. ...Or is it?
    transfer_admin: Address | null,
    wallet_code: Cell,
    jetton_content: Cell | JettonMinterContent
}

export type LockType = 'out' | 'in' | 'full' | 'unlock';


const sha256 = (str: string) => {
    const sha = new Sha256();
    sha.update(str);
    return Buffer.from(sha.digestSync());
  };

 export type JettonMetaDataKeys = "name" | "description" | "image" | "decimals" | "symbol";

const jettonOnChainMetadataSpec: {
    [key in JettonMetaDataKeys]: "utf8" | "ascii"  | undefined;
  } = {
    name: "utf8",
    description: "utf8",
    image: "ascii",
    decimals: "utf8",
    symbol: "utf8"
  };
  export function jettonMinterConfigCellToConfig(config: Cell) : JettonMinterConfigFull {
    const sc = config.beginParse()
    return {
        supply: sc.loadCoins(),
        admin: sc.loadAddress(),
        transfer_admin: sc.loadMaybeAddress(),
        wallet_code: sc.loadRef(),
        jetton_content: sc.loadRef()
    }
}


export function jettonMinterConfigToCell(config: JettonMinterConfig): Cell {
    const content =  jettonContentToCell(config.jetton_content);
    return  beginCell()
                .storeCoins(0)
                .storeAddress(config.admin)
                .storeAddress(null)
                .storeRef(config.wallet_code)
                .storeRef(content)
              
                
            .endCell();
}
export function jettonMinterConfigFullToCell(config: JettonMinterConfigFull): Cell {
    const content = config.jetton_content instanceof Cell ? config.jetton_content : jettonContentToCell(config.jetton_content);
    return beginCell()
                .storeCoins(config.supply)
                .storeAddress(config.admin)
                .storeAddress(config.transfer_admin)
                .storeRef(config.wallet_code)
                .storeRef(content)
           .endCell()
}

//export function jettonContentToCell(content:JettonMinterContent):Cell {
export function jettonContentToCell(data: { [s: string]: string | undefined }):Cell { 
const dict = Dictionary.empty();

    Object.entries(data).forEach(([k, v]: [string, string | undefined]) => {
        if (!jettonOnChainMetadataSpec[k as JettonMetaDataKeys]) throw new Error(`Unsupported onchain key: ${k}`);
        if (v === undefined || v === '') return;

       

        const CELL_MAX_SIZE_BYTES = Math.floor((1023 - 8) / 8);

        let rootCell = new Cell();
        const builder = new BitBuilder();
        builder.writeUint(0x00, 8);
        if(k == "image_data") {
            rootCell = beginCell().storeStringTail(v).endCell();
        }
        else {
              let currentCell = rootCell;
              let bufferToStore = Buffer.from(v, jettonOnChainMetadataSpec[k as JettonMetaDataKeys]);
        while (bufferToStore.length > 0) {
            builder.writeBuffer(bufferToStore.subarray(0, CELL_MAX_SIZE_BYTES));
            bufferToStore = bufferToStore.subarray(CELL_MAX_SIZE_BYTES);
            if (bufferToStore.length > 0) {
                const newCell = new Cell();
                currentCell.refs.push(newCell);
                currentCell = newCell;
            }
        }
        rootCell = rootCell.asBuilder().storeBits(builder.build()).endCell();
        }
      
        dict.set(sha256(k), rootCell);
    });

    return beginCell()
        .storeInt(0x00, 8)
        .storeDict(dict, Dictionary.Keys.Buffer(32), Dictionary.Values.Cell())
        .endCell();
}

export class JettonMinter implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new JettonMinter(address);
    }

    static createFromConfig(config: JettonMinterConfig, code: Cell, workchain = 0) {
        const data = jettonMinterConfigToCell(config);
        const init = { code, data };
        return new JettonMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(Op.top_up, 32).storeUint(0, 64).endCell(),
        });
    }

    static mintMessage(to: Address, jetton_amount: bigint, from?: Address | null, response?: Address | null, customPayload?: Cell | null, forward_ton_amount: bigint = 0n, total_ton_amount: bigint = 0n) {
		const mintMsg = beginCell().storeUint(Op.internal_transfer, 32)
                                   .storeUint(0, 64)
                                   .storeCoins(jetton_amount)
                                   .storeAddress(from)
                                   .storeAddress(response)
                                   .storeCoins(forward_ton_amount)
                                   .storeMaybeRef(customPayload)
                        .endCell();
        return beginCell().storeUint(Op.mint, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(to)
                          .storeCoins(total_ton_amount)
                          .storeRef(mintMsg)
               .endCell();
    }

    async sendMint(provider: ContractProvider,
				   via: Sender,
				   to: Address,
				   jetton_amount:bigint,
				   from?: Address | null,
				   response_addr?: Address | null,
				   customPayload?: Cell | null,
				   forward_ton_amount: bigint = toNano('0.05'), total_ton_amount: bigint = toNano('0.1')) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.mintMessage(to, jetton_amount, from, response_addr, customPayload, forward_ton_amount, total_ton_amount),
            value: total_ton_amount,
        });
    }

    /* provide_wallet_address#2c76b973 query_id:uint64 owner_address:MsgAddress include_address:Bool = InternalMsgBody;
    */
    static discoveryMessage(owner: Address, include_address: boolean) {
        return beginCell().storeUint(0x2c76b973, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(owner).storeBit(include_address)
               .endCell();
    }

    async sendDiscovery(provider: ContractProvider, via: Sender, owner: Address, include_address: boolean, value:bigint = toNano('0.1')) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.discoveryMessage(owner, include_address),
            value: value,
        });
    }

    static changeAdminMessage(newOwner: Address) {
        return beginCell().storeUint(Op.change_admin, 32).storeUint(0, 64) // op, queryId
                          .storeAddress(newOwner)
               .endCell();
    }

    async sendChangeAdmin(provider: ContractProvider, via: Sender, newOwner: Address) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.changeAdminMessage(newOwner),
            value: toNano("0.1"),
        });
    }

    static dropAdminMessage(query_id: number | bigint) {
        return beginCell().storeUint(Op.drop_admin, 32).storeUint(query_id, 64).endCell();
    }
    async sendDropAdmin(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), query_id: number | bigint = 0) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.dropAdminMessage(query_id),
            value
        });
    }

    static claimAdminMessage(query_id: bigint = 0n) {
        return beginCell().storeUint(Op.claim_admin, 32).storeUint(query_id, 64).endCell();
    }

    async sendClaimAdmin(provider: ContractProvider, via: Sender, query_id:bigint = 0n) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.claimAdminMessage(query_id),
            value: toNano('0.1')
        })
    }

  
    static forceTransferMessage(transfer_amount: bigint,
                            to: Address,
                            from: Address,
                            custom_payload: Cell | null,
                            forward_amount: bigint = 0n,
                            forward_payload: Cell | null,
                            value: bigint = toNano('0.1'),
                            query_id: bigint = 0n) {

        const transferMessage = JettonWallet.transferMessage(transfer_amount,
                                                                 to,
                                                                 to,
                                                                 custom_payload,
                                                                 forward_amount,
                                                                 forward_payload);
        return beginCell().storeUint(Op.call_to, 32).storeUint(query_id, 64)
                          .storeAddress(from)
                          .storeCoins(value)
                          .storeRef(transferMessage)
              .endCell();
    }


    async sendForceTransfer(provider: ContractProvider,
                            via: Sender,
                            transfer_amount: bigint,
                            to: Address,
                            from: Address,
                            custom_payload: Cell | null,
                            forward_amount: bigint = 0n,
                            forward_payload: Cell | null,
                            value: bigint = toNano('0.1'),
                            query_id: bigint = 0n) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.forceTransferMessage(transfer_amount,
                                                    to, from,
                                                    custom_payload,
                                                    forward_amount,
                                                    forward_payload,
                                                    value, query_id),
            value: value + toNano('0.1')
        });
    }

    static forceBurnMessage(burn_amount: bigint,
                            to: Address,
                            response: Address | null,
                            value: bigint = toNano('0.1'),
                            query_id: bigint | number = 0) {

        return beginCell().storeUint(Op.call_to, 32).storeUint(query_id, 64)
                          .storeAddress(to)
                          .storeCoins(value)
                          .storeRef(JettonWallet.burnMessage(burn_amount, response, null))
               .endCell()
    }
    async sendForceBurn(provider: ContractProvider,
                        via: Sender,
                        burn_amount: bigint,
                        address: Address,
                        response: Address | null,
                        value: bigint = toNano('0.1'),
                        query_id: bigint | number = 0) {

        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.forceBurnMessage(burn_amount, address, response, value, query_id),
            value: value + toNano('0.1')
        });
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const res = await provider.get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])
        return res.stack.readAddress()
    }

    async getJettonData(provider: ContractProvider) {
        let res = await provider.get('get_jetton_data', []);
        let totalSupply = res.stack.readBigNumber();
        let mintable = res.stack.readBoolean();
        let adminAddress = res.stack.readAddressOpt();
        let content = res.stack.readCell();
        let walletCode = res.stack.readCell();
        return {
            totalSupply,
            mintable,
            adminAddress,
            content,
            walletCode,
        };
    }

    async getTotalSupply(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.totalSupply;
    }
    async getAdminAddress(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.adminAddress;
    }
    async getContent(provider: ContractProvider) {
        let res = await this.getJettonData(provider);
        return res.content;
    }
}