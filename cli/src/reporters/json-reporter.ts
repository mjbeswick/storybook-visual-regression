import fs from 'node:fs';
import path from 'node:path';
import type { FullConfig, Reporter, Suite, TestCase, TestResult } from '@playwright/test/reporter';

type Attempt = { status: string; duration: number; retry: number; error?: string };

type TestOut = {
	storyId?: string;
	title: string;
	name?: string;
	status: 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped';
	duration: number;
	flaky: boolean;
	attempts: Attempt[];
	expectedImagePath?: string;
	actualImagePath?: string;
	diffImagePath?: string;
	attachments?: Array<{ name: string; path?: string; contentType?: string }>;
};

type Summary = {
	status: 'passed' | 'failed' | 'timedout' | 'interrupted';
	startTime: number;
	duration: number;
	totalTests: number;
	passed: number;
	failed: number;
	skipped: number;
	timedOut: number;
	interrupted: number;
	tests: TestOut[];
};

export default class JsonReporter implements Reporter {
	private startTime = Date.now();
	private tests = new Map<string, TestOut>();
	private counts = { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0, interrupted: 0 };

	onBegin(_config: FullConfig, suite: Suite) {
		this.counts.total = suite.allTests().length;
	}

	onTestEnd(test: TestCase, result: TestResult) {
		const key = test.titlePath().join(' > ');
		const prev = this.tests.get(key);
		const attempt: Attempt = {
			status: result.status,
			duration: result.duration,
			retry: result.retry,
			error: result.error ? result.error.message : undefined
		};
		const base: TestOut =
			prev ?? {
				title: key,
				status: result.status as TestOut['status'],
				duration: result.duration,
				flaky: false,
				attempts: []
			};
		base.attempts.push(attempt);
		base.status = result.status as TestOut['status'];
		base.duration = (prev?.duration ?? 0) + result.duration;
		base.flaky = base.attempts.length > 1 && base.attempts.some((a) => a.status === 'failed') && base.status === 'passed';
		this.tests.set(key, base);

		if (result.status === 'passed') this.counts.passed += 1;
		else if (result.status === 'failed') this.counts.failed += 1;
		else if (result.status === 'skipped') this.counts.skipped += 1;
		else if (result.status === 'timedOut') this.counts.timedOut += 1;
		else if (result.status === 'interrupted') this.counts.interrupted += 1;
	}

	onEnd(): void {
		const duration = Date.now() - this.startTime;
		const summary: Summary = {
			status: this.counts.failed > 0 ? 'failed' : 'passed',
			startTime: this.startTime,
			duration,
			totalTests: this.counts.total,
			passed: this.counts.passed,
			failed: this.counts.failed,
			skipped: this.counts.skipped,
			timedOut: this.counts.timedOut,
			interrupted: this.counts.interrupted,
			tests: Array.from(this.tests.values())
		};

		const root = path.resolve(process.cwd(), 'visual-regression/results');
		fs.mkdirSync(root, { recursive: true });
		const file = path.join(root, 'test-results.json');
		fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
		if (process.env.SVR_JSON_STDOUT === '1') {
			process.stdout.write(`${JSON.stringify(summary)}\n`);
		}
	}
}


