import express from "express";
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
  AlchemyWebhookEvent,
  SwapEvent,
  Token,
  PairToken,
} from "./webhooksUtil";

dotenv.config();

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
      limit: '50mb',
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  const UNISWAP_V3_SWAP_EVENT = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
  const UNISWAP_V2_SWAP_EVENT = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
  const web3 = new Web3(`https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`);

  var hashes: string[] = [];
  var pairTokens = new Map<string, PairToken>();
  var tokens = new Map<string, Token>();

  app.post("/webhook", async (req, res) => {
    const webhookEvent = req.body as AlchemyWebhookEvent;
    // Do stuff with with webhook event here!
    console.log(`Processing webhook event id: ${webhookEvent.id}`);
    const eventData = webhookEvent;

    const createdAt = eventData.createdAt;
    console.log("created at: " + createdAt);
    console.log("arrived at: " + getCurrentTimeISOString());

    // Fetch ETH price
    var ETH_LATEST_PRICE = await getEthereumUSD();
    console.log(ETH_LATEST_PRICE);

    // Example: Extract token swap details

    for (const log of eventData.event.data.block.logs) {
      if (log.transaction.type === 2 && log.transaction.status === 1) {
        const hash = log.transaction.hash;
        const events = log.transaction.logs;
        if (hashes.includes(hash))
          return;
        hashes.push(hash);
        console.log("hash: " + hash);

        var swapEvents: SwapEvent[] = [];

        for (const event of events) {
          if (event.topics[0] == UNISWAP_V3_SWAP_EVENT || event.topics[0] == UNISWAP_V2_SWAP_EVENT) {
            var amount0, amount1;
            if (event.topics[0] == UNISWAP_V3_SWAP_EVENT) {
              const iface = new ethers.Interface([
                'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
              ]);

              const parsedLog = iface.parseLog(event);
              amount0 = parsedLog?.args.amount0;
              amount1 = parsedLog?.args.amount1;
            } else if (event.topics[0] == UNISWAP_V2_SWAP_EVENT) {
              const iface = new ethers.Interface([
                'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'
              ]);

              const parsedLog = iface.parseLog(event);
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
            if (pairTokens.has(event.account.address)) {
              pairToken = pairTokens.get(event.account.address);
            } else {
              const symbols = await getPairTokenSymbols(web3, event.account.address);
              // const response = await alchemy.core.getTokenMetadata(event.account.address);
              // pairToken.pool_version = response.name;
              if (tokens.has(symbols.token0)) {
                var token = tokens.get(symbols.token0);
                pairToken.token0 = token;
              } else {
                var response = await alchemy.core.getTokenMetadata(symbols.token0);
                var token: Token = {
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
                  symbol: response.symbol,
                  decimal: response.decimals,
                }
                pairToken.token1 = token;
                tokens.set(symbols.token1, token);
              }
              pairTokens.set(event.account.address, pairToken);
            }
            var amount0Decimal = new Decimal(ethers.formatUnits(amount0, pairToken?.token0.decimal));
            var amount1Decimal = new Decimal(ethers.formatUnits(amount1, pairToken?.token1.decimal));
            var se: SwapEvent;
            if (amount0Decimal.isPositive()) {
              se = {
                //pool_version: pairToken.pool_version,
                token0: {
                  symbol: pairToken?.token0.symbol,
                  amount: amount0Decimal,
                },
                token1: {
                  symbol: pairToken?.token1.symbol,
                  amount: amount1Decimal.abs(),
                },
              }
            } else {
              se = {
                //pool_version: pairToken.pool_version,
                token0: {
                  symbol: pairToken?.token1.symbol,
                  amount: amount1Decimal,
                },
                token1: {
                  symbol: pairToken?.token0.symbol,
                  amount: amount0Decimal.abs(),
                },
              }
            }
            swapEvents.push(se);
          }

        }
        fillUSDAmounts(swapEvents, ETH_LATEST_PRICE);
        console.log(swapEvents);
        console.log(getCurrentTimeISOString());
        console.log("--------------");
      }
    };
    console.log(getCurrentTimeISOString());
    console.log("======================");

    res.status(200).send('Received');
  });

  // Listen to Alchemy Notify webhook events
  app.listen(port, host, () => {
    console.log(`Example Alchemy Notify app listening at ${host}:${port}`);
  });
}

main();