export const githubLogin = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u;

export const isGitHubLogin = (login: string) => githubLogin.test(login);

export const loginKey = (login: string) => login.toLowerCase();
