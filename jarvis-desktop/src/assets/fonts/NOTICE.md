# Bundled fonts

The interface ships these font files locally. Nothing is loaded from a font CDN at run time. Each family is licensed under the SIL Open Font License 1.1. The full license texts, with their copyright lines, are in `public/licenses/`. Vite copies that folder into `dist/licenses/`, so the texts ship inside the packaged app. The files are Latin subsets in WOFF2 format, unmodified apart from subsetting.

| Family | Files | Use | Copyright | License |
| --- | --- | --- | --- | --- |
| Chakra Petch | `ChakraPetch-latin-500/600/700.woff2` | Display, headings, navigation, labels | 2018 The Chakra Petch Project Authors | `public/licenses/LICENSE-ChakraPetch-OFL.txt` |
| Saira (variable, wght 100–900, wdth 50–125) | `Saira-latin-variable.woff2` | Interface and body text | 2020 The Saira Project Authors | `public/licenses/LICENSE-Saira-OFL.txt` |
| IBM Plex Mono | `IBMPlexMono-latin-400/500.woff2` | Metadata, times, model ids, counters | 2017 IBM Corp. | `public/licenses/LICENSE-IBMPlexMono-OFL.txt` |
| Bricolage Grotesque (variable, wght 200–800, wdth 75–100, opsz 12–96) | `BricolageGrotesque-latin-var.woff2` | Companion bubble titles and the first-run line (candidate direction, pending owner review) | 2022 The Bricolage Grotesque Project Authors | `public/licenses/LICENSE-BricolageGrotesque-OFL.txt` |
| Figtree | `Figtree-latin-400/600.woff2` | Companion bubble body and controls (candidate direction, pending owner review) | 2022 The Figtree Project Authors | `public/licenses/LICENSE-Figtree-OFL.txt` |

The OFL allows bundling with software. The fonts may not be sold by themselves. None of the copyright statements bundled here declares a Reserved Font Name, so the subsetted files keep their original family names. The license files ship with the fonts, as described above.
