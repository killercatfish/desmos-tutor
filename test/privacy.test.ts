import { describe, expect, it } from 'vitest';
import { isPrivateUrl } from '../server/privacy.ts';
import { loadConfig } from '../server/config.ts';

describe('isPrivateUrl', () => {
  it.each([
    ['http://localhost:8080/v1', true],
    ['http://127.0.0.1:11434/v1', true],
    ['http://192.168.1.50:11434/v1', true],
    ['http://10.0.0.5:8000/v1', true],
    ['http://172.20.1.1/v1', true],
    ['http://100.101.102.103:11434/v1', true], // Tailscale
    ['http://gpu-box.local:11434/v1', true],
    ['http://[::1]:8080/v1', true],
    ['https://generativelanguage.googleapis.com/v1beta/openai', false],
    ['https://openrouter.ai/api/v1', false],
    ['https://api.groq.com/openai/v1', false],
    ['http://172.32.0.1/v1', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isPrivateUrl(url)).toBe(expected);
  });
});

describe('PROVIDER_TRAINS_ON_DATA default', () => {
  it('is off for local endpoints and on for cloud ones', () => {
    expect(loadConfig({ LLM_BASE_URL: 'http://localhost:8080/v1' }).providerTrainsOnData).toBe(false);
    expect(loadConfig({ LLM_BASE_URL: 'https://api.groq.com/openai/v1' }).providerTrainsOnData).toBe(true);
  });

  it('can be set explicitly', () => {
    expect(loadConfig({ LLM_BASE_URL: 'http://localhost:8080/v1', PROVIDER_TRAINS_ON_DATA: 'true' }).providerTrainsOnData).toBe(true);
    expect(loadConfig({ LLM_BASE_URL: 'https://example.com/v1', PROVIDER_TRAINS_ON_DATA: 'false' }).providerTrainsOnData).toBe(false);
  });
});
