// netlify/functions/sign-claim.js
const { ethers } = require('ethers');

// Small helper to make CORS simple
function withCors(body, statusCode = 200) {
  const allow = process.env.ALLOW_ORIGIN || '*';
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

// Event ABI: only what we need to parse the store's Purchased event
const STORE_ABI = [
  "event Purchased(address indexed buyer,uint256 indexed skuId,uint256 priceUSDC,address sponsor,address[8] uplines,uint256[8] levelPaid,uint256 storehouseAmt,uint256 wipAmt)"
];

// Minimal NFT ABI: name() so we can build the exact EIP-712 domain name that the contract uses
const NFT_ABI = [
  "function name() view returns (string)"
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return withCors({ ok: true });
  if (event.httpMethod !== 'POST') return withCors({ error: 'Method not allowed' }, 405);

  try {
    const { SIGNER_PK, CONTRACT_ADDR, RPC_URL, STORE_ADDR } = process.env;
    if (!SIGNER_PK || !CONTRACT_ADDR || !RPC_URL || !STORE_ADDR) {
      return withCors({ error: 'Missing env: SIGNER_PK, CONTRACT_ADDR, RPC_URL, STORE_ADDR' }, 500);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(SIGNER_PK, provider);
    const signerAddress = await wallet.getAddress();

    const body = JSON.parse(event.body || '{}');
    let { orderId, txHash, to, tier } = body;

    if (!to || (typeof tier !== 'number' && typeof tier !== 'string')) {
      return withCors({ error: 'Invalid payload. Expect {to, tier:number|string, orderId? txHash?}' }, 400);
    }
    if (!ethers.utils.isAddress(to)) return withCors({ error: 'Invalid address' }, 400);

    let buyer = null, skuId = null;

    // If txHash is provided, verify the purchase event and wallet match
    if (txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return withCors({ error: 'Invalid or failed transaction' }, 400);

      const iface = new ethers.utils.Interface(STORE_ABI);
      let parsedEv = null;
      for (const lg of receipt.logs) {
        if (lg.address.toLowerCase() !== STORE_ADDR.toLowerCase()) continue;
        try {
          const ev = iface.parseLog(lg);
          if (ev && ev.name === 'Purchased') { parsedEv = ev; break; }
        } catch(_) {}
      }
      if (!parsedEv) return withCors({ error: 'No Purchased event found for this tx' }, 400);

      buyer = parsedEv.args.buyer;
      skuId = Number(parsedEv.args.skuId);
      if (buyer.toLowerCase() !== to.toLowerCase()) {
        return withCors({ error: 'Wallet mismatch: tx buyer != connected wallet', buyer, to }, 400);
      }

      // Default the tier to SKU if not provided / invalid
      const t = Number(tier);
      tier = Number.isFinite(t) && t > 0 ? t : skuId;

      // Use txHash as unique order id (prevents reuse)
      orderId = txHash;
    }

    if (!orderId) return withCors({ error: 'Provide orderId or txHash' }, 400);

    // ===== Read the on-chain token name to match the EIP-712 domain =====
    const nft = new ethers.Contract(CONTRACT_ADDR, NFT_ABI, provider);
    let tokenName = 'DreamPlay Membership';
    try { tokenName = await nft.name(); } catch (_) { /* fallback to default */ }

    const network = await provider.getNetwork();
    const chainId = network.chainId;

    // EIP-712 domain MUST match the exact domain used by the contract (name/version/chainId/contract)
    const domain = {
      name: tokenName,   // <-- critical: use on-chain name()
      version: '1',
      chainId,
      verifyingContract: CONTRACT_ADDR
    };

    const types = {
      Claim: [
        { name: 'to', type: 'address' },
        { name: 'tier', type: 'uint8' },
        { name: 'orderHash', type: 'bytes32' }
      ]
    };

    const orderHash = ethers.utils.id(String(orderId));
    const value = { to, tier: Number(tier), orderHash };

    // Sign typed data with the server signer
    const sig = await wallet._signTypedData(domain, types, value);
    const { v, r, s } = ethers.utils.splitSignature(sig);

    // Helpful debug info in response (safe to expose)
    return withCors({
      v, r, s, orderHash, tier: Number(tier),
      tokenName, chainId, signerAddress, buyer, skuId
    });
  } catch (err) {
    console.error(err);
    return withCors({ error: 'server_error', detail: String(err && err.message ? err.message : err) }, 500);
  }
};
