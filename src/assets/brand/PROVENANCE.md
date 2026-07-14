# Starting brand asset provenance

These files are the two approved official assets used for the Starting affiliation.
They are stored locally so the public site does not hotlink a third-party brand
asset. Retrieval was a direct HTTPS download from the listed source, with the
response checked as SVG/PNG before the checksum was recorded.

| Local file                | Official source URL                           | Retrieved (UTC)      | SHA-256                                                            |
| ------------------------- | --------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| `starting-text-black.svg` | `https://starting.kr/starting-text-black.svg` | 2026-07-10T16:36:25Z | `ce2d6147e60308c3913a28e60074ad71124ea69e69784187962d79a27aafe66d` |
| `favicon.png`             | `https://starting.kr/uploads/favicon.png`     | 2026-07-10T16:36:25Z | `27e761756824b98db8512b415fc8948c60f968e0c624d1c81f14be5fab4931da` |

Refresh verification:

```sh
curl --fail --location https://starting.kr/starting-text-black.svg | shasum -a 256
curl --fail --location https://starting.kr/uploads/favicon.png | shasum -a 256
```

Only the wordmark and favicon are approved here. Product screenshots, corporate
copy, and other assets are deliberately not carried into this personal recruiter
site.
