import { NextFunction } from "express";
import { Request, Response } from "express-serve-static-core";
import axios from 'axios';
import * as crypto from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { Web3 } from 'web3'
import Decimal from 'decimal.js'
import { Client } from 'pg';

export interface AlchemyRequest extends Request {
  alchemy: {
    rawBody: string;
    signature: string;
  };
}

export function isValidSignatureForAlchemyRequest(
  request: AlchemyRequest,
  signingKey: string
): boolean {
  return isValidSignatureForStringBody(
    request.alchemy.rawBody,
    request.alchemy.signature,
    signingKey
  );
}

export function isValidSignatureForStringBody(
  body: string,
  signature: string,
  signingKey: string
): boolean {
  const hmac = crypto.createHmac("sha256", signingKey); // Create a HMAC SHA256 hash using the signing key
  hmac.update(body, "utf8"); // Update the token hash with the request body using utf8
  const digest = hmac.digest("hex");
  return signature === digest;
}

export function addAlchemyContextToRequest(
  req: IncomingMessage,
  _res: ServerResponse,
  buf: Buffer,
  encoding: BufferEncoding
): void {
  const signature = req.headers["x-alchemy-signature"];
  // Signature must be validated against the raw string
  var body = buf.toString(encoding || "utf8");
  (req as AlchemyRequest).alchemy = {
    rawBody: body,
    signature: signature as string,
  };
}

export function validateAlchemySignature(signingKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isValidSignatureForAlchemyRequest(req as AlchemyRequest, signingKey)) {
      const errMessage = "Signature validation failed, unauthorized!";
      res.status(403).send(errMessage);
      throw new Error(errMessage);
    } else {
      next();
    }
  };
}

export const getEthereumUSD = async () => {
  var response = (await axios.get("https://api.coincap.io/v2/assets/ethereum")).data;

  return new Decimal(response['data']['priceUsd']);
}

function addEdge(graph: Map<string, string[]>, A: string, B: string, ratio: Decimal) {
  if (graph.has(A)) {
    graph.get(A)!.push({ symbol: B, ratio: ratio });
  } else {
    graph.set(A, [{ symbol: B, ratio: ratio }]);
  }
}

export async function fillUSDAmounts(swapEvents: {}[], ETH2USD: Decimal, client: Client) {
  if (swapEvents.length == 0) return;
  var graph = new Map<string, { symbol: string, ratio: Decimal }[]>()

  for (var se of swapEvents) {
    addEdge(graph, se.token0.symbol, se.token1.symbol, se.token0.amount.dividedBy(se.token1.amount));
    addEdge(graph, se.token1.symbol, se.token0.symbol, se.token1.amount.dividedBy(se.token0.amount));
  }

  const stack: string[] = ["USDC", "USDT", "WETH"];

  var symbol2USD = new Map<string, Decimal>();

  symbol2USD.set("WETH", ETH2USD);
  symbol2USD.set("USDT", new Decimal(1.0));
  symbol2USD.set("USDC", new Decimal(1.0));

  while (stack.length > 0) {
    const symbol = stack.pop();

    if (!graph.has(symbol)) continue;
    for (var right of graph.get(symbol)) {
      if (!symbol2USD.has(right.symbol)) {
        symbol2USD.set(right.symbol, symbol2USD.get(symbol).times(right.ratio));
        stack.push(right.symbol);
      }
    }
  }
  for (var i = 0; i < swapEvents.length; ++i) {
    if (symbol2USD.has(swapEvents[i].token0.symbol)) {
      swapEvents[i].token0.value_in_usd = symbol2USD.get(swapEvents[i].token0.symbol);
      swapEvents[i].token0.total_exchanged_usd = swapEvents[i].token0.value_in_usd.times(swapEvents[i].token0.amount);
    }
    if (symbol2USD.has(swapEvents[i].token1.symbol)) {
      swapEvents[i].token1.value_in_usd = symbol2USD.get(swapEvents[i].token1.symbol);
      swapEvents[i].token1.total_exchanged_usd = swapEvents[i].token1.value_in_usd.times(swapEvents[i].token1.amount);
    }
  }

  // Writing to DB
  for (const event of swapEvents) {
    const {
      blockNumber,
      blockHash,
      transactionHash,
      token0: { id: token0_id, symbol: token0_symbol, amount: token0_amount, value_in_usd: token0_value_in_usd, total_exchanged_usd: token0_total_exchanged_usd },
      token1: { id: token1_id, symbol: token1_symbol, amount: token1_amount, value_in_usd: token1_value_in_usd, total_exchanged_usd: token1_total_exchanged_usd },
      timestamp
    } = event;

    const query = `
      INSERT INTO swap_events (
        block_number,
        block_hash,
        transaction_hash,
        token0_id,
        token0_symbol,
        token0_amount,
        token0_value_in_usd,
        token0_total_exchanged_usd,
        token1_id,
        token1_symbol,
        token1_amount,
        token1_value_in_usd,
        token1_total_exchanged_usd,
        eth_price_usd,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `;

    const values = [
      blockNumber,
      blockHash,
      transactionHash,
      token0_id,
      token0_symbol,
      token0_amount.toString(),
      token0_value_in_usd.toString(),
      token0_total_exchanged_usd.toString(),
      token1_id,
      token1_symbol,
      token1_amount.toString(),
      token1_value_in_usd.toString(),
      token1_total_exchanged_usd.toString(),
      ETH2USD.toString(),
      timestamp
    ];

    try {
      await client.query(query, values);
      console.log('Event saved successfully');
    } catch (err) {
      console.error('Error saving event', err);
    }
  }

}

// Function to get the token addresses
export async function getPairTokenSymbols(web3: Web3, pairAddress: string) {
  const pairABI = [
    {
      "constant": true,
      "inputs": [],
      "name": "token0",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "token1",
      "outputs": [
        {
          "internalType": "address",
          "name": "",
          "type": "address"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    }
  ];
  // Create a new contract instance with the pair address and ABI
  const pairContract = new web3.eth.Contract(pairABI, pairAddress);
  try {
    const token0 = await pairContract.methods.token0().call();
    const token1 = await pairContract.methods.token1().call();
    return { token0, token1 };
  } catch (error) {
    console.error("Error fetching pair tokens:", error);
    return null;
  }
}

export interface AlchemyWebhookEvent {
  webhookId: string;
  id: string;
  createdAt: Date;
  type: AlchemyWebhookType;
  event: Record<any, any>;
}

export function getCurrentTimeISOString(): string {
  const now = new Date();
  return now.toISOString();
}

export interface Token {
  id: string;
  symbol: string;
  decimal: number;
}

export interface PairToken {
  //pool_version: string;
  token0: Token;
  token1: Token;
}

export type AlchemyWebhookType =
  | "MINED_TRANSACTION"
  | "DROPPED_TRANSACTION"
  | "ADDRESS_ACTIVITY";

