#!/usr/bin/env node

/**
 * AfriPay Demo Integration Script
 * 
 * This script demonstrates the key features of AfriPay's Stellar integration
 * for the network submission demo video.
 */

const StellarSDK = require('@stellar/stellar-sdk');
const fetch = require('node-fetch'); // You may need to install: npm install node-fetch

// Configuration
const API_BASE = process.env.API_BASE || 'http://localhost:5000';
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

// Demo accounts (testnet)
const SENDER_SECRET = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // Replace with actual testnet secret
const RECEIVER_PUBLIC = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'; // Replace with actual testnet account

console.log('🚀 AfriPay Stellar Integration Demo\n');

/**
 * Demo 1: SEP-10 Authentication
 */
async function demoSEP10Auth() {
  console.log('🔐 Demo 1: SEP-10 Web Authentication');
  console.log('=====================================\n');
  
  try {
    // Step 1: Get challenge
    console.log('Step 1: Requesting authentication challenge...');
    const senderKeypair = StellarSDK.Keypair.fromSecret(SENDER_SECRET);
    const senderPublic = senderKeypair.publicKey();
    
    const challengeResponse = await fetch(
      `${API_BASE}/.well-known/stellar/web_auth?account=${senderPublic}`
    );
    const challengeData = await challengeResponse.json();
    
    console.log('✅ Challenge received');
    console.log(`   Network: ${challengeData.network_passphrase}`);
    
    // Step 2: Sign challenge
    console.log('\nStep 2: Signing challenge transaction...');
    const transaction = StellarSDK.TransactionEnvelope.fromXDR(
      challengeData.transaction,
      challengeData.network_passphrase
    );
    
    transaction.sign(senderKeypair);
    const signedXDR = transaction.toXDR();
    
    console.log('✅ Challenge signed');
    
    // Step 3: Submit signed challenge
    console.log('\nStep 3: Submitting signed challenge...');
    const authResponse = await fetch(`${API_BASE}/.well-known/stellar/web_auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXDR })
    });
    
    const authData = await authResponse.json();
    
    if (authData.token) {
      console.log('✅ Authentication successful!');
      console.log(`   JWT Token: ${authData.token.substring(0, 50)}...`);
      return authData.token;
    } else {
      console.log('❌ Authentication failed');
      return null;
    }
    
  } catch (error) {
    console.log(`❌ SEP-10 Demo Error: ${error.message}`);
    return null;
  }
}

/**
 * Demo 2: Payment Estimation
 */
async function demoPaymentEstimation(token) {
  console.log('\n\n💰 Demo 2: Payment Fee Estimation');
  console.log('==================================\n');
  
  try {
    console.log('Estimating fee for 100 XLM payment...');
    
    const response = await fetch(`${API_BASE}/api/payments/estimate-fee`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        destination: RECEIVER_PUBLIC,
        amount: '100',
        asset_code: 'XLM'
      })
    });
    
    const feeData = await response.json();
    
    if (response.ok) {
      console.log('✅ Fee estimation successful:');
      console.log(`   Base Fee: ${feeData.base_fee} stroops`);
      console.log(`   Estimated Fee: ${feeData.estimated_fee} XLM`);
      console.log(`   Network: ${feeData.network}`);
    } else {
      console.log(`❌ Fee estimation failed: ${feeData.error}`);
    }
    
  } catch (error) {
    console.log(`❌ Payment Estimation Error: ${error.message}`);
  }
}

/**
 * Demo 3: Path Payment Discovery
 */
async function demoPathPayment(token) {
  console.log('\n\n🛤️  Demo 3: Path Payment Discovery');
  console.log('===================================\n');
  
  try {
    console.log('Finding payment path: USDC → XLM...');
    
    const response = await fetch(`${API_BASE}/api/payments/find-path`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        source_asset_code: 'USDC',
        source_asset_issuer: 'GBBD47UZQ5SYWDRR646Z5A6PHORATE4MQ5GZPMRNQE34UFNKSUWFM7V',
        destination_asset_code: 'XLM',
        destination_amount: '50'
      })
    });
    
    const pathData = await response.json();
    
    if (response.ok && pathData.records?.length > 0) {
      console.log('✅ Payment path found:');
      console.log(`   Source Amount: ${pathData.records[0].source_amount} USDC`);
      console.log(`   Destination Amount: ${pathData.records[0].destination_amount} XLM`);
      console.log(`   Path Length: ${pathData.records[0].path?.length || 0} hops`);
    } else {
      console.log('⚠️  No payment path found or error occurred');
    }
    
  } catch (error) {
    console.log(`❌ Path Payment Error: ${error.message}`);
  }
}

/**
 * Demo 4: Transaction History
 */
async function demoTransactionHistory(token) {
  console.log('\n\n📊 Demo 4: Transaction History');
  console.log('==============================\n');
  
  try {
    console.log('Fetching recent transaction history...');
    
    const response = await fetch(`${API_BASE}/api/payments/history?limit=5`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const historyData = await response.json();
    
    if (response.ok) {
      console.log(`✅ Found ${historyData.records?.length || 0} recent transactions:`);
      
      historyData.records?.slice(0, 3).forEach((tx, index) => {
        console.log(`   ${index + 1}. ${tx.type} - ${tx.amount} ${tx.asset_code || 'XLM'}`);
        console.log(`      Hash: ${tx.transaction_hash?.substring(0, 20)}...`);
        console.log(`      Date: ${new Date(tx.created_at).toLocaleDateString()}`);
      });
    } else {
      console.log(`❌ History fetch failed: ${historyData.error}`);
    }
    
  } catch (error) {
    console.log(`❌ Transaction History Error: ${error.message}`);
  }
}

/**
 * Demo 5: Health Check
 */
async function demoHealthCheck() {
  console.log('\n\n🏥 Demo 5: System Health Check');
  console.log('===============================\n');
  
  try {
    console.log('Checking system health...');
    
    const response = await fetch(`${API_BASE}/health`);
    const healthData = await response.json();
    
    console.log('✅ Health check results:');
    console.log(`   Overall Status: ${healthData.status}`);
    console.log(`   Database: ${healthData.db}`);
    console.log(`   Stellar Network: ${healthData.stellar}`);
    console.log(`   Network: ${healthData.network}`);
    
    if (healthData.horizon_url) {
      console.log(`   Horizon URL: ${healthData.horizon_url}`);
    }
    
  } catch (error) {
    console.log(`❌ Health Check Error: ${error.message}`);
  }
}

/**
 * Main demo function
 */
async function runDemo() {
  console.log('Starting AfriPay integration demo...\n');
  console.log('This demo showcases key Stellar integration features:\n');
  
  // Check if we have demo accounts configured
  if (SENDER_SECRET.includes('XXXXXXX') || RECEIVER_PUBLIC.includes('XXXXXXX')) {
    console.log('⚠️  Demo accounts not configured. Please set:');
    console.log('   SENDER_SECRET: Testnet secret key');
    console.log('   RECEIVER_PUBLIC: Testnet public key\n');
    console.log('Continuing with limited demo...\n');
  }
  
  // Run health check first
  await demoHealthCheck();
  
  // Only run authenticated demos if we have proper keys
  if (!SENDER_SECRET.includes('XXXXXXX')) {
    // SEP-10 Authentication
    const token = await demoSEP10Auth();
    
    if (token) {
      // Payment features
      await demoPaymentEstimation(token);
      await demoPathPayment(token);
      await demoTransactionHistory(token);
    }
  }
  
  console.log('\n\n🎉 Demo Complete!');
  console.log('\nKey Features Demonstrated:');
  console.log('• SEP-10 Web Authentication with Stellar accounts');
  console.log('• Real-time payment fee estimation');
  console.log('• Cross-currency path payment discovery');
  console.log('• Transaction history and tracking');
  console.log('• System health monitoring');
  console.log('\nFor the full demo video, visit: https://demo.afripay.com');
}

// Handle command line execution
if (require.main === module) {
  runDemo().catch(console.error);
}

module.exports = {
  demoSEP10Auth,
  demoPaymentEstimation,
  demoPathPayment,
  demoTransactionHistory,
  demoHealthCheck
};