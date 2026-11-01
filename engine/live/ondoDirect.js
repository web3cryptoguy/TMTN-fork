// Ondo 代币化股票（FXIon / NVDAB …）美股休市时币安不给换：「Token FXIon currently has no available liquidity. Please trade during stock market opening hours.」
// 但 PancakeSwap V3 上它和 USDT 的池子周末照样能换（2026-11-01 周日实测 QuoterV2：60 USDT → 1.754 FXIon，1 FXIon → 34.03 USDT）。
// 这时 USDT ↔ Ondo 这一腿改走路线表里记下的最深池子（bestPool，必须是 PancakeSwap V3、另一边是 USDT、流动性 ≥ QUOTE_MIN_LIQ_USD）：
// 报价用 QuoterV2，下单用 SwapRouter.exactInputSingle（先链上模拟）。BNB ↔ USDT 那一腿照旧走 baw
import { ethers } from 'ethers';
import { getRoute, USDT, MIN_LIQ_USD } from './quoteRoutes.js';

export const CLOSED_RE = /stock market opening hours|currently has no available liquidity/i;
const V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
export const PANCAKE_V3_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';   // SwapRouter（factory / WETH9 链上核对过）
const QUOTER = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997';   // QuoterV2
const poolI = new ethers.Interface(['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function factory() view returns (address)']);
const quoterI = new ethers.Interface(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)']);
const routerI = new ethers.Interface(['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
const lc = (a) => String(a || '').toLowerCase();
const minOut = (v, slip) => (v * BigInt(10000 - Math.min(9900, Math.round(slip * 100)))) / 10000n;
const fees = new Map();
// 小数数量 → 最小单位：多出这个币小数位的部分截掉（parseUnits 遇到多余小数位会报错）
export const units = (qty, dec) => { const [i, f = ''] = String(qty).split('.'); return ethers.parseUnits(f ? `${i}.${f.slice(0, dec)}` : i, dec); };

// 这个 Ondo 币和 USDT 的 V3 池子手续费档（读一次记住）；没有合格的池子就报错（上层把币安的休市提示一起报出来）
async function poolFee(provider, ondo) {
  const k = lc(ondo); if (fees.has(k)) return fees.get(k);
  const bp = getRoute(k)?.bestPool, liq = getRoute(k)?.liqUsd;
  if (!bp?.pair || !(bp.labels || []).includes('v3') || bp.dex !== 'pancakeswap' || bp.with !== 'USDT') throw new Error('没有记录到 PancakeSwap V3 的 USDT 池子');
  if (liq != null && liq < MIN_LIQ_USD) throw new Error(`USDT 池子流动性只有 $${Math.round(liq).toLocaleString('en-US')}（低于 $${MIN_LIQ_USD.toLocaleString('en-US')}）`);
  const rd = async (fn) => poolI.decodeFunctionResult(fn, await provider.call({ to: bp.pair, data: poolI.encodeFunctionData(fn) }))[0];
  const [t0, t1, fee, fac] = await Promise.all([rd('token0'), rd('token1'), rd('fee'), rd('factory')]);
  const pair = new Set([lc(t0), lc(t1)]);
  if (lc(fac) !== lc(V3_FACTORY) || !pair.has(k) || !pair.has(lc(USDT))) throw new Error('记录的池子不是这个币和 USDT 的 PancakeSwap V3 池');
  fees.set(k, Number(fee)); return Number(fee);
}

// from / to 一边是 USDT，另一边是 Ondo 币；amountIn 是最小单位（wei）
export async function v3Quote(provider, from, to, amountIn) {
  const ondo = lc(from) === lc(USDT) ? to : from, fee = await poolFee(provider, ondo);
  const r = await provider.call({ to: QUOTER, data: quoterI.encodeFunctionData('quoteExactInputSingle', [{ tokenIn: from, tokenOut: to, amountIn, fee, sqrtPriceLimitX96: 0 }]) });
  return quoterI.decodeFunctionResult('quoteExactInputSingle', r)[0];
}

// 真实兑换：授权本次数量 → 报价 → 模拟 → exactInputSingle，返回实际到账数量（余额差）。g = GangV2（借它的 send / ensureAllowance / balanceOf）
export async function v3Swap({ g, wallet, from, to, amountIn, slippage, step, label }) {
  const t0 = Date.now(), ondo = lc(from) === lc(USDT) ? to : from, fee = await poolFee(g.provider, ondo);
  step(`${label}：美股休市，币安不给换，改走 PancakeSwap V3 USDT 池（${fee / 10000}%）`, 0);
  const hashes = [], ap = await g.ensureAllowance({ wallet, token: from, spender: PANCAKE_V3_ROUTER, amount: amountIn, label: `授权${label}（PancakeSwap V3）`, step, kind: 'quote' }); if (ap) hashes.push(ap);
  const [out, before] = await Promise.all([v3Quote(g.provider, from, to, amountIn), g.balanceOf(to, wallet)]);
  if (out <= 0n) throw new Error(`${label}：PancakeSwap V3 报价为 0`);
  const data = routerI.encodeFunctionData('exactInputSingle', [{ tokenIn: from, tokenOut: to, fee, recipient: wallet, deadline: Math.floor(Date.now() / 1000) + 600, amountIn, amountOutMinimum: minOut(out, slippage), sqrtPriceLimitX96: 0 }]);
  try { await g.provider.call({ from: wallet, to: PANCAKE_V3_ROUTER, data }); } catch (e) { throw new Error(`${label} 链上模拟失败：${e.shortMessage || e.message}`); }
  hashes.push(await g.send({ wallet, to: PANCAKE_V3_ROUTER, inputData: data, label: `${label}（PancakeSwap V3）`, step }));
  let got = 0n; for (let i = 0; i < 34; i++) { got = (await g.balanceOf(to, wallet)) - before; if (got > 0n) break; await new Promise((r) => setTimeout(r, 300)); }
  if (got <= 0n) throw new Error(`${label}（PancakeSwap V3）没有到账，后续步骤没有执行`);
  step(`${label}（PancakeSwap V3）完成`, Date.now() - t0);
  return { o: { txHash: hashes.at(-1) }, got, hashes };
}
