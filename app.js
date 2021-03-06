
/* Module dependencies.*/
const http = require('http')
	, path = require('path')
	, fs = require('fs')
	, URL = require('url').URL
	, childProcess = require('child_process')
	, express = require('express')
	, bodyParser = require('body-parser')
	, errorhandler = require('errorhandler')
	, morgan = require('morgan')
	, serveFavicon = require('serve-favicon')
	, serveStatic = require('serve-static')
	, compression = require('compression')
	, phantomjs = require('phantomjs-prebuilt')
	, logoScrape = require('logo-scrape')
  , chrome = require('selenium-webdriver/chrome')
  , { Builder } = require('selenium-webdriver');

/* Variables / Config */
const config = {
	binPath: phantomjs.path
	, crawlerFilePath: "stylify-crawler.js"
	, rasterizeFilePath: "phantom-rasterize.js"
	, screenshotCacheTime: 5000 * 1 //in ms (1000ms = 1 sec)
};

const defaultReferers = [
	"http://stylifyme.com",
	"http://www.stylifyme.com",
	"http://stylify.herokuapp.com",
	"http://localhost:9185",
	"http://localhost:7210",
];

/* Return the valid referers, either from an envvar or the defaults */
const referers = () => {
	const validReferers = process.env.VALID_REFERERS
		? process.env.VALID_REFERERS.split(",").map(i => i.trim())
		: defaultReferers;

	// always accept from localhost
	validReferers.push(`http://localhost:${app.get('port')}`);

	return validReferers;
};

const app = express();

app.set('port', process.env.PORT || 5000);
app.use(compression());
app.use(morgan('short'));
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(serveFavicon(path.join(__dirname + '/public/favicon.ico')));
app.use(bodyParser.json());
app.use(serveStatic(path.join(__dirname, 'public')));
app.set('validReferers', referers());

if (app.get('env') === 'development') {
	app.use(errorhandler({ dumpExceptions: true, showStack: true }));
}

if (app.get('env') === 'production') {
	app.use(errorhandler());
}

app.use((err, req, res, next) => {
	console.error(err.stack);
	res.send(500, '<h1>Something\'s gone wrong!</h1><p>Please try to refresh the page</p>');
});


