import { BlockList, isIP } from 'node:net';

/** Removes the IPv4-mapped IPv6 prefix: '::ffff:172.18.0.3' becomes '172.18.0.3'. */
export function normalizeIp(ip: string): string {
  const prefix = '::ffff:';
  if (ip.toLowerCase().startsWith(prefix) && isIP(ip.slice(prefix.length)) === 4) {
    return ip.slice(prefix.length);
  }
  return ip;
}

/** True if the IPv4 address is inside the IPv4 CIDR. IPv6 addresses and bad input give false. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  if (base === undefined || bits === undefined || isIP(base) !== 4 || isIP(ip) !== 4) {
    return false;
  }
  const list = new BlockList();
  list.addSubnet(base, Number(bits), 'ipv4');
  return list.check(ip, 'ipv4');
}
