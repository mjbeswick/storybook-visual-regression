import { describe, it, expect } from 'vitest';

describe('Basic Test Setup', () => {
  it('should work', () => {
    expect(1 + 1).toBe(2);
  });

  it('should have access to environment', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });
});
