/** @param {HTMLImageElement} image */
const revealFallback = (image) => {
  image.hidden = true;
  image.nextElementSibling?.removeAttribute("aria-hidden");
  image.nextElementSibling?.classList.add("image-fallback--visible");
};

for (const image of document.querySelectorAll("[data-fallback-image]")) {
  if (!(image instanceof HTMLImageElement)) continue;
  image.addEventListener("error", () => revealFallback(image), { once: true });
  if (image.complete && image.naturalWidth === 0) revealFallback(image);
}
