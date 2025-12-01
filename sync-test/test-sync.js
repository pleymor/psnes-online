#!/usr/bin/env node

/**
 * Dual WasmEmulator Sync Test Runner
 *
 * Uses Playwright to run the sync test in a headless browser.
 * Monitors emulator synchronization and reports results.
 *
 * Usage:
 *   node test-sync.js              # Run headless
 *   node test-sync.js --headed     # Run with visible browser
 *   node test-sync.js --verbose    # Show browser console logs
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const CONFIG = {
  port: 9999,
  headed: process.argv.includes('--headed'),
  verbose: process.argv.includes('--verbose') || process.argv.includes('-v'),
  timeout: 180000, // 3 minutes max
};

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(msg, color = c.reset) {
  console.log(`${color}${msg}${c.reset}`);
}

function logHeader(msg) {
  console.log();
  log('='.repeat(60), c.cyan);
  log(` ${msg}`, c.bright + c.cyan);
  log('='.repeat(60), c.cyan);
}

function logStep(step, msg) {
  log(`[${step}] ${msg}`, c.blue);
}

function logSuccess(msg) {
  log(`✓ ${msg}`, c.green);
}

function logError(msg) {
  log(`✗ ${msg}`, c.red);
}

// Start Vite dev server
async function startViteServer() {
  return new Promise((resolve, reject) => {
    logStep('1/5', 'Starting Vite dev server...');

    const vite = spawn('npx', ['vite', '--port', CONFIG.port.toString()], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let output = '';

    vite.stdout.on('data', (data) => {
      output += data.toString();
      if (CONFIG.verbose) console.log(c.dim + data.toString() + c.reset);

      if (!started && output.includes('localhost:')) {
        started = true;
        // Extract actual port (might be different if 9999 was in use)
        const match = output.match(/localhost:(\d+)/);
        const actualPort = match ? parseInt(match[1]) : CONFIG.port;
        logSuccess(`Vite server running on port ${actualPort}`);
        resolve({ vite, port: actualPort });
      }
    });

    vite.stderr.on('data', (data) => {
      if (CONFIG.verbose) console.error(c.yellow + data.toString() + c.reset);
    });

    vite.on('error', (err) => {
      reject(new Error(`Failed to start Vite: ${err.message}`));
    });

    setTimeout(() => {
      if (!started) {
        vite.kill();
        reject(new Error('Vite server failed to start within timeout'));
      }
    }, 30000);
  });
}

// Run the test in Playwright
async function runTest(port) {
  logStep('2/5', `Launching browser (headed: ${CONFIG.headed})...`);

  const browser = await chromium.launch({
    headless: !CONFIG.headed,
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture console logs
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (CONFIG.verbose || type === 'error') {
      const prefix = type === 'error' ? c.red : c.dim;
      console.log(`${prefix}[browser] ${text}${c.reset}`);
    }
  });

  page.on('pageerror', (err) => {
    logError(`Page error: ${err.message}`);
  });

  logSuccess('Browser launched');
  logStep('3/5', 'Loading test page...');

  try {
    await page.goto(`http://localhost:${port}/`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    logSuccess('Test page loaded');

    logStep('4/5', 'Waiting for emulators to initialize...');

    // Wait for emulators to be ready (up to 90 seconds)
    await page.waitForFunction(
      () => window.__emulatorsReady === true,
      { timeout: 90000 }
    );
    logSuccess('Emulators initialized');

    logStep('5/5', 'Running sync test...');

    // Start the test and wait for results
    const testResult = await page.evaluate(async () => {
      return await window.testHarness.startTest();
    });

    return { browser, page, testResult };

  } catch (error) {
    await browser.close();
    throw error;
  }
}

// Print results
function printResults(testResult) {
  logHeader('TEST RESULTS');

  console.log();
  log(`  Total Frames:    ${testResult.totalFrames}`, c.bright);
  log(`  Sync Checks:     ${testResult.syncChecks}`, c.bright);
  log(`  Matches:         ${testResult.syncMatches}`, c.green);
  log(`  Mismatches:      ${testResult.syncMismatches}`,
      testResult.syncMismatches > 0 ? c.red : c.green);
  console.log();

  if (testResult.passed) {
    logSuccess('TEST PASSED - Both emulators maintained perfect sync!');
  } else {
    logError('TEST FAILED - Emulators went out of sync!');

    // Show relevant log entries
    if (testResult.logs) {
      console.log();
      log('Recent log entries:', c.yellow);
      const errorLogs = testResult.logs.filter(l => l.type === 'error').slice(-5);
      for (const entry of errorLogs) {
        console.log(`  ${c.red}${entry.message}${c.reset}`);
      }
    }
  }
}

// Main
async function main() {
  logHeader('DUAL WASEMULATOR SYNC TEST');

  let viteProcess = null;
  let browser = null;

  try {
    const { vite, port } = await startViteServer();
    viteProcess = vite;

    // Give Vite a moment to fully initialize
    await new Promise(r => setTimeout(r, 2000));

    const { browser: b, testResult } = await runTest(port);
    browser = b;

    printResults(testResult);

    // Cleanup
    await browser.close();
    viteProcess.kill();

    process.exit(testResult.passed ? 0 : 1);

  } catch (error) {
    logError(`Test failed: ${error.message}`);
    if (CONFIG.verbose) console.error(error);

    if (browser) await browser.close().catch(() => {});
    if (viteProcess) viteProcess.kill();

    process.exit(1);
  }
}

process.on('SIGINT', () => {
  log('\nInterrupted, cleaning up...', c.yellow);
  process.exit(130);
});

main();
