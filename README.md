# Synergy Usage Explorer (static web app)

A web app that turns a smart meter's half-hourly interval CSV (such as
`MA_IntervalDataHistory.csv`) into an interactive dashboard of use and cost.
It shows:

- cost on each tariff, with a side-by-side comparison, each day priced at the
  rates in force on that date (the tariff list holds Synergy's past rates
  too), less any daily credit such as a concession
- where each pair of tariffs breaks even: at what share of use at peak, or
  what kWh a day, they would cost the same
- your next bill: the billing period so far, plus an estimate of the rest
- use per day and per half-hour, and by time of day (overnight, morning,
  daytime, early evening, late evening)
- where the cost concentrates: how much of it falls in the dearest half-hours
- peak demand: each day's busiest half-hour, and when it tends to happen
- a heat map, an average day, and month and weekday breakdowns
- a savings calculator for moving peak use, and a battery what-if with payback
- the longer-term trend: a 30-day average across all the files opened, and
  comparisons with the same dates a year earlier
- unusual usage: days, spikes and stretches of raised always-on use that
  stand out from the weeks around them, what each cost, and checks on the
  data itself (gaps, zero runs, repeated readings, readings in the wrong
  rate period, repeated times, negative values)

Every figure follows the tariff and dates you pick. Long histories (several
90-day exports opened together) stay quick: figures are only worked out for
the dates on show, and charts only redraw when what they show changes.

Everything happens in the browser:

- There is no server code, no build step and nothing to install.
- The CSV is never uploaded.
- Once it has been opened online, it works with no internet connection.

Synergy Usage Explorer is an independent tool. It is not made by, or
affiliated with, Synergy.

## What's here

```
synergy_usage_tool/
  README.md            this file
  stamp_version.py     run after changing anything in public/ (see "Changing the app")
  public/              the app: upload the contents of this folder
    data/tariffs.csv   the default tariffs: edit this to change them (see "Changing the default tariffs")
    data/sample-interval-data.csv   the sample readings behind "Try it with sample data"
    index.html         the page
    sw.js              service worker: keeps a copy of the app for offline use
    manifest.webmanifest, icons/   lets it be installed like an app
    css/app.css        colours, type, and the parts around the dashboard
    css/dashboard.css  dashboard layout and chart styles
    js/readers.js      reads and checks the meter and tariff CSVs (shared with the tests, and mirrored in stamp_version.py)
    js/app.js          opening files, tariff editor, saving, offline/install
    js/runtime.js      runs the dashboard's data steps and redraws on each choice
    js/dashboard.js    the dashboard: figures and charts
    js/default-tariffs.js, js/sample-data.js   made from data/ by stamp_version.py; don't edit
    vendor/            d3 v7.9.0 charting library and its ISC licence
  tests/               tests of the readers, the stamp script and the dashboard's figures (see "Checks")
  package.json, eslint.config.mjs, ruff.toml   settings for the checks; the app doesn't use them
  .github/workflows/   GitHub Actions: the checks, and publishing to GitHub Pages
```

The app loads nothing from other sites: there are no CDNs, web fonts or analytics.

## Trying it

- **Straight from disk:** open `public/index.html` in a browser. This works
  offline, since the files are already on your computer. The service worker
  and the install button don't apply here.
- **As it will run when hosted:**
  ```
  python3 -m http.server 8000 -d public
  ```
  Then open http://localhost:8000/. Browsers treat localhost like https, so
  offline mode and installing can be tried here.

## Deploying to static hosting

Upload the contents of `public/` to any static host, for example GitHub Pages,
Netlify, Cloudflare Pages, Amazon S3 or CloudFront, an nginx or Apache folder,
or a shared web host.

- **It must be served over https.** Browsers only allow offline mode and
  installing on https (or localhost). Over plain http the dashboard still
  works, but only while online, and its footer says so.
- **It can live in a sub-folder** (such as `https://example.com/power/`). All
  paths are relative.
- No server settings are needed. Any host that serves `index.html` for the
  folder address is fine.

### GitHub Pages

`.github/workflows/pages.yml` publishes `public/` each time the `production`
branch changes, and at no other time, once the checks pass. Work on `main` or
any other branch is only checked. To publish, merge or push into
`production`.

It runs `stamp_version.py` itself before publishing, so a change goes live
even if the script wasn't run first: for example, new rates typed into
`public/data/tariffs.csv` with GitHub's web editor. A tariffs.csv the script
rejects stops the publish, and the site stays as it was.

Set it up once, on GitHub:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Environments → github-pages → Deployment branches and
   tags:** add `production`. At first GitHub only lets the default branch
   deploy, so without this the publish fails with "not allowed to deploy to
   github-pages due to environment protection rules".

The site is then at `https://<user>.github.io/<repository>/`. To publish
again without a change, re-run the last "Publish to GitHub Pages" run from
the Actions tab.

