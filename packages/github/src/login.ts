export const githubLogin = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}(?![\s\S])/u;

export const loginKey = (login: string) => login.toLowerCase();
