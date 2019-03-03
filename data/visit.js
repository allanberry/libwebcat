const request = require("superagent");
const fs = require("fs");
const moment = require("moment");
const csvParse = require("csv-parse/lib/sync");
const puppeteer = require("puppeteer");
const log4js = require("log4js");
const args = require("minimist")(process.argv.slice(2));
const Datastore = require("nedb");
const geoip = require("geoip-lite");
const slugify = require("slugify");
const packageJson = require("../package.json");
const imageSize = require("image-size");
const cheerio = require("cheerio");

// config
const scrapesDir = "data/scrapes";
const waybackDateFormat = "YYYYMMDDHHmmss";
slugify.extend({ ".": "-" });
// const url = args.url;
const startDate = args.startDate ? args.startDate : moment.utc("2012-01-01");
const endDate = args.endDate ? args.endDate : moment();
// const increment = args.increment ? args.increment : "1 year";

// setup database
const db = new Datastore({ filename: "data/nedb.db", autoload: true });

// setup logger
const logger = setupLogger();

// puppeteer viewports, for screenshots
const viewports = [
  {
    name: "mobile",
    width: 600,
    height: 1,
    isLandscape: false
  },
  {
    name: "desktop",
    width: 1200,
    height: 1,
    isLandscape: true
  }
];

/**
 * Main process.
 */
(async () => {
  try {
    // setup
    const browser = await puppeteer.launch();
    const pages = await readCSV("data/pages.csv");

    // get global ip address
    const response = await request.get("ipv4bot.whatismyipaddress.com");
    const ip = response.text;

    // iterate pages
    for (const page of pages) {
      // iterate dates
      let date = startDate;
      while (date.isBefore(endDate)) {
        // scrape
        const wb = await scrapeWayback(page.url, date, browser);

        // include ip address and location information
        wb.source = {
          ip: ip,
          geo: geoip.lookup(ip)
        };

        // update database
        db.insert(wb);

        // console.log(wb);

        date = date.add(1, "years");
      }
    }

    // cleanup
    await browser.close();
  } catch (error) {
    console.error(error);
  }
})();

/**
 * Get data from the Wayback Machine
 * @param {string} url
 * @param {date} dateRequested - A moment date.
 * @param {browser} browser - A Puppeteer browser object.
 */
async function scrapeWayback(url, date, browser) {
  // date format string for moment
  const waybackDateFormat = "YYYYMMDDHHmmss";

  const slug = slugify(url)
    .replace("/", "_")
    .replace("https:", "")
    .replace("http:", "");

  try {
    // setup puppeteer
    const page = await browser.newPage();

    // retrieve next date available from Wayback Machine
    const dateActual = await getWaybackAvailableDate(url, date);

    // build urls
    const wbUrl = waybackUrl(url, dateActual);
    const rawUrl = waybackUrl(url, dateActual, true);

    // puppeteer navigate to page
    await page.goto(wbUrl, {
      waitUntil: "networkidle0"
    });

    // puppeteer strip wayback elements
    await page.evaluate(() => {
      // wayback banner
      let element = document.querySelector("#wm-ipp");
      element.parentNode.removeChild(element);

      // stylesheets
      const wbSheets = [
        'banner-styles.css',
        'iconochive.css',
      ];
      for (str of wbSheets) {
        let element = document.querySelectorAll(`link[href*="${str}"`)[0];
        element.parentNode.removeChild(element);
      }
    });

    // puppeteer gather stylesheets
    const stylesheets = await page.evaluate(x => {
      return Object.keys(document.styleSheets).map(x => {
        return {
          href: document.styleSheets[x].href === null ? 'inline' : document.styleSheets[x].href,
          rules: document.styleSheets[x].rules.length
        };
      });
    });

    // puppeteer take screenshots
    let screenshots = [];
    for (const viewport of viewports) {
      screenshots.push(
        await screenshot(
          page,
          `${scrapesDir}/${slug}/screens`,
          dateActual,
          viewport
        )
      );
    }

    // retrieve raw archive HTML from superagent, and output to file
    const rawHtml = await request.get(rawUrl);
    const pageDir = `${scrapesDir}/${slug}/pages`;
    await fs.promises.mkdir(pageDir, { recursive: true });
    const pageName = `${dateActual.format(waybackDateFormat)}.html`;
    const pageFile = `${pageDir}/${pageName}`;
    if (!fs.existsSync(pageFile)) {
      await fs.promises.writeFile(pageFile, rawHtml.text);
      logger.info(`page OK:   ${pageFile}`);
    } else {
      logger.warn(`page --:   ${pageFile} (exists)`);
    }

    // retrieve internal page elements
    const $ = cheerio.load(rawHtml.text);
    const rawTitle = $("title").text();
    const elementQty = $("html *").length;

    // output
    const output = {
      url: url,
      slug: slug,
      date: dateActual.format(),
      dateScraped: moment.utc().format(),

      // for data from puppeteer, for the most part
      rendered: {
        url: wbUrl,
        title: await page.title(),
        css: {
          stylesheets: stylesheets,
          metrics: {
            sheetsWithZeroStyles: stylesheets.reduce((acc, val) => {
              return val.rules == 0 ? acc + 1 : acc;
            }, 0),
            totalStyles: stylesheets.reduce((acc, val) => acc + val.rules, 0)
          },
        },
        agent: {
          name: "Node.js/Puppeteer",
          url: "https://github.com/GoogleChrome/puppeteer",
          version: packageJson.dependencies.puppeteer
        },
        metrics: await page.metrics(),
        browser: {
          userAgent: await browser.userAgent(),
          version: await browser.version()
        },
        screenshots: screenshots
      },

      // for raw HTML, from Superagent
      raw: {
        url: rawUrl,
        title: rawTitle,
        agent: {
          name: "Node.js/Superagent",
          url: "https://github.com/visionmedia/superagent",
          version: packageJson.dependencies.superagent
        },
        metrics: {
          elements: elementQty
        },
        html: `${pageName}`,
        response: {
          status: rawHtml.status,
          type: rawHtml.type,
          headers: rawHtml.header
        }
      }
    };

    // clean up
    await page.close();

    // finally return output
    return output;
  } catch (error) {
    logger.error(error);
  }
}