## Changing the default tariffs

The tariffs the app starts with are in `public/data/tariffs.csv`, one row
for each set of rates a tariff has had; the layout is under "Tariffs CSV"
below.

1. **Edit the file.** Change rates, add rows for new tariffs, or remove
   rows. When a tariff's prices change, keep its old row and add one with
   the new rates and the date they start in `from`, so older readings are
   still priced at the old rates. Mark the tariff most people are on
   `current` = `yes`. If you use Excel, save it as "CSV UTF-8".
2. **Run `python3 stamp_version.py`.** It checks the file the same way the
   app does, and lists any problems with their line numbers. It then copies
   the file into `js/default-tariffs.js`, which is how the app reads it, and
   gives the app a new version. To check a tariffs CSV on its own, run
   `python3 stamp_version.py --check-tariffs path/to/tariffs.csv`.
3. **Upload `public/` again.**

Visitors get the new defaults on their next online visit:

- **Never changed their tariff list, or saved it unchanged:** they see the
  new defaults straight away.
- **Edited their own list:** they keep it, and are told once that the
  defaults changed. **Restore defaults**, under Tariffs, shows the new ones.

The sample readings in `public/data/sample-interval-data.csv` work the same
way: replace the file, keeping the interval CSV layout, then run the script.

### Where the default rates come from

The default list holds Synergy's published prices, GST included, from
1 July 2019 (Home Plan) and 1 July 2022 (Midday Saver, when it opened), each
from the 1 July it took effect. WA household prices change on 1 July, so add
a row for each tariff then, from:

- Synergy's price changes page,
  https://www.synergy.net.au/Global/Synergy-Price-Changes-2025 (the page
  name changes with the year), and its brochure,
  https://www.synergy.net.au/-/media/Files/PDF-Library/Standard_Electricity_Prices_Charges_brochure.pdf.
  Older years are on the Wayback Machine (web.archive.org).
- For Home Plan (A1), the Energy Operators (Electricity Retail Corporation)
  (Charges) By-laws, https://www.legislation.wa.gov.au/legislation/statutes.nsf/law_s38407_currencies.html.

The two "with EAP concession" tariffs are the same plans with the Energy
Assistance Payment, which Synergy credits to concession card holders each
day: that year's amount divided by 365, in `credit_cents_per_day`
(https://www.synergy.net.au/Your-home/Manage-account/Rebates-and-concessions).
The list starts the EAP in July 2020 ($305.25 a year); earlier days use that
first amount. Other credits don't fit a fixed daily amount and aren't in the
list: the Dependent Child Rebate depends on the number of children (add it to
`credit_cents_per_day` yourself), the air-conditioning rebate only applies in
the north of the state, and one-off bill credits (such as $150 in October
2025) aren't daily.

Synergy plans whose hours don't fit the three rate periods (off-peak
9 pm–9 am, super off-peak 9 am–3 pm, peak 3 pm–9 pm) aren't in the list
either: the Smart Home Plan (7 am boundaries, different weekday and weekend
hours), the EV Add On (an extra overnight period), the EV Home Plan, and the
Community Energy and Community Battery plans (free allowances).

## Changing the app: offline copies and `sw.js`

To work offline, the app saves a copy of its own files in each visitor's
browser. That's the job of the service worker, `public/sw.js`, a small
browser script.

- **The saved copies are always used.** On a visitor's first online visit,
  `sw.js` saves every app file on their device. From then on the browser uses
  those saved copies, even when the device is online.
- **New files are only fetched when `sw.js` changes.** Browsers check `sw.js`
  for changes, and fetch everything again only when it does.
- **So after any change, run the stamp script**, from the project
  folder, then upload `public/` again:
  ```
  python3 stamp_version.py
  ```
  It sets `VERSION` in `sw.js` from the contents of every file, ignoring line
  endings, so Windows and Linux copies get the same version. It also keeps
  `sw.js`'s list of files to save up to date, which matters if you add a file,
  and checks the CSV files in `data/` and copies them into the scripts the app
  reads.
- **If you skip that step, returning visitors don't see your change.**
  Anyone who has opened the app before, you included, keeps getting the old
  version. If you can't run Python, change the `VERSION` line in
  `sw.js` to any new value by hand. A file you added must also be added to
  `FILES` there. Changes to the CSV files in `data/` do need the script.
- **Visitors get the new version on their next online visit.** The app
  downloads it in the background and shows "A new version of the app is
  ready" with a Reload button. Until then the page keeps using the old
  version's files, so it never mixes old and new. Reload switches every open
  tab to the new version; closing every tab of the app does too.
- **Offline mode starts after one online visit over https.** It doesn't apply
  when `index.html` is opened straight from disk. That case always uses the
  files as they are on disk, so it needs no version change.

To check whether `sw.js` is up to date, for example in CI, run:

