import type { Reporter } from '@playwright/test/reporter';

class SilentReporter implements Reporter {
  onBegin(): void {
    // Suppress all output
  }

  onTestBegin(): void {
    // Suppress all output
  }

  onTestEnd(): void {
    // Suppress all output
  }

  onEnd(): void {
    // Suppress all output
  }

  onStdOut(): void {
    // Suppress all output
  }

  onStdErr(): void {
    // Suppress all output
  }
}

export default SilentReporter;
