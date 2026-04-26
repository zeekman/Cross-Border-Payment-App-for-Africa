module.exports = function generateStellarToml() {
  const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
  const networkPassphrase = isTestnet
    ? 'Test SDF Network ; September 2015'
    : 'Public Global Stellar Network ; September 2015';
  const domain = process.env.FEDERATION_DOMAIN || 'afripay.com';
  const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

  return `# AfriPay Stellar Configuration
FEDERATION_SERVER = "https://${domain}/api/payments/resolve-federation?q={q}&type={type}"
HORIZON_SERVER = "${horizonUrl}"
NETWORK_PASSPHRASE = "${networkPassphrase}"

[[CURRENCIES]]
code = "XLM"
issuer = "native"
name = "Stellar Lumens"
desc = "Native Stellar asset"

[[CURRENCIES]]
code = "USDC"
issuer = "${process.env.USDC_ISSUER || 'GBBD47UZQ5SYWDRR646Z5A6PHORATE4MQ5GZPMRNQE34UFNKSUWFM7V'}"
name = "USD Coin"
desc = "USD Coin on Stellar"

[DOCUMENTATION]
ORG_NAME = "AfriPay"
ORG_URL = "https://${domain}"
ORG_DESCRIPTION = "Cross-border remittance platform for Africa"
ORG_LOGO = "https://${domain}/logo.png"
ORG_SUPPORT_EMAIL = "support@${domain}"

[PRINCIPALS]
name = "AfriPay Admin"
email = "admin@${domain}"
`;
};