```
python3 stamp_version.py --check
```

It exits with status 1 if `sw.js` needs stamping. The checks below run it.

To get the newest copy on your own device while testing, use the app's Reload
button when it appears. Reloading the page by itself isn't enough: the new
version waits until it's asked for, or until every tab of the app is closed.
In the browser's developer tools, Application → Service workers → Update
then "skipWaiting" does the same, as does "Clear site data".

## Checks

GitHub Actions runs these on every pull request and on every push
(`.github/workflows/ci.yml`), and again before each publish to GitHub Pages:

- `stamp_version.py`: `data/tariffs.csv` and the sample CSV can be read. If
  `sw.js` or the generated js files weren't stamped after a change, that is
  only a warning, since publishing stamps them anyway; run
  `python3 stamp_version.py` and commit to bring the repository copy up to date.
- ESLint on the app's JavaScript, and Ruff on `stamp_version.py`.
- The tests in `tests/`, run in Node:
  - `readers.test.js`: reading meter and tariff CSVs, and that
    `stamp_version.py` accepts and rejects exactly the same files as the app,
    with the same line numbers (so it needs `python3`). It also stamps temp
    copies of `public/` to check line endings and odd file names.
  - `dashboard.test.js`: the dashboard's figures on the sample readings: every
    reading is counted once, bills add up, the cheapest tariff ranks first,
    and the events added to the sample (the weekend away, the car charging,
    the power cut and so on) are found.
  - `features.test.js`: dated rates and credits, break-even, time of day, cost
    concentration, peak demand, year-on-year figures, the battery and the
    next-bill projection.

  If you replace the sample data, update the dates in `tests/dashboard.test.js`
  and `tests/features.test.js`; if you change the default tariffs, the last
  test in `features.test.js` checks the 2025–26 rates.

To run them yourself you need Node 20.19 or later and Python 3.8 or later:

```
npm ci                # once: installs ESLint into node_modules/
npm run check         # stamp check, ESLint and the tests
uvx ruff check .      # or: pipx run ruff check .
```

## Using it

**Trying it first.** "Try it with sample data" on the first page loads 90
days of real readings, re-dated to July–September 2025. Events have been
added so that every feature has something to show:

- a hot-water boost overnight
- a weekend away
- an electric car charging at peak
- a heatwave
- a heater left on for six days
- a power cut
- a short meter dropout

A note above the dashboard lists them with their dates. Opening or adding
your own file replaces the sample; the sample is never merged with your
readings. The same page also has a link to download the sample CSV.

**Getting the data from Synergy.** The first page shows these steps, and
"How to download from Synergy" above the dashboard shows them again:

1. Log in to your Synergy account at https://my.synergy.net.au/.
2. Select the **Usage** tab at the top of the page.
3. Check that you're on the **Interval Data** page. Below the usage graph,
   select **Export**.
4. Set **Export as** to **CSV**, choose **half-hourly** data intervals and the
   dates you want, then export.
5. Open the CSV in this app.

Synergy exports up to 90 days at a time. For a longer period, export each 90
days and open the files together.

**Then:**

1. **Open the CSV files.** Use Open CSV… or drop them anywhere on the page.
   You can choose several at once. When your provider exports 90 days at a
   time, open all the exports you have. Later, use **Add CSV files…** above
   the dashboard, or drop a file on the page, to add the newest export to
   what's already open. "Show the files" lists each file, with Remove.
2. **Pick a tariff and dates** at the top of the dashboard. Every figure and
   chart follows them.
3. **Use Tariffs to edit the tariffs.** You can change the rates, add or
   remove tariffs, choose which one is current, and import or export a
   tariffs CSV. The app starts with the tariffs in `data/tariffs.csv`, which
   are Synergy Midday Saver (current) and Home Plan.

**Light or dark.** The app follows the device's light or dark setting. The
sun/moon button in the top bar switches it, and the choice is remembered in
that browser.

**How unusual usage is judged.** Each day is compared with up to 14 days
either side of it, so seasons and gradual changes don't count as unusual:

- **Unusual days** used more than 9 in 10 of those days and at least 25% more
  than their middle value, or the same the other way for low days.
- **Spikes** are half-hours at least 0.75 kWh above what that time of day
  reaches on 9 in 10 days. Things that happen most days, like a morning hot
  water boost, therefore don't count.
- **Always-on use** is the average of each day's four lowest half-hours. It
  counts as raised when it is at least 40% and 150 W above usual for 3 days
  or more in a row.

The details are under "About these figures" at the bottom of the dashboard.

**Overlapping files and repeated readings.** Each half-hour is counted once,
however many files, or how many rows of a hand-joined file, contain it:

- **Which copy wins:** a billed reading beats one not yet billed. Otherwise
  the copy from the file whose readings run latest wins, and within one file
  the later row.
