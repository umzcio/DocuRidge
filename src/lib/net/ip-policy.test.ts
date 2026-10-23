import { describe, it, expect } from 'vitest';
import { classifyIp } from './ip-policy';

describe('classifyIp — public addresses', () => {
  it.each([
    '93.184.215.14',
    '8.8.8.8',
    '11.0.0.1',
    '110.0.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    // NAT64 and 6to4 forms of a public IPv4 stay public.
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('treats %s as public', (address) => {
    expect(classifyIp(address)).toBeNull();
  });
});

describe('classifyIp — IPv4 deny ranges', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'loopback'],
    ['0.1.2.3', 'loopback'],
    ['10.0.0.1', 'private_address'],
    ['172.16.0.1', 'private_address'],
    ['172.31.255.255', 'private_address'],
    ['192.168.1.1', 'private_address'],
    ['100.64.0.1', 'private_address'],
    ['100.127.255.254', 'private_address'],
    ['169.254.169.254', 'link_local'],
    ['169.254.0.1', 'link_local'],
    ['192.0.0.170', 'reserved_address'],
    ['192.0.2.1', 'reserved_address'],
    ['198.18.0.1', 'reserved_address'],
    ['198.51.100.7', 'reserved_address'],
    ['203.0.113.9', 'reserved_address'],
    ['224.0.0.1', 'reserved_address'],
    ['239.255.255.250', 'reserved_address'],
    ['240.0.0.1', 'reserved_address'],
    ['255.255.255.255', 'reserved_address'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });
});

describe('classifyIp — IPv6 deny ranges', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['fc00::1', 'private_address'],
    ['fd12:3456:789a::1', 'private_address'],
    ['fec0::1', 'private_address'],
    ['fe80::1', 'link_local'],
    ['febf::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['ff02::1', 'reserved_address'],
    ['100::1', 'reserved_address'],
    ['2001:db8::1', 'reserved_address'],
    ['2001::1', 'reserved_address'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });
});

describe('classifyIp — IPv4 embedded in IPv6 is judged by the IPv4 address', () => {
  it.each([
    // IPv4-mapped, dotted and hex spellings
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:0:0', 'loopback'],
    ['::ffff:172.18.0.2', 'private_address'],
    ['::ffff:ac12:2', 'private_address'],
    ['::ffff:10.1.2.3', 'private_address'],
    ['::ffff:192.168.0.1', 'private_address'],
    ['::ffff:169.254.169.254', 'link_local'],
    ['::ffff:a9fe:a9fe', 'link_local'],
    // SIIT (::ffff:0:a.b.c.d)
    ['::ffff:0:127.0.0.1', 'loopback'],
    // IPv4-compatible (deprecated)
    ['::127.0.0.1', 'loopback'],
    ['::10.0.0.1', 'private_address'],
    // NAT64 well-known and local-use prefixes
    ['64:ff9b::127.0.0.1', 'loopback'],
    ['64:ff9b::a00:1', 'private_address'],
    ['64:ff9b:1::a9fe:a9fe', 'link_local'],
    // 6to4
    ['2002:7f00:1::1', 'loopback'],
    ['2002:a00:1::', 'private_address'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyIp(address)).toBe(expected);
  });

  it('refuses an IPv4-compatible form even when the embedded address is public', () => {
    expect(classifyIp('::8.8.8.8')).toBe('reserved_address');
  });

  it('accepts an IPv4-mapped form of a public address', () => {
    expect(classifyIp('::ffff:8.8.8.8')).toBeNull();
  });
});

describe('classifyIp — malformed input fails closed', () => {
  it.each(['', 'example.com', '1.2.3', '1.2.3.256', ':::1', '1::2::3', 'gggg::1'])(
    'refuses %j',
    (address) => {
      expect(classifyIp(address)).toBe('reserved_address');
    },
  );
});
