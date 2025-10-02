import type { FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  console.log('🔧 Global setup: Verifying Storybook server is ready...');
  
  const baseURL = process.env.STORYBOOK_URL || 'http://localhost:9009';
  
  try {
    // Check main page
    console.log('Checking Storybook main page...');
    const mainResponse = await fetch(baseURL, { 
      signal: AbortSignal.timeout(10000) 
    });
    
    if (!mainResponse.ok) {
      throw new Error(`Main page returned ${mainResponse.status}`);
    }
    console.log('✅ Storybook main page is accessible');
    
    // Check index.json
    console.log('Checking Storybook index.json...');
    const indexResponse = await fetch(`${baseURL}/index.json`, { 
      signal: AbortSignal.timeout(10000) 
    });
    
    if (!indexResponse.ok) {
      throw new Error(`Index.json returned ${indexResponse.status}`);
    }
    
    const contentType = indexResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Index.json does not have correct content-type');
    }
    
    const data = await indexResponse.json();
    if (!data.entries) {
      throw new Error('Index.json does not contain entries');
    }
    
    console.log('✅ Storybook index.json is ready');
    console.log(`🎉 Storybook server is fully ready with ${Object.keys(data.entries).length} stories`);
  } catch (error) {
    console.error('❌ Storybook server health check failed:', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export default globalSetup;
