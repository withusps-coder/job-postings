export const data = { permalink: "/manifest.webmanifest" };

export function render() {
  return JSON.stringify({
    name: "금문섭 헤드헌터 채용 포지션",
    short_name: "금문섭 헤드헌터",
    start_url: "/",
    display: "standalone",
    background_color: "#FBFCFE",
    theme_color: "#FBFCFE",
    icons: [
      { src: "/assets/brand/favicon.png", sizes: "150x150", type: "image/png" },
    ],
  });
}
