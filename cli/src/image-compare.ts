import sharp from 'sharp';

export type CompareOutcome = {
  match: boolean;
  reason?: string;
};

export async function compareWithSharp(
  expectedPath: string,
  actualPath: string,
  diffPath: string,
  options: { threshold: number },
): Promise<CompareOutcome> {
  // Load images
  const expected = sharp(expectedPath).ensureAlpha();
  const actual = sharp(actualPath).ensureAlpha();

  const expectedMeta = await expected.metadata();
  const actualMeta = await actual.metadata();

  if (!expectedMeta.width || !expectedMeta.height || !actualMeta.width || !actualMeta.height) {
    return { match: false, reason: 'invalid image metadata' };
  }

  // Resize actual to expected if needed to avoid dimension mismatch noise
  const normalizedActual =
    expectedMeta.width === actualMeta.width && expectedMeta.height === actualMeta.height
      ? actual
      : actual.resize({ width: expectedMeta.width, height: expectedMeta.height, fit: 'fill' });

  // Compute absolute difference using blend mode
  const expectedPng = await expected.png().toBuffer();
  const diffImage = sharp(await normalizedActual.png().toBuffer())
    .ensureAlpha()
    .composite([{ input: expectedPng, blend: 'difference' }]);

  // Persist diff image for debugging regardless of match
  await diffImage.png().toFile(diffPath);

  // Compute statistics on diff to decide pass/fail
  const stats = await diffImage.stats();
  // Mean across channels (0..255). Normalize to 0..1 for thresholding
  const channelMeans = stats.channels.map((c) => c.mean);
  const mean255 = channelMeans.reduce((a, b) => a + b, 0) / channelMeans.length;
  const mean01 = mean255 / 255;

  return { match: mean01 <= options.threshold, reason: `meanDiff=${mean01.toFixed(4)}` };
}


