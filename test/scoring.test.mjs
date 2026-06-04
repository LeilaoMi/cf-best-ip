import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStabilityScores,
  carrierKey,
  countByCarrier,
  qualityGuard,
  sourceHealth,
} from '../src/scoring.js';

test('carrierKey normalizes CMCC and countByCarrier falls back to CF', () => {
  assert.equal(carrierKey({ carrier: 'CMCC' }), 'CM');
  assert.deepEqual(countByCarrier([{ carrier: 'CT' }, { carrier: 'CMCC' }, { carrier: 'BOGUS' }, {}]), {
    CT: 1,
    CU: 0,
    CM: 1,
    CF: 2,
  });
});

test('applyStabilityScores sorts by computed score', () => {
  const ips = [
    { ip: '1.1.1.1', carrier: 'CT', sources: ['a'] },
    { ip: '2.2.2.2', carrier: 'CT', tested: true, delay: 50, sources: ['a'] },
  ];
  const out = applyStabilityScores(ips, { ips: [{ ip: '1.1.1.1', carrier: 'CT' }] });
  assert.equal(out[0].ip, '2.2.2.2');
  assert.ok(out[0]._score > out[1]._score);
});

test('qualityGuard detects pool and tested shrinkage', () => {
  const prev = { ips: Array.from({ length: 60 }, (_, i) => ({ ip: `1.1.1.${i}`, carrier: 'CT', tested: i < 20 })) };
  assert.equal(qualityGuard(Array.from({ length: 35 }, (_, i) => ({ ip: `2.2.2.${i}`, carrier: 'CT' })), prev)?.error, 'pool-shrank');
  const alive = Array.from({ length: 60 }, (_, i) => ({ ip: `3.3.3.${i}`, carrier: i < 15 ? 'CT' : 'CF', tested: i < 5 }));
  assert.equal(qualityGuard(alive, prev)?.error, 'tested-pool-shrank');
});

test('qualityGuard detects critical source degraded carrier pool', () => {
  const prev = { ips: Array.from({ length: 60 }, (_, i) => ({ ip: `1.1.1.${i}`, carrier: i < 20 ? 'CT' : 'CF', tested: i < 20 })) };
  const alive = Array.from({ length: 60 }, (_, i) => ({ ip: `2.2.2.${i}`, carrier: i < 15 ? 'CT' : 'CF', tested: i < 20 }));
  const issue = qualityGuard(alive, prev, [{ name: 'hostmonit', critical: true, error: 'timeout' }], c => c);
  assert.equal(issue?.error, 'critical-source-degraded');
});

test('sourceHealth reports critical and independent signal stats', () => {
  const health = sourceHealth([
    { name: 'a', signal: 'same', count: 2 },
    { name: 'b', signal: 'same', count: 1 },
    { name: 'hostmonit', critical: true, error: 'timeout' },
  ]);
  assert.deepEqual(health, {
    total: 3,
    ok: 2,
    failed: 1,
    empty: 0,
    critical: 1,
    criticalFailed: 1,
    criticalSourcesOk: false,
    independentSignals: 2,
  });
});
