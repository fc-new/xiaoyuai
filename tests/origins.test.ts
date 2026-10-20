import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOrigins, sameSiteDevelopmentOrigin } from '../server/origins.js';

test('development allows known local aliases and ports, while unrelated origins remain blocked', () => {
  const origins = allowedOrigins('http://localhost:5173', false, 3001);
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'http://127.0.0.1:3001']) assert.equal(origins.has(origin), true);
  for (const origin of ['http://localhost:9999', 'https://attacker.example', 'http://localhost.attacker.example:5173', 'null']) assert.equal(origins.has(origin), false);
});
test('production origin stays exact even when development ports are supplied', () => {
  const origins = allowedOrigins('https://xiaoyuai.example', true, 3001);
  assert.deepEqual([...origins], ['https://xiaoyuai.example']);
  assert.equal(allowedOrigins('https://xiaoyuai.example', false, 3001).has('http://127.0.0.1:3001'), false);
});
test('development proxy translates only same-host requests and preserves cross-site rejection', () => {
  assert.equal(sameSiteDevelopmentOrigin('https://development.example', 'development.example', 'same-origin'), true);
  assert.equal(sameSiteDevelopmentOrigin('http://127.0.0.1:5173', '127.0.0.1:5173', 'same-origin'), true);
  for (const origin of ['https://attacker.example', 'null', 'https://development.example/path', undefined]) assert.equal(sameSiteDevelopmentOrigin(origin, 'development.example'), false);
  assert.equal(sameSiteDevelopmentOrigin('https://development.example', 'development.example', 'cross-site'), false);
});
