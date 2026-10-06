# Print Shop

Print-on-demand merch run by agents in Agent Colony. Agents come up with ideas, draw each design
as SVG, and write the listing. `printshop.mjs` renders the print file and mockups and keeps a review
queue. Approved designs go to [Printify](https://printify.com), which prints and ships every order:
no stock, no packing.

```
ideas ──▶ design agent (SVG) ──render──▶ print file + mockups ──▶ review ──▶ you approve ──▶ Printify draft ──▶ store
```

## Setup

The Windows installer (Clip Factory's `setup-windows.ps1`) puts it in `%USERPROFILE%\code\print-shop`,
as its own git repo, and adds it to the colony. By hand:

```bash
npm install                 # the SVG renderer (resvg)
node printshop.mjs doctor
```

Your brands, designs and reports live in `~/PrintShop` (`PRINT_SHOP_HOME`), never in git. Put
extra fonts (.ttf/.otf) in `~/PrintShop/fonts`.

## The agents

On the *print-shop* plot, the preset buttons start them:

| Button | Command | What it does |
| --- | --- | --- |
| New brand | `/brand …` | Makes a brand: niche, audience, style, products |
| New ideas | `/ideas` | Adds design ideas to the brand's list |
| Design an idea | `/design <idea>` | Draws it, renders, checks the mockups, writes the listing |
| Redo rejected | `/redo` | Fixes what you rejected, from your reasons |
| Put approved on Printify | `/list` | Approved designs become Printify drafts |
| Manager shift | `/manage` | Reviews, redoes, keeps ideas flowing, lists, reports |
| Check-in report | `/checkin` | Daily or weekly summary |

Up to 4 design agents work at once (`PRINT_SHOP_MAX_AGENTS`), each in its own worktree. The
manager shift (every 3 hours) and weekly check-in are on the plot's **Autopilot schedule**, off
until ticked. Review on **Review designs**, from your phone too.

## Autopilot

Per brand, in `~/PrintShop/brands/<brand>.json`:

```json
"autopilot": { "approve": false, "publish": false, "maxDesignsPerDay": 6 }
```

- `approve`: the manager may approve designs that pass its checklist (no one else's trademarks,
  readable on every colour, spelled right, listing written).
- `publish`: it may also put approved designs live in the store, not just make Printify drafts.

Both start off. Only you change them.

## Printify

1. Make a free account at https://printify.com and add a store (Shopify, Etsy, or Printify's own
   Pop-Up Store).
2. `node printshop.mjs connect` and paste an API token from https://printify.com/app/account/api.
3. Ask an agent: `/brand pick Printify products for <brand>`. It finds the shirt, mug and sticker
   in the catalog and sets colours, sizes and prices.

## Selling other people's designs

Don't. No brands, characters, celebrities, teams, lyrics or quotes, and no lookalikes. Print-on-demand
stores take down infringing listings and close repeat offenders. `render` flags some famous
names, and the manager checks every design, but you decide anything borderline.
