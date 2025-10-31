#!/usr/bin/env node
import { resolveConfig, saveEffectiveConfig, type CliFlags } from '../config.js';
import { run } from '../core/VisualRegressionRunner.js';

const parseArgs = (argv: string[]): CliFlags => {
  const out: CliFlags = {};
  const getVal = (i: number): string | undefined => argv[i + 1];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        out.debug = out.debug;
        /* no-op to mark presence */ break;
      case '--log-level':
        out.logLevel = getVal(i) as any;
        i += 1;
        break;
      case '--config':
        out.config = getVal(i);
        i += 1;
        break;
      case '-u':
      case '--url':
        out.url = getVal(i);
        i += 1;
        break;
      case '-o':
      case '--output':
        out.output = getVal(i);
        i += 1;
        break;
      case '-w':
      case '--workers':
        out.workers = Number(getVal(i));
        i += 1;
        break;
      case '-c':
      case '--command':
        out.command = getVal(i);
        i += 1;
        break;
      case '--webserver-timeout':
        out.webserverTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--retries':
        out.retries = Number(getVal(i));
        i += 1;
        break;
      case '--max-failures':
        out.maxFailures = Number(getVal(i));
        i += 1;
        break;
      case '--timezone':
        out.timezone = getVal(i);
        i += 1;
        break;
      case '--locale':
        out.locale = getVal(i);
        i += 1;
        break;
      case '--quiet':
        out.quiet = true;
        break;
      case '--debug':
        out.debug = true;
        break;
      case '--progress':
        out.showProgress = true;
        break;
      case '--browser':
        out.browser = getVal(i) as any;
        i += 1;
        break;
      case '--threshold':
        out.threshold = Number(getVal(i));
        i += 1;
        break;
      case '--max-diff-pixels':
        out.maxDiffPixels = Number(getVal(i));
        i += 1;
        break;
      case '--full-page':
        out.fullPage = true;
        break;
      case '--overlay-timeout':
        out.overlayTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--test-timeout':
        out.testTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--snapshot-retries':
        out.snapshotRetries = Number(getVal(i));
        i += 1;
        break;
      case '--snapshot-delay':
        out.snapshotDelay = Number(getVal(i));
        i += 1;
        break;
      case '--mutation-wait':
        out.mutationWait = Number(getVal(i));
        i += 1;
        break;
      case '--mutation-timeout':
        out.mutationTimeout = Number(getVal(i));
        i += 1;
        break;
      case '--grep':
        out.grep = getVal(i);
        i += 1;
        break;
      case '--include':
        out.include = getVal(i);
        i += 1;
        break;
      case '--exclude':
        out.exclude = getVal(i);
        i += 1;
        break;
      case '--install-browsers':
        out.installBrowsers = getVal(i) ?? true;
        if (getVal(i)) i += 1;
        break;
      case '--install-deps':
        out.installDeps = true;
        break;
      case '--not-found-check':
        out.notFoundCheck = true;
        break;
      case '--not-found-retry-delay':
        out.notFoundRetryDelay = Number(getVal(i));
        i += 1;
        break;
      case '--update':
        out.update = true;
        break;
      case '--missing-only':
        out.missingOnly = true;
        break;
      case '--failed-only':
        out.failedOnly = true;
        break;
      case '--save-config':
        out.saveConfig = true;
        break;
      default:
        break;
    }
  }
  return out;
};

const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      `storybook-visual-regression\n\n` +
        `Usage:\n  svr [options]\n\n` +
        `Options:\n` +
        `  -u, --url <url>                 Storybook URL (default http://localhost:6006)\n` +
        `  -o, --output <dir>              Output root (default visual-regression)\n` +
        `  -w, --workers <n>               Parallel workers\n` +
        `  --retries <n>                   Playwright retries\n` +
        `  --max-failures <n>              Bail after N failures\n` +
        `  --browser <name>                chromium|firefox|webkit\n` +
        `  --threshold <0..1>              Diff threshold (default 0.2)\n` +
        `  --max-diff-pixels <n>           Max differing pixels (default 0)\n` +
        `  --full-page                     Full page screenshots\n` +
        `  --mutation-wait <ms>            Quiet window wait (default 200)\n` +
        `  --mutation-timeout <ms>         Quiet wait cap (default 1000)\n` +
        `  --snapshot-retries <n>          Capture retries (default 1)\n` +
        `  --snapshot-delay <ms>           Delay between retries\n` +
        `  --include <patterns>            Comma-separated include filters\n` +
        `  --exclude <patterns>            Comma-separated exclude filters\n` +
        `  --grep <regex>                  Filter by storyId\n` +
        `  --update                        Update baselines\n` +
        `  --missing-only                  Create only missing baselines\n` +
        `  --failed-only                   Rerun only previously failed\n` +
        `  --progress                      Show progress during run\n` +
        `  --log-level <level>             silent|error|warn|info|debug\n` +
        `  --save-config                   Write effective config JSON\n` +
        `  -h, --help                      Show help\n`,
    );
    return 0;
  }
  const flags = parseArgs(argv);
  const config = resolveConfig(flags);
  if (flags.saveConfig) {
    saveEffectiveConfig(config, 'storybook-visual-regression.config.json');
  }
  const code = await run(config);
  return code;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
