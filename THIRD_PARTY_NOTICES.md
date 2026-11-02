# Third-party notices

The UI primitives in `src/components/ui` originate from [shadcn/ui](https://github.com/shadcn-ui/ui), copyright (c) 2023 shadcn, distributed under the MIT license. The MIT permission and warranty text in this repository's LICENSE applies to those files with that copyright attribution.

Other dependencies retain their own copyright and license notices in their installed packages. This project's license does not replace those licenses.

## Demo menu photos (mock/demo only)

The sample menu in mock mode (`VITE_API_MOCK=true`) shows the Unsplash photos in
`apps/web/demo/sample/menu/` (owner Q17/Q24, bead legend-4pki). Each file was
downloaded once at 800 px on its long edge and re-encoded to stay at or below
80 KB. They are demo fixtures only: they live outside `public/`, so a production
build never copies them, and the name→photo map is compiled out of the client
bundle. Production data never references these paths (a published menu item
uses the outlet's own upload, owner Q23).

All photos are used under the [Unsplash License](https://unsplash.com/license).
Photographer and source page per file:

| File                    | Photographer        | Source                                                                                               |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `affogato.jpg`          | Tsao Thomas         | https://unsplash.com/photos/a-bowl-of-ice-cream-and-a-cup-of-coffee-PbQdSMHCM9Y                      |
| `aglio-olio.jpg`        | Alfonso Escu        | https://unsplash.com/photos/yellow-pasta-with-red-chili-and-garlic-chtdJx_5pLQ                       |
| `air-mineral.jpg`       | Andrey Ilkevich     | https://unsplash.com/photos/a-glass-filled-with-water-on-top-of-a-table-vKYODCxAd0U                  |
| `apple-pie.jpg`         | Brian Kairuz        | https://unsplash.com/photos/a-delicious-slice-of-apple-pie-rH9wHoLHulg                               |
| `ayam-geprek.jpg`       | Gennady Zakharin    | https://unsplash.com/photos/delicious-golden-fried-chicken-is-piled-on-a-plate-xdcr4Z-KTcU           |
| `banana-bread.jpg`      | Cody Chan           | https://unsplash.com/photos/a-loaf-of-banana-bread-sitting-on-top-of-a-table-C0e3rplDKXg             |
| `brownies.jpg`          | Mila                | https://unsplash.com/photos/stack-of-three-chocolate-brownies-on-a-plate-qY2aflptZMg                 |
| `burger.jpg`            | Amna Akram          | https://unsplash.com/photos/burger-dish-on-brown-copping-board--EadTPh9crA                           |
| `cappuccino.jpg`        | Abbasali Fe         | https://unsplash.com/photos/cappuccino-latte-art-WDaN4s0w96Y                                         |
| `carbonara.jpg`         | Chris Weiher        | https://unsplash.com/photos/spaghetti-carbonara-served-in-a-metal-pan-with-cheese-8sdRfiPf4Qo        |
| `carrot-cake.jpg`       | Félix Girault       | https://unsplash.com/photos/a-piece-of-carrot-cake-on-a-plate-with-a-fork-e7vGaau9Nuk                |
| `cheesecake.jpg`        | Stacy (stacysuxx)   | https://unsplash.com/photos/a-slice-of-cheesecake-topped-with-raspberries-and-lemon-1oa-BWNPWkY      |
| `cold-brew.jpg`         | pariwat pannium     | https://unsplash.com/photos/a-glass-of-iced-coffee-sitting-on-top-of-a-counter-BT8PAsZ3v9k           |
| `combo.jpg`             | Raymond Petrik      | https://unsplash.com/photos/a-croissant-and-a-cup-of-coffee-on-a-table-KYOAIYyaPMM                   |
| `cookies.jpg`           | Luna Wang           | https://unsplash.com/photos/a-group-of-chocolate-chip-cookies-TOF9BBEgTnU                            |
| `croissant-cokelat.jpg` | Haley Parson        | https://unsplash.com/photos/three-pain-au-chocolat-pastries-sit-on-a-plate-GztlHvp0cdQ               |
| `croissant-mentega.jpg` | Diliara Garifullina | https://unsplash.com/photos/croissant-on-plate-nYgCnG8-nFo                                           |
| `donuts.jpg`            | Rodion Kutsaiev     | https://unsplash.com/photos/a-group-of-donuts-with-sprinkles-on-them-eL1wJWnU7Ts                     |
| `es-kopi-susu.jpg`      | Winston Chen        | https://unsplash.com/photos/iced-coffee-with-milk-and-ice-in-a-glass-nIZl9PuwMXk                     |
| `espresso.jpg`          | Aaron Doucett       | https://unsplash.com/photos/clear-glass-cup-with-brown-liquid-f-0fd9Jm3lk                            |
| `fries.jpg`             | Fernanda Martinez   | https://unsplash.com/photos/french-fries-on-white-ceramic-plate-h-S2RyyYthQ                          |
| `hot-chocolate.jpg`     | Sixteen Miles Out   | https://unsplash.com/photos/a-cup-of-hot-chocolate-with-marshmallows-in-it-s0Cnecr8W4U               |
| `iced-chocolate.jpg`    | afeef momin         | https://unsplash.com/photos/a-chocolate-drink-with-whipped-cream-on-top-X2cYWV0WrAg                  |
| `iced-tea.jpg`          | Luna Wang           | https://unsplash.com/photos/a-glass-of-iced-tea-on-a-wooden-table-gqXTbaFRTZM                        |
| `jus-alpukat.jpg`       | Alina Karpenko      | https://unsplash.com/photos/avocado-shake-on-glass-cup-03RUtFXdu1w                                   |
| `jus-jeruk.jpg`         | the cazpian         | https://unsplash.com/photos/a-glass-of-orange-juice-next-to-a-basket-of-oranges-npqeTCk0wqg          |
| `jus-mangga.jpg`        | sehoon ye           | https://unsplash.com/photos/a-glass-of-mango-juice-on-a-wooden-table-uBpCKXiKoF0                     |
| `lemon-tea.jpg`         | Hogir saeed         | https://unsplash.com/photos/a-glass-of-iced-tea-with-lemons-and-mint-ci7BdtGoCk0                     |
| `matcha-latte.jpg`      | ANNIE HATUANH       | https://unsplash.com/photos/a-hand-holds-a-tall-glass-of-iced-matcha-latte-hEXjfY7ACvU               |
| `mie-goreng.jpg`        | Martin Lostak       | https://unsplash.com/photos/stir-fry-noodles-eLEvLmOW0tU                                             |
| `mie-kuah.jpg`          | Kouji Tsuru         | https://unsplash.com/photos/a-bowl-of-noodle-soup-on-a-table-fhMhnBgmoPc                             |
| `muffin.jpg`            | Imad 786            | https://unsplash.com/photos/a-plate-of-chocolate-muffins-on-a-table-mZPKGqoAhkA                      |
| `nasi-goreng.jpg`       | Khanh Nguyen        | https://unsplash.com/photos/delicious-fried-rice-on-a-plate-VyMbYFMWU9w                              |
| `red-velvet-latte.jpg`  | victoria.           | https://unsplash.com/photos/a-glass-of-milk-with-a-straw-and-a-strawberry-on-top-6lM4YLkrPXY         |
| `rice-bowl.jpg`         | Claudio Schwarz     | https://unsplash.com/photos/a-bowl-filled-with-rice-and-meat-on-top-of-a-table-QO6xesth1js           |
| `roti-bakar.jpg`        | Skylar Michael      | https://unsplash.com/photos/bread-with-chocolate-and-peanut-butter-on-brown-wooden-table-u01801dz9aw |
| `roti-bakar-keju.jpg`   | You Le              | https://unsplash.com/photos/toasted-cheese-sandwich-on-a-black-plate-gIFSocc-nbo                     |
| `salad.jpg`             | Alexander Ross      | https://unsplash.com/photos/bowl-of-vegetable-salad-bD6ydkkcppA                                      |
| `sate-ayam.jpg`         | Ainur Iman          | https://unsplash.com/photos/chicken-satay-skewers-with-peanut-dipping-sauce-aaf3xxKPuqU              |
| `soda-leci.jpg`         | Esra Afşar          | https://unsplash.com/photos/a-refreshing-pink-drink-with-ice-5s54uloF2CQ                             |
| `soto-ayam.jpg`         | Hướng Nghiệp Á Âu   | https://unsplash.com/photos/bowl-of-chicken-soup-UQd7we1ALVk                                         |
| `sup-buntut.jpg`        | Melissa Walker Horn | https://unsplash.com/photos/soup-with-meat-and-vegetables-in-white-ceramic-bowl-P5IhVmH6FoM          |
| `taro-latte.jpg`        | Agata Ciosek        | https://unsplash.com/photos/a-glass-of-purple-smoothie-BksDCoFoVGI                                   |
| `teh-melati.jpg`        | Nathan Dumlao       | https://unsplash.com/photos/milk-tea-on-a-glass-umbR2y7PIMM                                          |
| `thai-tea.jpg`          | J Torres            | https://unsplash.com/photos/a-cup-of-iced-tea-with-a-slice-of-orange-RqUBL2z_BWU                     |
| `tiramisu.jpg`          | phoebe lynch        | https://unsplash.com/photos/a-delicious-tiramisu-dessert-with-cocoa-powder-kBRJ6dhhmYQ               |

`cappuccino.jpg`, `es-kopi-susu.jpg`, `mie-kuah.jpg`, `nasi-goreng.jpg` and
`teh-melati.jpg` replaced the first uncredited samples of legend-h16t, so every
photo added by this bead has a recorded photographer.
