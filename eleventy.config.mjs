/** @param {import("@11ty/eleventy").UserConfig} eleventyConfig */
export default function configureEleventy(eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/_routes.json": "_routes.json" });
  eleventyConfig.addPassthroughCopy({ "src/assets": "assets" });
  eleventyConfig.ignores.add("src/index.11ty.js");
  eleventyConfig.ignores.add("src/job.11ty.js");
  eleventyConfig.ignores.add("src/sitemap.11ty.js");
  eleventyConfig.ignores.add("src/author.11ty.js");

  return {
    dir: {
      input: "src",
      includes: "_includes",
      output: "_site",
    },
    templateFormats: ["11ty.js"],
  };
}
