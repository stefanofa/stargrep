// The reveal plays once per visit on the demo page the server painted with its first answer (Landing round 1, A5, as the
// operator revised it: results are readable at the first paint and the motion is decoration on top). This script runs
// in the document head before the first paint. When this visit has not revealed yet and motion is allowed, it marks
// <html data-reveal="pending">, which hides only the text inside the search input, so the engine can type the query
// in. The first key, click, focus or input anywhere on the page cancels the reveal, so text typed before the engine
// hydrates shows at once, and the mark goes after 1.2 seconds whatever happens. It imports nothing, so the landing
// stays light.
export const revealedKey = "stargrep:revealed";

export const revealScript = `try{var d=document.documentElement,o={capture:true},e=["keydown","pointerdown","focusin","input"],c=function(){if(d.dataset.reveal==="pending")delete d.dataset.reveal;e.forEach(function(n){removeEventListener(n,c,o)})};if(!sessionStorage.getItem("${revealedKey}")&&!matchMedia("(prefers-reduced-motion: reduce)").matches){d.dataset.reveal="pending";e.forEach(function(n){addEventListener(n,c,o)});setTimeout(c,1200)}}catch(x){}`;
