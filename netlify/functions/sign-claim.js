// netlify/functions/sign-claim.js
const { ethers } = require('ethers');

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

const STORE_ABI = [
  "event Purchased(address indexed buyer,uint256 indexed skuId,uint256 priceUSDC,address sponsor,address[8] uplines,uint256[8] levelPaid,uint256 storehouseAmt,uint256 wipAmt)"
];

const NFT_ABI = [
  "function name() view returns (string)"
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return withCors({ ok: true });
  if (event.httpMethod !== 'POST') return withCors({ error: 'Method not allowed' }, 405);

  try {
    const {
      SIGNER_PK, CONTRACT_ADDR, RPC_URL, STORE_ADDR,
      DOMAIN_NAME, DOMAIN_VERSION, TIER_OFFSET, MIN_TIER
    } = process.env;
    if (!SIGNER_PK || !CONTRACT_ADDR || !RPC_URL || !STORE_ADDR) {
      return withCors({ error: 'Missing env: SIGNER_PK, CONTRACT_ADDR, RPC_URL, STORE_ADDR' }, 500);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(SIGNER_PK, provider);
    const signerAddress = await wallet.getAddress();

    const body = JSON.parse(event.body || '{}');
    let { orderId, txHash, to, tier, tokenURI } = body;
    if (!to) return withCors({ error: 'Invalid payload. Expect {to,...}' }, 400);
    if (!ethers.isAddress(to)) return withCors({ error: 'Invalid address' }, 400);

    let buyer = null, skuId = null;

    // If a tx hash was provided, verify the store purchase + buyer
    if (txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) return withCors({ error: 'Invalid or failed transaction' }, 400);

      const iface = new ethers.Interface(STORE_ABI);
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

      // Map tier safely: default to skuId, enforce >=1, optional offset
      const envOffset = Number(TIER_OFFSET || 0);
      const minTier = Number(MIN_TIER || 1);
      let t = Number(tier);
      if (!Number.isFinite(t) || t <= 0) t = Number(skuId);
      if (!Number.isFinite(t)) t = 1;
      t = t + envOffset;
      if (t < minTier) t = minTier;
      tier = t;

      orderId = txHash; // unique per purchase
    }

    if (!orderId) return withCors({ error: 'Provide orderId or txHash' }, 400);

    // Build domain name from on-chain name(), allow env override
    const nft = new ethers.Contract(CONTRACT_ADDR, NFT_ABI, provider);
    let tokenName = 'DreamPlay Membership';
    try { tokenName = await nft.name(); } catch (_) {}
    const domainName = (DOMAIN_NAME && DOMAIN_NAME.trim()) || tokenName;

    const { chainId } = await provider.getNetwork();
    const envVersion = (DOMAIN_VERSION && DOMAIN_VERSION.trim()) || null;
    const versions = Array.from(new Set([envVersion, '1', '0', '2'].filter(Boolean)));

    const withTokenURI = typeof tokenURI === 'string' && tokenURI.length > 0;
    const layouts = withTokenURI
      ? [
          { includeTokenURI: true,  types: { Claim: [
            { name:'to', type:'address' },
            { name:'tier', type:'uint8' },
            { name:'orderHash', type:'bytes32' },
            { name:'tokenURI', type:'string' }
          ]}},
          { includeTokenURI: false, types: { Claim: [
            { name:'to', type:'address' },
            { name:'tier', type:'uint8' },
            { name:'orderHash', type:'bytes32' }
          ]}}
        ]
      : [
          { includeTokenURI: false, types: { Claim: [
            { name:'to', type:'address' },
            { name:'tier', type:'uint8' },
            { name:'orderHash', type:'bytes32' }
          ]}},
          { includeTokenURI: true,  types: { Claim: [
            { name:'to', type:'address' },
            { name:'tier', type:'uint8' },
            { name:'orderHash', type:'bytes32' },
            { name:'tokenURI', type:'string' }
          ]}}
        ];

    const orderHash = ethers.id(String(orderId));
    const sigs = [];

    for (const v of versions) {
      for (const layout of layouts) {
        const domain = { name: domainName, version: v, chainId, verifyingContract: CONTRACT_ADDR };
        const value  = layout.includeTokenURI
          ? { to, tier: Number(tier), orderHash, tokenURI }
          : { to, tier: Number(tier), orderHash };
        try {
          const sig = await wallet.signTypedData(domain, layout.types, value);
          const { v:V, r, s } = ethers.Signature.from(sig);
          sigs.push({
            v: V, r, s,
            orderHash,
            tier: Number(tier),
            domainName,
            domainVersion: v,
            chainId,
            signerAddress,
            includeTokenURI: layout.includeTokenURI
          });
        } catch (_) { /* try next */ }
      }
    }

    if (!sigs.length) {
      return withCors({ error: 'no_signature_candidates' }, 500);
    }

    return withCors({
      candidates: sigs,
      buyer, skuId
    });
  } catch (err) {
    console.error(err);
    return withCors({ error: 'server_error', detail: String(err?.message || String(err)) }, 500);
  }
};
