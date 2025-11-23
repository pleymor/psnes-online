/**
 * Frontend logger utility
 *
 * Provides structured logging for the frontend with different log levels.
 * In development, logs are pretty-printed to the console.
 * In production, logs can be filtered by level.
 *
 * The DEBUG() function integration allows debug logs to be toggled dynamically
 * via window.setDebug(true/false) without wrapping every call in if(DEBUG()).
 */

import { DEBUG } from '$lib/config/debug';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  context?: string;
  level?: LogLevel;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  private context: string;
  private minLevel: LogLevel;

  constructor(options: LoggerOptions = {}) {
    this.context = options.context || 'App';
    this.minLevel = options.level || this.getDefaultLevel();
  }

  private getDefaultLevel(): LogLevel {
    // In production, default to 'info', in development default to 'debug'
    return import.meta.env.PROD ? 'info' : 'debug';
  }

  private shouldLog(level: LogLevel): boolean {
    // For debug level, also check DEBUG() to respect dynamic debug toggle
    if (level === 'debug' && !DEBUG()) {
      return false;
    }
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private formatMessage(level: LogLevel, message: string, ...args: any[]): void {
    if (!this.shouldLog(level)) return;

    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    const prefix = `[${timestamp}] [${this.context}] [${level.toUpperCase()}]`;

    const styles: Record<LogLevel, string> = {
      debug: 'color: #6b7280', // gray
      info: 'color: #3b82f6', // blue
      warn: 'color: #f59e0b', // orange
      error: 'color: #ef4444' // red
    };

    if (import.meta.env.DEV) {
      // Pretty print in development with colors
      console.log(`%c${prefix}`, styles[level], message, ...args);
    } else {
      // Structured logging in production
      const logData = {
        timestamp: new Date().toISOString(),
        level,
        context: this.context,
        message,
        ...(args.length > 0 && { data: args })
      };
      console.log(JSON.stringify(logData));
    }
  }

  debug(message: string, ...args: any[]): void {
    this.formatMessage('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.formatMessage('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.formatMessage('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.formatMessage('error', message, ...args);
  }

  /**
   * Create a child logger with a specific context
   */
  child(context: string): Logger {
    return new Logger({
      context: `${this.context}:${context}`,
      level: this.minLevel
    });
  }
}

/**
 * Default logger instance
 */
export const logger = new Logger();

/**
 * Create a logger with a specific context
 */
export function createLogger(context: string, level?: LogLevel): Logger {
  return new Logger({ context, level });
}
