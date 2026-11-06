import { describe, expect, test } from "bun:test";
import { callerAddress } from "../src/server/caller.ts";

const from = (ip?: string) =>
  new Request("https://stargrep.test/", ip === undefined ? {} : { headers: { "cf-connecting-ip": ip } });

describe("callerAddress", () => {
  test("keeps an IPv4 address and shares one caller when Cloudflare named none", () => {
    expect(callerAddress(from("192.0.2.1"))).toBe("192.0.2.1");
    expect(callerAddress(from())).toBe("unknown");
  });

  test("counts an IPv6 caller by its /64, however the address is written", () => {
    const expected = "2001:db8:85a3:0::/64";
    expect(callerAddress(from("2001:db8:85a3::8a2e:370:7334"))).toBe(expected);
    expect(callerAddress(from("2001:0DB8:85A3:0000:1111:2222:3333:4444"))).toBe(expected);
    expect(callerAddress(from("2001:db8:85a3:0:ffff::1"))).toBe(expected);
    expect(callerAddress(from("::1"))).toBe("0:0:0:0::/64");
  });

  test("counts an IPv4-mapped IPv6 caller as its IPv4 address, in every way it can be written", () => {
    for (const mapped of ["::ffff:192.0.2.1", "::FFFF:192.0.2.1", "0:0:0:0:0:ffff:192.0.2.1", "::ffff:c000:201"]) {
      expect(callerAddress(from(mapped))).toBe("192.0.2.1");
    }
    expect(callerAddress(from("64:ff9b::192.0.2.1"))).toBe("64:ff9b:0:0::/64");
  });
});
