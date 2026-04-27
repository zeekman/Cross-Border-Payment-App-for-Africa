const router = require('express').Router();
const { decodeXDR } = require('../controllers/toolsController');

router.post('/decode-xdr', decodeXDR);

module.exports = router;
