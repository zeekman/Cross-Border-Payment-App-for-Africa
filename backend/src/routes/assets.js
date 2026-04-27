const router = require('express').Router();
const { getAssetMetadata } = require('../controllers/assetController');

router.get('/AFRI/info', getAssetMetadata);

module.exports = router;