const utils = {
	isValidURL: (urlPath) => {
    try {
      const maybeUrl = new URL(urlPath);
      if (!maybeUrl.hostname || !/http[s]?:/.test(maybeUrl.protocol)) {
        return false;
      }
    } catch (error) {
      return false;
    }
    return true;
	},
	deleteFile: (filePath) => {
		try {
			fs.unlink(filePath, () => {
				console.log("file deleted", filePath, arguments);
			});
		} catch (e) {
			console.log("ERR:file delete error", e);
		}
	},

	isRefererValid: (referer) => {
		if (app.get('validReferers').some(i => i === "*" || i === referer)) {
			return true
		}

		console.log("ERR:Invalid referer:", referer);

		return false;
	},

	parsePhantomResponse: (err, stdout, stderr, onsuccess, onerror) => {
		let jsonResponse = {};
		try {
			if (err || stderr) {
				console.log("ERR:PHANTOM>" + (stderr || err));
				onerror(stdout || err || "Error parsing site - please try again ", "111");
			} else if (stdout.indexOf("ERROR") === 0 || stdout.indexOf("PHANTOM ERROR:") === 0) {

				console.log("ERR:PHANTOM>" + stdout);


				const errorCode = stdout.match(/ERROR\((\d+)\)/)[1];
				switch (errorCode) {
					case "404": onerror("Fail to load the current url - please make sure you don't have typos", errorCode);
						break;
					case "502": onerror("Fail to parse site - the site might try to redirect or has invalid markup", errorCode);
						break;
					case "400": onerror("Invalid url - please make sure you don't have typos", errorCode);
						break;
					default: onerror(stdout.replace("ERROR:", "").replace(/\r\n/, " ") || "error", errorCode || "000");
				}
			} else if (stdout.indexOf("CONSOLE:") === 0) {
				jsonResponse = JSON.parse(stdout.replace(/(CONSOLE:).*[\n\r]/gi, ""));
				onsuccess(jsonResponse);
				//delete thumbnail after a bit
				setTimeout(utils.deleteFile, config.screenshotCacheTime, path.join(__dirname, "public", jsonResponse.thumbPath));
			} else {
				jsonResponse = JSON.parse(stdout);
				onsuccess(jsonResponse);

				//delete thumbnail after a bit
				setTimeout(utils.deleteFile, config.screenshotCacheTime, path.join(__dirname, "public", jsonResponse.thumbPath));
			}
		} catch (e) {
			console.log(e);
			onerror("Fail to parse response", "999");
		}
	},
	makeFilename: (url) => {
		return url.replace(/https?:\/\//, "").replace(/[\/:/]/g, "_");
	}
}


/* Routes */
app.get('/', (req, res) => {
	res.redirect(301, "http://stylifyme.com/");
});

app.get('/about', (req, res) => {
	res.redirect(301, "http://stylifyme.com/about-us");
});

// renders html for PDF
app.get('/renderpdfview', (req, res) => {
	const referer = req.get("Referer") || "http://stylify.herokuapp.com"
		, showImage = true
		, debugMode = false;
	let url, childArgs, phantomProcess;
	if (utils.isRefererValid(referer)) {
		url = req.query["url"];
		if (url && utils.isValidURL(url)) {
			childArgs = [
				config.crawlerFilePath
				, req.query["url"]
				, '--local-url-access=false'
				, '--ignore-ssl-errors=true'
				, '--ssl-protocol=any'
				, `--load-images=${showImage}`
				, `--debug=${debugMode}`
			];
			try {
				phantomProcess = childProcess.execFile(config.binPath, childArgs, { timeout: 25000 }, (err, stdout, stderr) => {
					utils.parsePhantomResponse(err, stdout, stderr, (jsonResponse) => {
						res.render('pdfbase', { title: 'Stylify Me - Extract', pageUrl: url, data: jsonResponse });
					}
						, (errorMsg, errorCode) => {
							phantomProcess.kill();
							res.status(503).jsonp({ "error": errorMsg, "errorCode": errorCode || "000" });
						});
				});
			} catch (err) {
				phantomProcess.kill();
				console.log("ERR:Could not create render pdf child process", url);
				res.status(503).jsonp({ "error": "Eror creating pdf" });
			}
		} else {
			console.log("ERR:Invalid or missing url parameter", url);
			res.status(503).jsonp({ "error": 'Invalid or missing "url" parameter' });
		}
	} else {
		res.status(401).jsonp({ "error": 'Invalid referer' });
	}
});

// returns PDF file
app.get('/getpdf', (req, res) => {
	const referer = req.get("Referer") || "http://stylify.herokuapp.com";
	let url, childArgs, filename, phantomProcess;
	if (utils.isRefererValid(referer)) {
		url = req.query["url"];
		if (url && utils.isValidURL(url)) {
			filename = "public/pdf/temp" + utils.makeFilename(url) + "_" + new Date().getTime().toString() + ".pdf";
			childArgs = [config.rasterizeFilePath, req.protocol + "://" + req.get('host') + "/renderpdfview?url=" + encodeURIComponent(url), filename, "A4"];
			try {
				phantomProcess = childProcess.execFile(config.binPath, childArgs, { timeout: 50000 }, (err, stdout, stderr) => {
					console.log("LOG: CREATED PDF", filename);
					res.download(filename, "stylify-me " + utils.makeFilename(url) + ".pdf", (err) => {
						utils.deleteFile(filename);
						phantomProcess.kill();
					});
				});
			} catch (err) {
				phantomProcess.kill();
				console.log("ERR:Could not create get pdf child process", url);
				res.status(200).jsonp({ "error": 'Sorry, our server experiences a high load and the service is currently unavailable', "errorCode": "503" });
			}
		} else {
			console.log("ERR:Invalid or missing url parameter", url);
			res.status(200).jsonp({ "error": 'Invalid or missing "url" parameter' });
		}
	} else {
		res.status(401).jsonp({ "error": 'Invalid referer' });
	}
});


// returns stylify json
app.get("/query", async (req, res) => {
  url = req.query["url"];
  if (url && utils.isValidURL(url)) {
    try {

      let opts = new chrome.Options()
      opts.addArguments("--no-sandbox", "--headless")

      let driver = new Builder()
        .forBrowser("chrome")
        .setChromeOptions(opts)
        .build();

      await driver.get(url);

      await new Promise((resolve, reject) => {
        fs.readFile("./lib/jquery-2.1.1.min.js", "utf8", async (err, data) => {
          await driver.executeScript(data);
          resolve();
        });
      });

      jsonResponse = await new Promise((resolve, reject) => {
        fs.readFile("./drip_page_parser.js", "utf8", async (err, data) => {
          try {
            let scrapedResponse = await driver.executeScript(data);
            driver.quit();

            resolve(scrapedResponse);
          } catch (error) {
            resolve({ error: error.toString() });
          }
        });
      });

      logoScrape.LogoScrape.getLogos(url)
        .then((logos) => {
          res
            .status(200)
            .jsonp(Object.assign({}, jsonResponse, { logos: logos }));
        })
        .catch((err) =>
          res
            .status(200)
            .jsonp(Object.assign({}, jsonResponse, { logo_error: err }))
        );
    } catch (error) {
      console.log("ERR: Something went wrong with chromedriver", error);
      res
        .status(200)
        .jsonp({ error: error.toString(), errorCode: "500" });
    }
  } else {
    console.log("ERR:Invalid or missing url parameter", url);
    res
      .status(200)
      .jsonp({ error: 'Invalid or missing "url" parameter', errorCode: "500" });
  }
});


// returns phantom js version number
app.get('/version', (req, res) => {
	const childArgs = ["--version"];
	let phantomProcess;
	try {
		phantomProcess = childProcess.execFile(config.binPath, childArgs, { timeout: 5000 }, (err, stdout, stderr) => {
			res.status(200).jsonp((err || stdout || stderr).replace(/[\n\r]+/g, ""));
		});
	} catch (err) {
		phantomProcess.kill();

	}
});


// Handle 404
/*app.get("[^/temp-img]", function(req, res) {
   // res.redirect(301, "http://stylifyme.com");
});*/

http.createServer(app).listen(app.get('port'), () => {
	console.log("Express server listening on port " + app.get('port'));
});
