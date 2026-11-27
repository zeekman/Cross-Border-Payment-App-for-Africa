#!/usr/bin/env node
/**
 * Backend smoke test: verify that every module in routes/, controllers/, services/, and jobs/
 * can be required without throwing, that all source files pass node --check syntax validation,
 * and that the server starts cleanly against CI Postgres/Redis and responds to /health.
 *
 * This catches:
 * - Truncated or malformed JS (parse errors, missing closing braces)
 * - Controllers missing exports
 * - Undefined middleware (e.g., readLimiter)
 * - Un-imported functions (e.g., getMe)
 * - Missing Sentry.Handlers references
 * - Circular or broken require() paths
 *
 * Run with:
 *   NODE_ENV=test DATABASE_URL=postgresql://... REDIS_URL=redis://... node scripts/smoke-test.js
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = syntax check, require check, or server start failed
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const SRC_DIR = path.join(__dirname, '../src');
const CHECK_DIRS = ['routes', 'controllers', 'services', 'jobs'];
const HEALTH_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 45_000;

let failures = [];

function log(msg) {
  console.log(`[smoke-test] ${msg}`);
}

function findJsFiles(dir, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__' && entry.name !== '__mocks__') {
      findJsFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Step 1: Syntax check with node --check
log('Step 1: Syntax validation (node --check) for all backend/src/**/*.js');
const allFiles = findJsFiles(SRC_DIR);
log(`Found ${allFiles.length} JS files`);

for (const file of allFiles) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    failures.push(`Syntax error in ${path.relative(SRC_DIR, file)}: ${err.stderr.trim()}`);
  }
}

if (failures.length > 0) {
  console.error('\n❌ Syntax check failures:');
  failures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
log('✅ All files passed syntax check');

// Step 2: Require every module in routes, controllers, services, jobs
log('Step 2: Require check for routes/, controllers/, services/, jobs/');

const requireFailures = [];
for (const dir of CHECK_DIRS) {
  const dirPath = path.join(SRC_DIR, dir);
  if (!fs.existsSync(dirPath)) {
    log(`⚠️  Directory ${dir} does not exist, skipping`);
    continue;
  }
  const files = findJsFiles(dirPath);
  log(`  Checking ${files.length} files in ${dir}/`);
  
  for (const file of files) {
    const relPath = path.relative(SRC_DIR, file);
    // Skip test files and mocks
    if (relPath.includes('__tests__') || relPath.includes('__mocks__')) continue;
    
    try {
      // Clear module cache to ensure fresh require
      delete require.cache[require.resolve(file)];
      require(file);
    } catch (err) {
      requireFailures.push(`Failed to require ${relPath}: ${err.message}`);
    }
  }
}

if (requireFailures.length > 0) {
  console.error('\n❌ Require check failures:');
  requireFailures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
log('✅ All modules required successfully');

// Step 3: Resolve every relative require() path
log('Step 3: Validating all require() paths resolve to existing files');
const pathFailures = [];

for (const file of allFiles) {
  const content = fs.readFileSync(file, 'utf8');
  // Match require('...') and require("...")
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  
  while ((match = requirePattern.exec(content)) !== null) {
    const reqPath = match[1];
    // Only check relative paths
    if (!reqPath.startsWith('.')) continue;
    
    const baseDir = path.dirname(file);
    let resolved = path.resolve(baseDir, reqPath);
    
    // Try with and without .js extension
    let exists = fs.existsSync(resolved);
    if (!exists && !resolved.endsWith('.js')) {
      resolved += '.js';
      exists = fs.existsSync(resolved);
    }
    
    if (!exists) {
      // Check if it's a directory with index.js
      const indexPath = path.join(path.resolve(baseDir, reqPath), 'index.js');
      exists = fs.existsSync(indexPath);
    }
    
    if (!exists) {
      const relFile = path.relative(SRC_DIR, file);
      pathFailures.push(`${relFile}: require('${reqPath}') does not resolve`);
    }
  }
}

if (pathFailures.length > 0) {
  console.error('\n❌ Unresolved require() paths:');
  pathFailures.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
log('✅ All require() paths resolve successfully');

// Step 4: Start the server and check /health endpoint
log('Step 4: Starting server and checking /health endpoint');

// Validate required env vars
const requiredEnv = ['DATABASE_URL', 'JWT_SECRET'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// Spawn server process
const serverProcess = spawn('node', [path.join(SRC_DIR, 'index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0', // Use random available port
    // Disable Stellar network calls
    STELLAR_NETWORK: 'mock'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
let serverPort = null;
let serverStarted = false;
let healthCheckPassed = false;

// Capture server output to find the port
serverProcess.stdout.on('data', (data) => {
  const output = data.toString();
  serverOutput += output;
  
  // Look for port in output: "Server running on port 5000"
  const portMatch = output.match(/Server running on port (\d+)/);
  if (portMatch && !serverStarted) {
    serverPort = portMatch[1];
    serverStarted = true;
    log(`Server started on port ${serverPort}`);
    checkHealth();
  }
});

serverProcess.stderr.on('data', (data) => {
  serverOutput += data.toString();
});

serverProcess.on('exit', (code, signal) => {
  if (!healthCheckPassed) {
    console.error(`❌ Server exited unexpectedly (code ${code}, signal ${signal})`);
    console.error('Server output:');
    console.error(serverOutput);
    process.exit(1);
  }
});

// Startup timeout
const startupTimeout = setTimeout(() => {
  if (!serverStarted) {
    console.error(`❌ Server did not start within ${STARTUP_TIMEOUT_MS}ms`);
    console.error('Server output:');
    console.error(serverOutput);
    serverProcess.kill('SIGTERM');
    setTimeout(() => serverProcess.kill('SIGKILL'), 2000);
    process.exit(1);
  }
}, STARTUP_TIMEOUT_MS);

function checkHealth() {
  clearTimeout(startupTimeout);
  
  const http = require('http');
  const startTime = Date.now();
  
  function attemptHealthCheck() {
    const req = http.get(`http://localhost:${serverPort}/api/health`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          log(`✅ /health returned 200 OK (took ${Date.now() - startTime}ms)`);
          healthCheckPassed = true;
          
          // Graceful shutdown
          log('Shutting down server');
          serverProcess.kill('SIGTERM');
          
          setTimeout(() => {
            if (!serverProcess.killed) {
              serverProcess.kill('SIGKILL');
            }
            log('✅ Smoke test completed successfully');
            process.exit(0);
          }, 2000);
        } else {
          console.error(`❌ /health returned ${res.statusCode}, expected 200`);
          console.error(`Response: ${body}`);
          serverProcess.kill('SIGTERM');
          setTimeout(() => serverProcess.kill('SIGKILL'), 2000);
          process.exit(1);
        }
      });
    });
    
    req.on('error', (err) => {
      if (Date.now() - startTime < HEALTH_TIMEOUT_MS) {
        // Retry after short delay
        setTimeout(attemptHealthCheck, 500);
      } else {
        console.error(`❌ /health check failed after ${HEALTH_TIMEOUT_MS}ms: ${err.message}`);
        console.error('Server output:');
        console.error(serverOutput);
        serverProcess.kill('SIGTERM');
        setTimeout(() => serverProcess.kill('SIGKILL'), 2000);
        process.exit(1);
      }
    });
    
    req.end();
  }
  
  // Start health check attempts
  attemptHealthCheck();
}

// Handle script termination
process.on('SIGTERM', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => serverProcess.kill('SIGKILL'), 2000);
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => serverProcess.kill('SIGKILL'), 2000);
  }
  process.exit(1);
});
