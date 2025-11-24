import dotenv from 'dotenv';
import { join } from 'path';
import { jest } from '@jest/globals';

// Load test environment variables
dotenv.config({ path: join(process.cwd(), '.env.test') });

// Global test timeout
jest.setTimeout(30000);

// Mock logger to avoid cluttering test output
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    })),
  },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
  })),
}));
