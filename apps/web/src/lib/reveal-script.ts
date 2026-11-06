// The reveal plays once per visit on a page the server painted with its first answer (Landing round 1, A5, as the
// operator revised it: results are readable at the first paint and the motion is decoration on top). This script runs
// in the document head before the first paint. When this visit has not revealed yet and motion is allowed, it marks
// <html data-reveal="pending">, which hides only the text inside the search input, so the engine can type the query
// in. If the engine has not started within 1.2 seconds, the mark goes and the query simply shows. It imports nothing,
// so the landing stays light.
export const revealedKey = "stargrep:revealed";

export const revealScript = `try{var d=document.documentElement;if(!sessionStorage.getItem("${revealedKey}")&&!matchMedia("(prefers-reduced-motion: reduce)").matches){d.dataset.reveal="pending";setTimeout(function(){if(d.dataset.reveal==="pending")delete d.dataset.reveal},1200)}}catch(e){}`;
