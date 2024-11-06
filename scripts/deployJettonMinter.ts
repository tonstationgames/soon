import {Address, beginCell, Cell, toNano} from '@ton/core';
import {JettonMinter} from '../wrappers/JettonMinter';
import {compile, NetworkProvider, UIProvider} from '@ton/blueprint';
import { promptAddress, promptUrl } from '../wrappers/ui-utils';
export async function run(provider: NetworkProvider) {
    const ui = provider.ui();
    let admin: Address =  await promptAddress(`Please specify admin address`, ui);

    const wallet_code_raw = await compile('JettonWallet');

    // https://docs.ton.org/tvm.pdf, page 30
    // Library reference cell — Always has level 0, and contains 8+256 data bits, including its 8-bit type integer 2
    // and the representation hash Hash(c) of the library cell being referred to. When loaded, a library
    // reference cell may be transparently replaced by the cell it refers to, if found in the current library context.

    let lib_prep = beginCell().storeUint(2, 8).storeBuffer(wallet_code_raw.hash()).endCell();
    const wallet_code = new Cell({exotic: true, bits: lib_prep.bits, refs: lib_prep.refs});

    const minter = provider.open(JettonMinter.createFromConfig({
            admin,
            wallet_code,
            jetton_content: {name: "", 
                description: "",
                image: "",
                decimals: "9",
                symbol: ""
                }    
        },
        await compile('JettonMinter')));
    await minter.sendDeploy(provider.sender(), toNano("0.5"));
}
