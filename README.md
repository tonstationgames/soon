![Logo](soonlogo.jpg)

# Soon Jetton

This jetton code forked from [stablecoin contract from ton repository](https://github.com/ton-blockchain/stablecoin-contract). We removed governance functionality and add 
additional features: 

- Mint jettons is possible only once, after that, admin automatically removes from the contract
- All jetton metada, except for the logo, stored onchain, and could not be changed
- Removed the status field from jetton-wallet contract, because the wallet cannot be blocked by the administrator and this field is not needed

When deploying a jetton-master contract, a vanity contract will be used to obtain a beautiful address. Vaniti contract was taken from the [ton community](https://github.com/ton-community/vanity-contract/tree/main) repository.


## How to use and install localy

`npm i && npm test`

