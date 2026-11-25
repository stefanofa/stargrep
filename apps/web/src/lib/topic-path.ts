// GitHub keeps topics in lowercase letters, digits, and hyphens, and an address may carry another spelling that leads to
// one, such as next.js.
export const topicPattern = /^[a-z0-9][a-z0-9.+#-]{0,49}$/;

export const topicPath = (topic: string) => `/topics/${encodeURIComponent(topic)}`;
