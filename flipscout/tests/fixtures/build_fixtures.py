"""Generate MADE-UP sample pages (Craigslist + Marketplace) for tests and the demo report.

Run:  python tests/fixtures/build_fixtures.py
Every listing, VIN-like string, and photo URL here is invented.
"""
from __future__ import annotations

import json
from html import escape
from pathlib import Path

OUT = Path(__file__).parent / "demo"

CL = [
    dict(pid="7801000001", site="harrisonburg", slug="elkton-2011-honda-accord-ex", title="2011 Honda Accord EX", price=5200,
         loc="Elkton", lat=38.41, lon=-78.62, miles="142,300", title_status="clean", vin="",
         posted="2026-11-16T09:12:00-0500",
         body="Selling my 2011 Accord EX. Runs and drives great, timing chain engine, new tires last spring. "
              "Clean title in hand and in my name. Small dent on rear bumper, AC blows cold. Cash, meet in Elkton."),
    dict(pid="7801000002", site="harrisonburg", slug="luray-2008-toyota-camry-le", title="2008 Toyota Camry LE", price=4100,
         loc="Luray", lat=38.665, lon=-78.459, miles="168,000", title_status="clean", vin="",
         posted="2026-11-03T14:40:00-0500",
         body="2008 Camry LE 4 cyl, 168k highway miles. Price dropped, need it gone. Oil changed every 5k, records available. "
              "Check engine light for evap code. Clean title."),
    dict(pid="7801000003", site="harrisonburg", slug="harrisonburg-2012-ford-150-xlt", title="2012 Ford F-150 XLT 4x4", price=9200,
         loc="Harrisonburg", lat=38.45, lon=-78.87, miles="151,000", title_status="rebuilt", vin="",
         posted="2026-11-16T07:02:00-0500",
         body="Rebuilt title from minor front damage, fully repaired. 5.0 V8, runs strong."),
    dict(pid="7801000004", site="harrisonburg", slug="staunton-2009-honda-civic", title="2009 Honda Civic LX", price=1900,
         loc="Staunton", lat=38.15, lon=-79.07, miles="98,000", title_status="clean", vin="",
         posted="2026-11-16T11:30:00-0500",
         body="I am deployed overseas and must sell my late husband's Civic quickly. Car is with a transport company. "
              "Send a refundable deposit to hold it and I will have it shipped to you."),
    dict(pid="7801000005", site="harrisonburg", slug="harrisonburg-2014-chevy-cruze-lt", title="2014 Chevrolet Cruze LT", price=6500,
         loc="Harrisonburg", lat=38.44, lon=-78.86, miles="88,000", title_status="clean", vin="",
         posted="2026-11-15T10:00:00-0500",
         body="Financing available for all credit types! Stock # 4471. Doc fee not included. Visit our lot today."),
    dict(pid="7801000006", site="harrisonburg", slug="bridgewater-2007-subaru-outback", title="2007 Subaru Outback 2.5i", price=3800,
         loc="Bridgewater", lat=38.38, lon=-78.98, miles="201,000", title_status="clean", vin="",
         posted="2026-11-14T16:20:00-0500",
         body="Head gasket went, doesn't run. Needs engine. Body is solid, good tires. Bring a trailer."),
    dict(pid="7801000007", site="harrisonburg", slug="mcgaheysville-2013-toyota-corolla-s", title="2013 Toyota Corolla S", price=6900,
         loc="McGaheysville", lat=38.374, lon=-78.739, miles="119,500", title_status="clean", vin="2T1BU4EE1DC000013",
         posted="2026-11-15T18:45:00-0500",
         body="2013 Corolla S, automatic, 119k miles. One owner, never smoked in. Clean title in my name. "
              "Recent brakes and battery. A couple of door dings. VIN 2T1BU4EE1DC000013."),
]

FB = [
    dict(id="1100000000000001", title="2010 Toyota RAV4 Base Sport Utility 4D", price=4500, prev=None, loc="Stanley, VA",
         listed="Listed 6 hours ago in Stanley, VA", miles="155,000", title_line="Clean title",
         desc="2010 RAV4 4cyl AWD. Runs and drives great, 155k. New battery and front brakes. Some surface rust on the hitch. "
              "Moving and need it sold, priced to sell.", seller="Pat Example", joined="2013"),
    dict(id="1100000000000002", title="2006 Ford Ranger XLT Pickup 2D 6 ft", price=4800, prev=5300, loc="Front Royal, VA",
         listed="Listed 2 weeks ago in Front Royal, VA", miles="190,000", title_line="Clean title",
         desc="2006 Ranger 4.0 V6 manual. Work truck, some rust on bed. Runs fine. Price reduced.", seller="Chris Sample", joined="2011"),
    dict(id="1100000000000003", title="2015 Nissan Altima 2.5 S Sedan 4D", price=7900, prev=None, loc="Charlottesville, VA",
         listed="Listed 3 days ago in Charlottesville, VA", miles="104,000", title_line="Clean title",
         desc="2015 Altima, CVT recently serviced, 104k. Clean inside and out. No lowballers.", seller="Jordan Demo", joined="2016"),
    dict(id="1100000000000004", title="2012 Jeep Liberty Sport SUV 4D", price=3200, prev=None, loc="Winchester, VA",
         listed="Listed 1 day ago in Winchester, VA", miles="120,000", title_line="Clean title",
         desc="Great Jeep. I don't check Facebook, text only or email me at jeepsale.sample@gmail.com for details.",
         seller="Alex Placeholder", joined="2025"),
]


