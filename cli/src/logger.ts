import chalk from 'chalk';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

type FormatLevel = LogLevel | 'success' | 'trace';

export interface Logger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  success: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
}

// Enhanced logging system with colored output based on log level
export const createLogger = (logLevel: LogLevel): Logger => {
  const levels = ['silent', 'error', 'warn', 'info', 'debug'];
  const currentLevel = levels.indexOf(logLevel);

  // Check if message contains ANSI color codes
  const hasAnsiColors = (message: string): boolean => {
    return /\x1b\[[0-9;]*m/.test(message);
  };

  const formatMessage = (level: FormatLevel, ...args: unknown[]) => {
    const message = args.join(' ');

    // If message already has colors, don't apply additional coloring
    if (hasAnsiColors(message)) {
      return message;
    }

    switch (level) {
      case 'silent':
        return message;
      case 'error':
        return chalk.red(message);
      case 'warn':
        return chalk.yellow(message);
      case 'info':
        return chalk.white(message);
      case 'debug':
        return chalk.gray(message);
      case 'success':
        return chalk.green(message);
      case 'trace':
        return chalk.cyan(message);
    }
  };

  return {
    error: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('error')) {
        console.error(formatMessage('error', ...args));
      }
    },
    warn: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('warn')) {
        console.warn(formatMessage('warn', ...args));
      }
    },
    info: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('info')) {
        console.log(formatMessage('info', ...args));
      }
    },
    debug: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('debug')) {
        console.log(formatMessage('debug', ...args));
      }
    },
    // Additional convenience methods
    success: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('info')) {
        console.log(formatMessage('success', ...args));
      }
    },
    trace: (...args: unknown[]) => {
      if (currentLevel >= levels.indexOf('debug')) {
        console.log(formatMessage('trace', ...args));
      }
    },
  };
};

// Global logger instance - will be initialized with config
let globalLogger: Logger = createLogger('info');

export const setGlobalLogger = (logLevel: LogLevel) => {
  globalLogger = createLogger(logLevel);
};

export const logger = {
  error: (...args: unknown[]) => globalLogger.error(...args),
  warn: (...args: unknown[]) => globalLogger.warn(...args),
  info: (...args: unknown[]) => globalLogger.info(...args),
  debug: (...args: unknown[]) => globalLogger.debug(...args),
  success: (...args: unknown[]) => globalLogger.success(...args),
  trace: (...args: unknown[]) => globalLogger.trace(...args),
};
