#!/usr/bin/env node

/**
 * Stellar Integration Verification Script
 * 
 * This script verifies that all required Stellar integration points
 * are properly configured and accessible for the network submission.
 */

const https = require('https');
const http = require('http');

// Configuration
const BASE_URL = process.env.VERIFICATION_URL || 'http://localhost:5000';
const TESTNET_ACCOUNT = 'GCKFBEIYTKP5RDBKIXFJ2HBMKQCGGWBMVCKQRHFKJQXQX7KQXQXQXQXQ'; // Example testnet account

console.log('🔍 Verifying Stellar Integration for AfriPay...\n');
console.log(`Base URL: ${BASE_URL}\n`);

/**
 * Make HTTP request and return response
 */
function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    
    if (options.body) {
      req.write(options.body);
    }
    
    req.end();
  });
}

/**
 * Test stellar.toml accessibility and content
 */
async function testStellarToml() {
  console.log('📋 Testing stellar.toml...');
  
  try {
    const response = await makeRequest(`${BASE_URL}/.well-known/stellar.toml`);
    
    if (response.statusCode === 200) {
      console.log('✅ stellar.toml is accessible');
      
      // Check content type
      if (response.headers['content-type']?.includes('text/plain')) {
        console.log('✅ Correct content-type: text/plain');
      } else {
        console.log('⚠️  Content-type should be text/plain');
      }
      
      // Check CORS headers
      if (response.headers['access-control-allow-origin'] === '*') {
        console.log('✅ CORS headers properly configured');
      } else {
        console.log('⚠️  CORS headers missing or incorrect');
      }
      
      // Parse and validate content
      const tomlContent = response.body;
      const requiredFields = [
        'FEDERATION_SERVER',
        'HORIZON_SERVER', 
        'NETWORK_PASSPHRASE',
        'ORG_NAME',
        'ORG_URL'
      ];
      
      let missingFields = [];
      requiredFields.forEach(field => {
        if (!tomlContent.includes(field)) {
          missingFields.push(field);
        }
      });
      
      if (missingFields.length === 0) {
        console.log('✅ All required TOML fields present');
      } else {
        console.log(`⚠️  Missing TOML fields: ${missingFields.join(', ')}`);
      }
      
      console.log('\n📄 stellar.toml content preview:');
      console.log(tomlContent.substring(0, 300) + '...\n');
      
    } else {
      console.log(`❌ stellar.toml not accessible (Status: ${response.statusCode})`);
    }
  } catch (error) {
    console.log(`❌ Error accessing stellar.toml: ${error.message}`);
  }
}

/**
 * Test SEP-10 authentication endpoints
 */
async function testSEP10() {
  console.log('🔐 Testing SEP-10 Web Authentication...');
  
  try {
    // Test challenge endpoint
    const challengeUrl = `${BASE_URL}/.well-known/stellar/web_auth?account=${TESTNET_ACCOUNT}`;
    const challengeResponse = await makeRequest(challengeUrl);
    
    if (challengeResponse.statusCode === 200) {
      console.log('✅ SEP-10 challenge endpoint accessible');
      
      try {
        const challengeData = JSON.parse(challengeResponse.body);
        if (challengeData.transaction && challengeData.network_passphrase) {
          console.log('✅ Challenge response contains required fields');
          console.log(`   Network: ${challengeData.network_passphrase}`);
        } else {
          console.log('⚠️  Challenge response missing required fields');
        }
      } catch (e) {
        console.log('⚠️  Challenge response is not valid JSON');
      }
    } else {
      console.log(`❌ SEP-10 challenge endpoint error (Status: ${challengeResponse.statusCode})`);
    }
    
    // Test POST endpoint (without valid signature, just check if it responds)
    const postOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ transaction: 'test' })
    };
    
    const postResponse = await makeRequest(`${BASE_URL}/.well-known/stellar/web_auth`, postOptions);
    
    if (postResponse.statusCode === 400) {
      console.log('✅ SEP-10 POST endpoint responds correctly to invalid input');
    } else {
      console.log(`⚠️  SEP-10 POST endpoint unexpected response (Status: ${postResponse.statusCode})`);
    }
    
  } catch (error) {
    console.log(`❌ Error testing SEP-10: ${error.message}`);
  }
  
  console.log();
}

/**
 * Test health endpoint
 */
async function testHealth() {
  console.log('🏥 Testing health endpoint...');
  
  try {
    const response = await makeRequest(`${BASE_URL}/health`);
    
    if (response.statusCode === 200) {
      console.log('✅ Health endpoint accessible');
      
      try {
        const healthData = JSON.parse(response.body);
        console.log(`   Status: ${healthData.status}`);
        console.log(`   Network: ${healthData.network}`);
        console.log(`   Database: ${healthData.db}`);
        console.log(`   Stellar: ${healthData.stellar}`);
      } catch (e) {
        console.log('⚠️  Health response is not valid JSON');
      }
    } else {
      console.log(`❌ Health endpoint error (Status: ${response.statusCode})`);
    }
  } catch (error) {
    console.log(`❌ Error testing health: ${error.message}`);
  }
  
  console.log();
}

/**
 * Test API documentation
 */
async function testAPIDocs() {
  console.log('📚 Testing API documentation...');
  
  try {
    const response = await makeRequest(`${BASE_URL}/api/docs`);
    
    if (response.statusCode === 200) {
      console.log('✅ API documentation accessible at /api/docs');
    } else {
      console.log(`⚠️  API documentation not accessible (Status: ${response.statusCode})`);
    }
  } catch (error) {
    console.log(`❌ Error accessing API docs: ${error.message}`);
  }
  
  console.log();
}

/**
 * Main verification function
 */
async function runVerification() {
  console.log('Starting Stellar integration verification...\n');
  
  await testStellarToml();
  await testSEP10();
  await testHealth();
  await testAPIDocs();
  
  console.log('🎉 Verification complete!');
  console.log('\n📝 Next steps for Stellar submission:');
  console.log('1. Deploy to production environment');
  console.log('2. Update STELLAR_SUBMISSION.md with production URLs');
  console.log('3. Record demo video showing key features');
  console.log('4. Submit to Stellar ecosystem directory');
  console.log('5. Generate live testnet transaction hashes');
}

// Run verification
runVerification().catch(console.error);