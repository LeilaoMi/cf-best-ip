import test from 'node:test';
import assert from 'node:assert/strict';
import { ipToInt, ipv6ToBigInt, isCfNativeIp, isCfNativeIpV6 } from '../src/cidr.js';

test('ipToInt validates IPv4 input', () => {
  assert.equal(ipToInt('1.2.3.4'), 16909060);
  assert.equal(ipToInt('1.2.3'), null);
  assert.equal(ipToInt('1.2.3.256'), null);
  assert.equal(ipToInt('1.2.3.x'), null);
});

test('isCfNativeIp matches Cloudflare IPv4 CIDR boundaries', () => {
  assert.equal(isCfNativeIp('173.245.48.0'), true);
  assert.equal(isCfNativeIp('173.245.63.255'), true);
  assert.equal(isCfNativeIp('173.245.47.255'), false);
  assert.equal(isCfNativeIp('173.245.64.0'), false);
  assert.equal(isCfNativeIp('8.8.8.8'), false);
});

test('isCfNativeIp matches Cloudflare IPv6 ranges', () => {
  assert.equal(isCfNativeIp('2606:4700::1'), true);
  assert.equal(isCfNativeIpV6('2a06:98c0::1'), true);
  assert.equal(isCfNativeIp('2001:4860:4860::8888'), false);
  assert.equal(isCfNativeIp('bad-ip'), false);
  assert.equal(ipv6ToBigInt('::1'), 1n);
});
