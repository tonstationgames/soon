import qs from 'qs';
import { Address, 
    beginCell, 
    Cell, 
    Contract, 
    contractAddress, 
    ContractProvider, 
    Sender, 
    SendMode,
    toNano,
    BitBuilder,
    TupleBuilder,
 } from '@ton/ton';
import { JettonMinterContent, jettonMinterConfigToCell } from "../wrappers/JettonMinter";
import { StateInit } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { promptAddress, promptUrl } from '../wrappers/ui-utils';

export async function run(provider: NetworkProvider, args: string[]) {
    const ui = provider.ui();
    let admin: Address =  await promptAddress(`Please specify admin address`, ui);
// _SOON

const targetAddress = "";
const salt = '';


const testnet = true;
// Vanity contract code and dataС

const vanityCode:Cell = Cell.fromBase64('te6ccgEBAgEAMgABFP8A9KQT9LzyyAsBAEbT7UTQddch+kCDB9ch0QLQ0wMx+kAwWMcF8ojU1NEB+wTtVA==');



const vanityData = beginCell()
  .storeUint(0, 5)
  .storeAddress(admin)
  .storeBuffer(Buffer.from(salt, 'hex'))
  .endCell();


let initCell:Cell = beginCell().storeUint(6,5).storeRef(vanityCode).storeRef(vanityData).endCell();


//msg.writeTo(cell);
let vanityInit = initCell.toBoc({ idx: false }).toString("base64");

// Your contract code and data
const code = await compile('JettonMinter');

const wallet_code_raw = await compile('JettonWallet');
let lib_prep = beginCell().storeUint(2, 8).storeBuffer(wallet_code_raw.hash()).endCell();
const wallet_code = new Cell({exotic: true, bits: lib_prep.bits, refs: lib_prep.refs});

const data = jettonMinterConfigToCell({
  admin: admin,
  wallet_code: wallet_code,
  jetton_content: { name: "TOON", 
                    description: "TOON STATION",
                    image: "https://bitcoincash-example.github.io/website/logo.png",
                    decimals: "9",
                    symbol: "TOON"
                }  
  });
const deployMessage = beginCell()
  .storeRef(code)
  .storeRef(data).endCell()
  .toBoc({ idx: false })
  .toString("base64");

// Create and display link

let link = `ton://transfer/` + Address.parse(targetAddress).toString({ testOnly: testnet }) + "?" + qs.stringify({ 
    text: "Deploy contract",
    amount: toNano(0.5).toString(),
    init: vanityInit,
    bin: deployMessage,
});
console.log("Deploy: " + link);

}