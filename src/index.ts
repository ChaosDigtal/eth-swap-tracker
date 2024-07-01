import express from "express";
import { Client } from 'pg';
import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { Web3 } from 'web3'
import { Network, Alchemy } from "alchemy-sdk";
import Decimal from 'decimal.js'
import {
  addAlchemyContextToRequest,
  validateAlchemySignature,
  getEthereumUSD,
  getPairTokenSymbols,
  getCurrentTimeISOString,
  fillUSDAmounts,
  Token,
  PairToken,
} from "./webhooksUtil";

dotenv.config();

const client = new Client({
  host: '18.188.193.193',
  database: 'postgres',
  user: 'myuser',
  password: 'Lapis@123',
  port: 5432,
});

client.connect((err) => {
  if (err) {
    console.error('Connection error', err.stack);
  } else {
    console.log('Connected to the database');
  }
});

const settings = {
  apiKey: process.env.ALCHEMY_API_KEY,
  network: Network.ETH_MAINNET,
};

const alchemy = new Alchemy(settings);


const main = async () => {
  const app = express();

  const port = process.env.PORT;
  const host = process.env.HOST;
  const signingKey = process.env.WEBHOOK_SIGNING_KEY;

  // Middleware needed to validate the alchemy signature
  app.use(
    express.json({
      limit: '100mb',
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  const UNISWAP_V3_SWAP_EVENT = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
  const UNISWAP_V2_SWAP_EVENT = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  const web3 = new Web3(`https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`);

  var logs: {}[] = [];
  var pairTokens = new Map<string, PairToken>();
  var tokens = new Map<string, Token>();

  let timer: NodeJS.Timeout | null = null;
  var PARSING : Boolean = false;
  var ARRIVING : Boolean = false;
  var block_timestamp : string;

  async function parseSwapEvents() {
    if(logs.length == 0) return;
    PARSING = true;
    ARRIVING = false;
    const currentBlockNumber = logs[0].blockNumber;
    var _logs = logs.filter(log => log.blockNumber == currentBlockNumber);
    logs = logs.filter(log => log.blockNumber != currentBlockNumber);
    var start_time : Date = new Date();
    console.log(`started parsing block:${currentBlockNumber} at: ` + getCurrentTimeISOString());

    // Fetch ETH price
    var ETH_LATEST_PRICE = await getEthereumUSD();
    console.log(`Current ETH Price ${ETH_LATEST_PRICE}`);
    // Example: Extract token swap details

    for (var i = 0; i < _logs.length; ++i) {
      var amount0, amount1;
      if (_logs[i].topics[0] == UNISWAP_V3_SWAP_EVENT) {
        const iface = new ethers.Interface([
          'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
        ]);

        const parsedLog = iface.parseLog(_logs[i]);
        amount0 = parsedLog?.args.amount0;
        amount1 = parsedLog?.args.amount1;
      } else if (_logs[i].topics[0] == UNISWAP_V2_SWAP_EVENT) {
        const iface = new ethers.Interface([
          'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'
        ]);

        const parsedLog = iface.parseLog(_logs[i]);
        const amount0In = parsedLog?.args.amount0In;
        const amount0Out = parsedLog?.args.amount0Out;
        const amount1In = parsedLog?.args.amount1In;
        const amount1Out = parsedLog?.args.amount1Out;
        if (amount0In == 0) {
          amount0 = -amount0Out;
          amount1 = amount1In;
        } else {
          amount0 = amount0In;
          amount1 = amount1Out;
        }
      }

      var pairToken: PairToken = {}
      if (pairTokens.has(_logs[i].address)) {
        pairToken = pairTokens.get(_logs[i].address);
      } else {
        const symbols = await getPairTokenSymbols(web3, _logs[i].address);
        // const response = await alchemy.core.getTokenMetadata(_logs[i].address);
        // pairToken.pool_version = response.name;
        if (tokens.has(symbols.token0)) {
          var token = tokens.get(symbols.token0);
          pairToken.token0 = token;
        } else {
          var response = await alchemy.core.getTokenMetadata(symbols.token0);
          var token: Token = {
            id: symbols?.token0,
            symbol: response.symbol,
            decimal: response.decimals,
          }
          pairToken.token0 = token;
          tokens.set(symbols.token0, token);
        }
        if (tokens.has(symbols.token1)) {
          var token = tokens.get(symbols.token1);
          pairToken.token1 = token;
        } else {
          var response = await alchemy.core.getTokenMetadata(symbols.token1);
          var token: Token = {
            id: symbols?.token1,
            symbol: response.symbol,
            decimal: response.decimals,
          }
          pairToken.token1 = token;
          tokens.set(symbols.token1, token);
        }
        pairTokens.set(_logs[i].address, pairToken);
      }
      var amount0Decimal = new Decimal(ethers.formatUnits(amount0, pairToken?.token0.decimal));
      var amount1Decimal = new Decimal(ethers.formatUnits(amount1, pairToken?.token1.decimal));
      if (amount0Decimal.isPositive()) {
        _logs[i].token0 = {
            id: pairToken.token0.id,
            symbol: pairToken?.token0.symbol,
            amount: amount0Decimal,
        };
        _logs[i].token1 = {
            id: pairToken.token1.id,
            symbol: pairToken?.token1.symbol,
            amount: amount1Decimal.abs(),
        };
      } else {
        _logs[i].token0 = {
            id: pairToken.token1.id,
            symbol: pairToken?.token1.symbol,
            amount: amount1Decimal,
        };
        _logs[i].token1 = {
            id: pairToken.token0.id,
            symbol: pairToken?.token0.symbol,
            amount: amount0Decimal.abs(),
        }
      }
    }
    console.log("started calculating USD at: " + getCurrentTimeISOString());
    await fillUSDAmounts(_logs, ETH_LATEST_PRICE, client);
    console.log("ended parsing at: " + getCurrentTimeISOString());
    console.log(`finished in ${(((new Date()).getTime() - start_time.getTime()) / 1000.0)} seconds`);
    PARSING = false;
  }

  var filter = {
    addresses: [

    ],
    topics: [
      [UNISWAP_V3_SWAP_EVENT, UNISWAP_V2_SWAP_EVENT]
    ]
  }

  alchemy.ws.on(filter, (log) => {
    // if (PARSING) {
    //   //console.log("Currently PARSING");
    //   return;
    // }
    if (!ARRIVING) {
      ARRIVING = true;
      console.log("================");
      block_timestamp = getCurrentTimeISOString();
      console.log(`arrived block:${log.blockNumber} at: ` + block_timestamp);
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(parseSwapEvents, 300);
    log.timestamp = block_timestamp;
    logs.push(log);
  })
  // Listen to Alchemy Notify webhook events
  app.listen(port, host, () => {
    console.log(`Example Alchemy Notify app listening at ${host}:${port}`);
  });
}

main();