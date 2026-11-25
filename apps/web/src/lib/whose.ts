import { loginKey } from "@stargrep/github/login";

const count = new Intl.NumberFormat("en");

export const formatCount = (value: number) => count.format(value);

export const starCount = (value: number) => `${formatCount(value)} ${value === 1 ? "star" : "stars"}`;

export const peopleCount = (value: number) => (value === 1 ? "1 person" : `${formatCount(value)} people`);

export const sameLogin = (a: string, b: string) => loginKey(a) === loginKey(b);

export type Whose = { readonly own: true } | { readonly own: false; readonly login: string };

export const theirs = (whose: Whose) => (whose.own ? "your stars" : `@${whose.login}'s stars`);