def cl_search_html() -> str:
    items = "\n".join(
        f'<li class="cl-static-search-result" title="{escape(c["title"])}"><a href="https://{c["site"]}.craigslist.org/cto/d/{c["slug"]}/{c["pid"]}.html">'
        f'<div class="title">{escape(c["title"])}</div><div class="details"><div class="price">${c["price"]:,}</div>'
        f'<div class="location">{escape(c["loc"])}</div></div></a></li>' for c in CL)
    return f"<html><head><title>cars & trucks - by owner - SAMPLE</title></head><body><ol class=\"cl-static-search-results\">{items}</ol></body></html>"


def cl_detail_html(c: dict) -> str:
    vin_attr = f'<div class="attr auto_vin"><span class="labl">VIN:</span><span class="valu">{c["vin"]}</span></div>' if c["vin"] else ""
    imgs = [f"https://images.craigslist.org/sample_{c['pid']}_{i}_600x450.jpg" for i in range(1, 6)]
    year, rest = c["title"].split(" ", 1)
    return f"""<html><head><title>{escape(c['title'])} - ${c['price']:,} ({escape(c['loc'])}) SAMPLE</title></head><body>
<section class="body"><h1 class="postingtitle"><span class="postingtitletext"><span id="titletextonly">{escape(c['title'])}</span>
<span class="price">${c['price']:,}</span><span> ({escape(c['loc'])})</span></span></h1>
<section class="userbody"><figure class="iw multiimage"><div class="gallery"><img src="{imgs[0]}"></div></figure>
<div class="mapAndAttrs"><div class="mapbox"><div id="map" data-latitude="{c['lat']}" data-longitude="{c['lon']}" data-accuracy="10"></div></div>
<div class="attrgroup"><div class="attr important"><span class="valu year">{year}</span> <span class="valu makemodel">{escape(rest.lower())}</span></div></div>
<div class="attrgroup">{vin_attr}
<div class="attr condition"><span class="labl">condition:</span><span class="valu">good</span></div>
<div class="attr auto_miles"><span class="labl">odometer:</span><span class="valu">{c['miles']}</span></div>
<div class="attr auto_title_status"><span class="labl">title status:</span><span class="valu">{c['title_status']}</span></div>
<div class="attr auto_transmission"><span class="labl">transmission:</span><span class="valu">automatic</span></div>
</div></div>
<section id="postingbody"><div class="print-information print-qrcode-container"><p class="print-qrcode-label">QR Code Link to This Post</p></div>
{escape(c['body'])}</section>
<div class="postinginfos"><p class="postinginfo">post id: {c['pid']}</p>
<p class="postinginfo reveal">posted: <time class="date timeago" datetime="{c['posted']}">recently</time></p></div>
</section></section>
<script>var imgList = {json.dumps([{"url": u} for u in imgs])};</script>
</body></html>"""


def fb_search_html() -> str:
    cards = "\n".join(
        f'<a href="/marketplace/item/{f["id"]}/?ref=search&amp;sample=1"><div><span>${f["price"]:,}</span></div>'
        + (f'<div><span>${f["prev"]:,}</span></div>' if f["prev"] else "")
        + f'<div><span>{escape(f["title"])}</span></div><div><span>{escape(f["loc"])}</span></div>'
          f'<div><span>{int(f["miles"].replace(",", "")) // 1000}K miles</span></div></a>' for f in FB)
    return f"<html><body><div>Marketplace</div><div>Vehicles</div><div>{cards}</div></body></html>"


def fb_detail_html(f: dict) -> str:
    imgs = "".join(f'<img src="https://scontent.sample.invalid/{f["id"]}_{i}.jpg" alt="Product photo of {escape(f["title"])}">' for i in range(1, 6))
    prev = f'<div>${f["prev"]:,}</div>' if f["prev"] else ""
    lines = [f["title"]]
    return f"""<html><body><div>Marketplace</div>{imgs}
<div><h1>{escape(f['title'])}</h1></div><div><span>${f['price']:,}</span>{prev}</div>
<div>{escape(f['listed'])}</div><div>Message</div><div>Save</div><div>Share</div>
<div>About this vehicle</div><div>Driven {f['miles']} miles</div><div>Automatic transmission</div>
<div>Exterior color: Silver · Interior color: Gray</div><div>{f['title_line']}</div>
<div>This vehicle has no significant damage or problems.</div>
<div>Seller's description</div><div>{escape(f['desc'])}</div><div>See more</div>
<div>Location is approximate</div><div>Seller information</div><div>{escape(f['seller'])}</div>
<div>Joined Facebook in {f['joined']}</div><div>Send seller a message</div><div>Is this still available?</div></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {}
    (OUT / "cl_search.html").write_text(cl_search_html())
    manifest["https://harrisonburg.craigslist.org/search/cto*"] = "cl_search.html"
    for c in CL:
        name = f"cl_{c['pid']}.html"
        (OUT / name).write_text(cl_detail_html(c))
        manifest[f"https://{c['site']}.craigslist.org/cto/d/{c['slug']}/{c['pid']}.html"] = name
    (OUT / "fb_search.html").write_text(fb_search_html())
    manifest["https://www.facebook.com/marketplace/category/vehicles*"] = "fb_search.html"
    for f in FB:
        name = f"fb_{f['id']}.html"
        (OUT / name).write_text(fb_detail_html(f))
        manifest[f"https://www.facebook.com/marketplace/item/{f['id']}/"] = name
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote {len(manifest)} fixture pages to {OUT}")


if __name__ == "__main__":
    main()