/**
 * Get data from the Wayback Machine
 * @param {string} url - A full url string.
 * @param {date} date - A moment date.
 * @param {boolean} raw - Whether or not the actual raw HTML is desired.
 */
function waybackUrl(url, date, raw = false) {
  return raw
    ? `http://web.archive.org/web/${date.format(waybackDateFormat)}id_/${url}`
    : `http://web.archive.org/web/${date.format(waybackDateFormat)}/${url}`;
}

/**
 * Get nearest available date from Wayback Machine
 * @param {string} url - A full url string.
 * @param {date} date - A moment date.
 */
async function getWaybackAvailableDate(url, date) {
  // inquire with wayback for archived site closest in time to input date
  const availableResponse = await request.get(
    `https://archive.org/wayback/available?url=${url}/&timestamp=${date.format(
      waybackDateFormat
    )}`
  );
  // determine date and actual Wayback URLs from superagent
  return moment.utc(
    availableResponse.body.archived_snapshots.closest.timestamp,
    waybackDateFormat
  );
}

/**
 * A logger to track script progress.
 */
function setupLogger() {
  // logger
  const logger = log4js.getLogger();
  logger.level = "debug";
  log4js.configure({
    appenders: {
      out: { type: "stdout" },
      app: { type: "file", filename: "log/scrape.log" }
    },
    categories: {
      default: { appenders: ["out", "app"], level: "debug" }
    }
  });
  return logger;
}

/**
 * Simplified csv input.
 * @param {string} csv - A path to a CSV file.
 */
async function readCSV(csv) {
  return csvParse(await fs.promises.readFile(csv, "utf8"), {
    columns: true,
    skip_empty_lines: true
  });
}

/**
 * Get screenshot from puppeteer
 * @param {page} page - A puppeteer page
 * @param {string} dir - a local directory path
 * @param {string} slug - an arbitrary identifier
 * @param {object} viewport
 */
async function screenshot(page, dir, date, viewport) {
  const name = `${date.format(waybackDateFormat)}-${viewport.name}.png`;
  const file = `${dir}/${name}`;
  try {
    // setup screenshot directory
    await fs.promises.mkdir(dir, { recursive: true });
    await page.setViewport(viewport);

    // determine if pic already exists
    if (!fs.existsSync(file)) {
      await page.screenshot({
        path: file,
        fullPage: viewport.height <= 1 ? true : false
      });
      logger.info(`screen OK: ${file}`);
    } else {
      logger.warn(`screen --: ${file} (exists)`);
    }

    const calculatedDimensions = await page.evaluate(() => {
      // calculate document height
      // hat tip https://stackoverflow.com/a/1147768/652626
      // get largest height that exists in the document
      const body = document.body;
      const html = document.documentElement;
      const height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      );

      // getting width is simpler
      const width =
        document.width !== undefined
          ? document.width
          : document.body.offsetWidth;

      return { height, width };
    });

    // retrieve actual image dimensions from disk
    const physicalDimensions = imageSize(file);

    return {
      name: name,
      viewport: viewport,
      dimensions: {
        physical: {
          height: physicalDimensions.height,
          width: physicalDimensions.width
        },
        calculated: {
          height: calculatedDimensions.height,
          width: calculatedDimensions.width
        }
      }
    };
  } catch (error) {
    logger.error(`screen !!: ${file}`);
    logger.error(error);
  }
}
