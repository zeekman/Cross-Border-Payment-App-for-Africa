const StellarSdk = require('@stellar/stellar-sdk');

// Decode Stellar XDR into human-readable JSON
async function decodeXDR(req, res, next) {
  try {
    const { xdr } = req.body;

    if (!xdr) {
      const err = new Error('XDR string is required');
      err.status = 400;
      throw err;
    }

    const envelope = StellarSdk.TransactionEnvelope.fromXDR(xdr, StellarSdk.Networks.TESTNET);
    const transaction = envelope.v1 ? envelope.v1().tx() : envelope.v0().tx();

    const decoded = {
      sourceAccount: transaction.sourceAccount().accountId().publicKey().toString('hex'),
      fee: transaction.fee().toString(),
      seqNum: transaction.seqNum().toString(),
      memo: transaction.memo() ? transaction.memo().value()?.toString() : null,
      operations: []
    };

    for (let i = 0; i < transaction.operations().length; i++) {
      const op = transaction.operations()[i];
      const opBody = op.body();
      
      decoded.operations.push({
        type: opBody.switch().name,
        sourceAccount: op.sourceAccount() ? op.sourceAccount().accountId().publicKey().toString('hex') : null,
        details: opBody.value()
      });
    }

    res.json({ decoded });
  } catch (err) {
    err.status = 400;
    err.message = 'Invalid XDR: ' + err.message;
    next(err);
  }
}

module.exports = { decodeXDR };