- **Joined files:** header rows repeated part-way down a joined file are
  skipped.
- **Reporting:** the line above the dashboard says how many half-hours
  overlapped, and how many had differing readings.
- **Duplicate files:** opening a file that is already open is ignored.

**Missing half-hours.** Every day should have 48 readings. Gaps from
00:00 on the first day to 23:30 on the last are listed above the dashboard
as soon as files are opened, for example "Tue 20 Oct 2026, 13:00–13:30" or
two whole days between two exports. **Data checks** lists the gaps in the
chosen dates. Nothing is counted for missing times, so totals there are
understated.

**Sorting tables.** Select any column heading to sort by it: numbers biggest
first, words A to Z. Select it again to reverse, and a third time to go back
to the table's own order. "What stood out" sorts its whole list, not just the
rows on show. Sorting is remembered.

**What's kept in the browser.** The browser keeps the files you opened,
your tariffs, and your choices. All of this stays in that browser's own
storage (IndexedDB and localStorage) on that device and is never sent
anywhere. **Forget this data**, above the dashboard, removes the readings.
Tariffs stay until you change them.

**Nothing is sent anywhere.** The app has no code that sends data. As a
backstop, the page's Content-Security-Policy has `connect-src 'none'`, so the
browser refuses any network request the page tries to make itself (fetch,
XHR, WebSockets or beacons).

### Interval CSV

These columns are needed, in any order:

| Column | Contents |
| --- | --- |
| `Date` | DD/MM/YYYY, MM/DD/YYYY or YYYY-MM-DD |
| `Time` | start of the half-hour, HH:MM |
| `PEAK (KWH)`, `OFF PEAK (KWH)`, `SUPER OFF PEAK (KWH)` | one reading per row, in whichever column applies |
| `Billing Status` | optional: `Billed`, or anything else for not yet billed |

**How the date order is chosen.** The app works out day/month or
month/day order from the dates themselves. If every date could be read either
way, it reads them as day/month and shows a "Dates are" choice so you can
switch.

**What gets flagged.** Problems that stop the file being read are reported
with their line number. Data problems, such as missing half-hours or days,
zero runs, repeated readings and repeated times, are listed under
**Data checks** in the Unusual usage section.

### Tariffs CSV

This is the layout of `public/data/tariffs.csv`, and of the files Tariffs
imports and exports. Visitors can also replace their own tariff list by
dropping a tariffs CSV on the page, or by importing one under Tariffs.

| Column | Contents |
| --- | --- |
| `tariff` | the tariff's name |
| `current` | `yes` for the tariff the dashboard opens on and compares the others with |
| `from` | optional: the date this row's rates start, YYYY-MM-DD or D/M/YYYY (day first, as Excel saves dates in Australia); blank means from the start |
| `supply_cents_per_day` | the daily supply charge |
| `peak_cents_per_kwh`, `off_peak_cents_per_kwh`, `super_off_peak_cents_per_kwh` | the rate in each period; a flat-rate plan repeats one rate in all three |
| `credit_cents_per_day` | optional: a daily credit, such as the Energy Assistance Payment; blank means none |

- **Amounts** are in cents, written with the digits 0–9 and an optional
  decimal point.
- **Columns** can be in any order, and their names in any case.
- **Rates that change.** A tariff can have several rows, one for each set of
  rates. Each set lasts from its `from` date until the tariff's next one.
  Only one row of a tariff can leave `from` blank, and no two can have the
  same date. `current` = `yes` on any of its rows makes it current.
- **Older files**, without `from` or `credit_cents_per_day`, still work: each
  tariff has one set of rates and no credit.
- **Exports** have every column, one row per set of rates, dates as
  YYYY-MM-DD, and `current` on each of a tariff's rows.

```
tariff,current,from,supply_cents_per_day,peak_cents_per_kwh,off_peak_cents_per_kwh,super_off_peak_cents_per_kwh,credit_cents_per_day
Synergy Midday Saver,yes,,132.7806,55.3253,24.3431,8.8520,0
Home Plan,no,,119.2419,33.2621,33.2621,33.2621,0
Example Plan,no,,110.5000,30.2000,30.2000,30.2000,0
Example Plan,no,1/07/2025,115.0000,31.5000,31.5000,31.5000,150
```

Here Example Plan's rates went up on 1 July 2025, and from then on it has a
daily credit of $1.50.

## Browsers

It is written for current Chrome, Edge, Firefox and Safari, on desktop and
phone. So far it has been tested in Chrome only. Installing is offered where
the browser supports it:

- **Chrome and Edge:** an Install app button appears.
- **Safari on iPhone:** use Share → Add to Home Screen.
- **Safari on Mac:** use File → Add to Dock.

## Licences

d3 is © Mike Bostock and is used under the ISC licence, included in
`public/vendor/d3-LICENSE.txt`.
