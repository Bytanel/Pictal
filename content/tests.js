"use strict";

const protocolRegex = new RegExp(/^(?:(https?:\/\/(?:www\.)?))?(.*)$/i);

async function makeRequest(method, url, blob = false) {
	try {
		// try from page context with cookies
		var response = await fetch(url, {
			method: method,
			cache: "default"
		});
		if (blob) {
			var body = await response.blob();
		} else {
			var body = await response.text();
		}
		var headers = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
	} catch (error) {
		// try from service worker
		var response = await chrome.runtime.sendMessage({
			type: "MakeRequest",
			url: url,
			method: method
		});
		var body = response.body;
		var headers = response.headers;
	}
	return {
		status: response.status,
		headers: headers,
		body: body
	};
}


const PICTAL = {}

function checkSieveURLs(urls, type, linkRegex, filter_javascript) {
	for (const e of urls) {
		if (!protocolRegex.test(e)) continue;
		const [, protocol, url] = e.match(protocolRegex);

		if (linkRegex.test(url)) {
			return [type, protocol, url];
		}
	}
	return null;
}

chrome.runtime.sendMessage({
	type: "GetSieves"
}, (response) => {
	PICTAL.Sieves = response.sieves;

	const url = [window.location.hash.slice(1)];

	// precompile all the regex statements
	let tgtURL = null;
	for (const key in PICTAL.Sieves) {
		const sieve = PICTAL.Sieves[key];
		if (!sieve.enabled) continue;

		if (sieve.link_regex) sieve.link_regex = new RegExp(sieve.link_regex, "i");
		if (sieve.image_regex) sieve.image_regex = new RegExp(sieve.image_regex, "i");


		if (sieve.prioritize_images) {
			if (sieve.image_regex) {
				tgtURL = checkSieveURLs(url, "image", sieve.image_regex, sieve.image_filter_javascript);
			}
			if (!tgtURL && sieve.link_regex) {
				tgtURL = checkSieveURLs(url, "link", sieve.link_regex, sieve.link_filter_javascript);
			}
		} else {
			if (sieve.link_regex) {
				tgtURL = checkSieveURLs(url, "link", sieve.link_regex, sieve.link_filter_javascript);
			}
			if (!tgtURL && sieve.image_regex) {
				tgtURL = checkSieveURLs(url, "image", sieve.image_regex, sieve.image_filter_javascript);
			}
		}

		if (tgtURL) {
			console.log(sieve, tgtURL);
			setupTimer(sieve, null, tgtURL);
			return;
		}
	}
	console.error("Failed to match a sieve.");
});


function setupTimer(sieve = null, target = null, targetURL = null) {
	let [sieveType, protocol, link] = targetURL;

	const fullURL = protocol + link;

	// check for errors in the returned album array before trying to load it in the viewer
	function handleFiles(url, files) {
		if (!files?.length) {
			console.error("[Files Object Check]", "The returned array is empty.");
			return;
		}

		if (new Set(files.map(x => x.url)).size != files.length) {
			console.error("[Files Object Check]", "The returned array contains duplicate urls.");
			return;
		}

		if (files.find(x => !x.url)) {
			console.error("[Files Object Check]", "The returned array contains an empty url.");
			return;
		}

		chrome.runtime.sendMessage({
			type: "TestComplete",
			files: files
		});
	}


	setTimeout(() => {

		if (sieveType == "link") {
			async function runParseJavascript() {
				try {
					var files = await Function(`'use strict'; return (async () => {${sieve.link_parse_javascript}})();`).bind({
						protocol: protocol,
						link: link,
						regex: sieve.link_regex,
						regex_match: link.match(sieve.link_regex),
						request: makeRequest,
						node: target
					})();
				} catch (error) {
					console.error("[Link Parse Javascript]", error);
					return [];
				}
				return files;
			}

			if (!sieve.link_parse_javascript) {
				handleFiles(fullURL, [{
					url: fullURL
				}]);
			} else {
				runParseJavascript().then(files => {
					handleFiles(fullURL, files);
				});
			}
		}



		if (sieveType == "image") {
			let links = [fullURL];
			if (sieve.image_parse_javascript) {
				try {
					var request_url = Function(`'use strict';` + sieve.image_parse_javascript).bind({
						protocol: protocol,
						link: link,
						regex: sieve.image_regex,
						regex_match: link.match(sieve.image_regex),
						node: target
					})();
				} catch (error) {
					console.error("[Image Parse Javascript]:", error);
					return;
				}

				if (!request_url) {
					console.error("[Image Parse Javascript]:", "A string was not returned by Image Parse Javascript.");
					return;
				}

				// construct a url for each # permutation 
				const match = request_url.match(/#([^#]+)#/);
				links = match ? match[1].trim().split(/\s+/).map(ext => request_url.replace(match[0], ext)) : [request_url];
			}

			// if it's a single possible link and we know the filetype then just use it
			const ext = new URL(links[0])?.pathname?.split(".").pop();
			if (links.length == 1 && ext && /^(png|jpe?g|gif|avif|mp[34]|web[mp]|m3u8|mpd)$/gi.test(ext)) {
				let files = [{
					url: links[0],
					video: /^(mp[34]|webm)$/gi.test(ext),
					videojs: /^(m3u8|mpd)$/gi.test(ext)
				}];
				handleFiles(fullURL, files);
				return;
			}




			// some sites will deny using HEAD so just try to load it normally to determine if it works
			async function testLink(url) {
				let img = new Image();
				const imgPromise = new Promise(resolve => {
					img.onload = () => resolve(true);
					img.onerror = () => resolve(false);
					img.src = url;
				});

				const video = document.createElement("video");
				video.preload = "metadata";
				const videoPromise = new Promise(resolve => {
					video.onloadedmetadata = () => resolve(true);
					video.onerror = () => resolve(false);
					video.src = url;
				});

				const [imageResult, videoResult] = await Promise.all([imgPromise, videoPromise]);

				video.remove();
				img = null;

				return {
					url,
					image: imageResult,
					video: videoResult
				};
			}


			// look for valid links
			(async () => {
				const triedLinks = await Promise.all(links.map(testLink));

				for (const resp of triedLinks) {
					if (!resp.image && !resp.video) continue;

					const files = [{
						url: resp.url,
						video: resp.video
					}];

					handleFiles(fullURL, files);
					break;
				}
			})();
		}
	}, 1);
}