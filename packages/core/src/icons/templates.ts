const templateFiles = {
  "create-next-app favicon.ico, older template": "718d6fea4835ec2d246af9800eddb7ffb276240c",
  "create-next-app favicon.ico": "af98450595e8b8efd9e505cddc5ed705b665a4d8",
  "create-vite favicon.svg": "6893eb13237060adc0c968a690149a49faa2d7d3",
  "create-vite vite.svg": "e7b8dfb1b2a60bd50538bec9f876511b9cac21e3",
  "create-react-app favicon.ico": "a11777cc471a4344702741ab1c8a588998b1311a",
  "create-react-app logo192.png": "fc44b0a3796c0e0a64c3d858ca038bd4570465d9",
  "astro minimal favicon.svg": "f157bd1c5e287c70a508a98a13f538491aa4dafc",
  "astro minimal favicon.ico": "7f48a94d16071d6c8d06478c7458ab12e675019c",
  "nuxt starter favicon.ico": "18993ad91cfd43e03b074dd0b5cc3f37ab38e49c",
};

export const templateBlobs: ReadonlySet<string> = new Set(Object.values(templateFiles));
