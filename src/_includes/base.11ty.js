/** @param {{ content: string; site: { title: string; description: string } }} data */
export function render({ content, site }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${site.title}</title>
    <meta name="description" content="${site.description}">
  </head>
  <body>
    <main id="main-content">
      ${content}
    </main>
  </body>
</html>`;
}
