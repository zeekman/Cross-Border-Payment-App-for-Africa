const router = require('express').Router();
const generateStellarToml = require('../config/stellar.toml');

router.get('/.well-known/stellar.toml', (req, res) => {
  const toml = generateStellarToml();
  res.set('Content-Type', 'text/plain');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(toml);
});

module.exports = router;
