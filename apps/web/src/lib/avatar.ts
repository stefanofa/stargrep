// A login's GitHub avatar at twice the size it shows, so it stays sharp on dense screens.
export const avatarOf = (login: string, shown: number) => `https://github.com/${login}.png?size=${shown * 2}`;
