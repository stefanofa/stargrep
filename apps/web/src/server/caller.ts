// One IPv6 subscriber usually holds a whole /64, so per-caller limits count the /64. Cloudflare sets cf-connecting-ip on
// every request it proxies, so a request without it is local and shares one caller.
export const callerAddress = (request: Request): string => {
  const ip = request.headers.get("cf-connecting-ip");
  if (ip === null) return "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
};
