const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const formatStars = (stars: number) => compact.format(stars).toLowerCase();
