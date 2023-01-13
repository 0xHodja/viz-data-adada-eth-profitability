import fetch from "node-fetch";
import fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.ETHERSCAN_API_KEY;
const adadaAddress = "0x29ed7cD3CB3e6173A18Cd9a7F32397D5A2B138dD";

const doAnalysis = async () => {
  // get erc20 tx
  // get eth normal tx
  let txERC20 = await fetch(`https://api.etherscan.io/api?module=account&action=tokentx&address=${adadaAddress}&apikey=${API_KEY}`);
  txERC20 = await txERC20.json();
  txERC20 = txERC20.result;
  let txNormal = await fetch(`https://api.etherscan.io/api?module=account&action=txlist&address=${adadaAddress}&apikey=${API_KEY}`);
  txNormal = await txNormal.json();
  txNormal = txNormal.result;
  // remove error tx
  txNormal = txNormal.filter((x) => x.isError === "0");
  // remove non-rpl related tx
  let rplTxHashes = txERC20.filter((x) => x.tokenSymbol === "RPL").map((x) => x.hash);
  txERC20 = txERC20.filter((x) => {
    return rplTxHashes.includes(x.hash);
  }); // a hash involving a transfer or swap of RPL
  // some preprocessing
  txNormal = txNormal.map((x) => {
    return { ...x, tokenSymbol: "ETH", tokenDecimal: 18 };
  });
  // merge txs (inner join)
  const txNormalMask = txNormal.filter((x) => txERC20.map((y) => y.hash).includes(x.hash)).map((z) => z.hash);
  const txERC20Mask = txERC20.filter((x) => txNormal.map((y) => y.hash).includes(x.hash)).map((z) => z.hash);
  const txMask = new Set([...txERC20Mask, ...txNormalMask]);
  let txs = [...txERC20, ...txNormal].filter((x) => [...txMask].includes(x.hash)); // all tx involving rpl xfers and swaps, ERC20 and ETH
  let hashCount = txs.reduce((count, tx) => ({ ...count, [tx.hash]: (count[tx.hash] || 0) + 1 }), {});
  txs = txs
    .map((x) => {
      let isSwap = hashCount[x.hash] > 1;
      let isBuy = x.to.toLowerCase() === adadaAddress.toLowerCase();
      return {
        ...x,
        isSwap,
        isBuy,
        value: x.value / 10 ** parseInt(x.tokenDecimal),
      };
    })
    .sort((a, b) => (parseInt(a.blockNumber) > parseInt(b.blockNumber) ? 1 : -1));

  // get ethereum prices daily from coingecko
  let ethPrices = await fetch("https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=max");
  ethPrices = await ethPrices.json();

  const getEthPriceUSD = (timestamp) => {
    let price = ethPrices.prices.filter((x) => x[0] >= parseInt(timestamp) * 1000)[0] || ethPrices[ethPrices.length - 1];
    return price[1]; // just get daily close for simplicity
  };

  // compile a pivot of swaps with hash as id
  let swaps = {};
  txs.map((x) => {
    swaps[x.hash] = {
      hash: x.hash,
      timestamp: parseInt(x.timeStamp),
      blockNumber: x.blockNumber,
    };
  });
  txs.map((x) => {
    let token = x.tokenSymbol.includes("USD") ? "USD" : x.tokenSymbol; // treat USDC and USDT as equal
    if (!swaps[x.hash]["trade"]) {
      swaps[x.hash]["trade"] = [];
    }
    swaps[x.hash]["trade"] = [...swaps[x.hash]["trade"], [token, x.isBuy ? x.value : -x.value]];
  });
  Object.keys(swaps).map((k) => {
    let trades = swaps[k]["trade"];
    trades = trades.reduce((a, b) => {
      let token = b[0];
      let value = b[1];
      if (b[0] === "ETH") {
        token = "USD";
        value = getEthPriceUSD(swaps[k].timestamp) * b[1];
      }
      return { ...a, [token]: (a[token] || 0) + value };
    }, {});
    swaps[k]["trade"] = trades;
    swaps[k]["price"] = Math.abs(trades.USD / trades.RPL);
  });

  // compile total volumes traded
  let totalVolume = {};
  Object.values(swaps).map((x) => {
    let trade = x.trade;
    Object.entries(trade).map(([k, v]) => {
      totalVolume[k] = totalVolume[k] ? totalVolume[k] + Math.abs(v) : Math.abs(v);
    });
  });

  // sort ascending
  swaps = Object.values(swaps).sort((a, b) => (parseInt(a.timestamp) > parseInt(b.timestamp) ? 1 : -1));
  swaps = swaps.filter((x) => x.trade.RPL !== 0);

  let rplPrices = await fetch("https://api.coingecko.com/api/v3/coins/rocket-pool/market_chart?vs_currency=usd&days=max");
  rplPrices = await rplPrices.json();
  rplPrices = rplPrices.prices;

  const getRplPriceUSD = (timestamp) => {
    let price = rplPrices.filter((x) => x[0] >= parseInt(timestamp) * 1000)[0] || rplPrices[rplPrices.length - 1];
    return price[1];
  };

  // calc profitability
  const getDaysArray = (s, e) => {
    for (var a = [], d = new Date(s); d <= new Date(e); d.setDate(d.getDate() + 1)) {
      a.push(new Date(d));
    }
    return a;
  };
  let dateRange = getDaysArray("2021-02-01", "2023-01-14");

  let runningBalance = [0, 0, 0, 0]; // rpl balance, cost basis price, profit, eth_gas_used
  let dataSet = {};
  for (let i = 1; i < dateRange.length; i++) {
    let currTime = dateRange[i].valueOf() / 1000;
    let prevTime = dateRange[i - 1].valueOf() / 1000;
    let selectSwaps = swaps.filter((x) => x.timestamp < currTime && x.timestamp >= prevTime);

    selectSwaps.forEach((x) => {
      if (x.trade.RPL > 0) {
        let prevRPL = runningBalance[0];
        let prevCostBasis = runningBalance[1];
        let swapRPL = Math.abs(x.trade.RPL);
        let currRPL = swapRPL + prevRPL;
        let newCostBasis = (prevRPL * prevCostBasis + swapRPL * x.price) / currRPL;
        runningBalance = [currRPL, newCostBasis, runningBalance[2], runningBalance[3]];
      } else {
        let amount = Math.abs(x.trade.RPL);
        runningBalance = [Math.round((runningBalance[0] - amount) * 1e3) / 1e3, runningBalance[1], (runningBalance[2] += amount * (x.price - runningBalance[1])), runningBalance[3]];
      }
      runningBalance[3] += parseFloat(txNormal.find((y) => y.hash === x.hash).gasUsed / 1e9);
    });
    let entry = {
      date: currTime,
      rplPrice: getRplPriceUSD(currTime),
      swaps: [...selectSwaps],
      rplBalance: runningBalance[0],
      rplAvgCostPrice: runningBalance[1],
      netProfit: runningBalance[2],
      gasUsed: runningBalance[3],
    };
    if (entry.swaps.length > 0) {
      console.log(runningBalance);
    }
    dataSet[currTime] = entry;
  }

  // write json to file
  const writeToFile = (path, content) => {
    try {
      fs.writeFileSync(path, content);
    } catch (e) {
      console.log(e);
      throw e;
    }
  };

  writeToFile("./data.json", JSON.stringify(dataSet));

  console.log("blah");
};

(async () => {
  await doAnalysis();
})();
