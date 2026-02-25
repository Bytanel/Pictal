"use strict";

const platform = (navigator.vendor != "Google Inc.") ? "firefox" : "chrome";
const protocolRegex = new RegExp(/^(?:(https?:\/\/(?:www\.)?))?(.*)$/i);

chrome.runtime.sendMessage({
	type: "GetSiteFilters"
}, (response) => {
	let [, protocol, url] = window.location.href.match(protocolRegex);

	// site filters
	let blacklisted = false;
	for (const f of response.filters.split("\n")) {
		const line = f.trim();
		if (line[1] != ":") continue;

		const regex = new RegExp(line.substr(2), "i");
		const matches = regex.test(url);
		if (!matches) continue;

		if (line[0] == "~") {
			blacklisted = false;
			break;
		}
		if (line[0] == "!") {
			blacklisted = true;
		}
	}

	if (window.location.hash.includes("PICTALFILENAME=")) {
		downloadFile();
	} else if (window == window.top && !blacklisted && document.contentType == "text/html") { // don't run in iframes and only run on web pages, not direct media files
		// has to be done here otherwise throws errors for some reason
		chrome.runtime.sendMessage({
			type: "GetVideoJSJavacript"
		}, (response) => {
			eval(response.js);
		});

		loadPictal();
	}
});

async function makeRequest(url, method, blob = false) {
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

// backup file downloader that bypasses CORS and referrer requirements
function downloadFile() {
	try {
		document.title = "[Pictal] Downloading... DO NOT CLOSE";

		const link = window.location.href;
		const filename = window.location.hash.split("PICTALFILENAME=")[1];

		// mute autoplaying videos
		document.querySelectorAll("video").forEach(vid => {
			vid.volume = 0;
			vid.muted = true;
			vid.pause();
		});

		makeRequest(link, "GET", true).then(resp => {
			chrome.runtime.sendMessage({
				type: "Download",
				url: URL.createObjectURL(resp.body), // CHROME: URL.createObjectURL is disabled in service workers but you can just do it here and pass the url lol
				filename: filename,
				blob: resp.body
			}, () => {
				window.close();
			});
		});
	} catch (err) {
		window.close();
	}
}

function loadPictal() {
	chrome.runtime.sendMessage({
		type: "GetVideoJSCSS"
	}, (response) => {
		const style = document.createElement("style");
		style.textContent = response.css;
		document.documentElement.appendChild(style);
	});
	chrome.runtime.sendMessage({
		type: "GetSieves"
	}, (response) => {
		PICTAL.Sieves = response.sieves;
	});
	chrome.runtime.sendMessage({
		type: "GetPreferences"
	}, (response) => {
		PICTAL.Preferences = response.preferences;
		PICTAL.Volume = PICTAL.Preferences["video_volume"] / 100;
	});
	chrome.runtime.sendMessage({
		type: "GetShortcuts"
	}, (response) => {
		PICTAL.Shortcuts = response.shortcuts;
	});

	const PICTAL = {
		State: "idle",
		isHoldingActivateKey: false,
		Center: false,
		CenterZoom: .75,
		MouseX: 0,
		MouseY: 0,
		Muted: false,
		Volume: 0,
		Files: [],
		FileIndex: 0,
		FileCache: [],
		Scale: [1, 1],
		Rotation: 0,
		ViewMode: "default",
		HoverTimer: null,
		HoverTimerVars: {},
	}

	function setupVideoJS() {
		if (PICTAL.VIDEOJS) return;

		const vid = PICTAL.VIDEO.cloneNode();
		vid.className = "video-js vjs-default-skin";
		vid.style.display = "block";
		PICTAL.DIV.appendChild(vid);

		PICTAL.VIDEOJS = videojs(vid);
		PICTAL.VIDEOJS.muted(PICTAL.Muted);
		PICTAL.VIDEOJSQUALITY = PICTAL.VIDEOJS.maxQualitySelector({
			autoLabel: "Auto",
			disableAuto: true,
			displayMode: 0,
			defaultQuality: 2,
			filterDuplicateHeights: false,
			filterDuplicates: false,
			showBitrates: true
		});
		PICTAL.VIDEOJS.on("loadedmetadata", PICTAL.VIDEO.onloadedmetadata);
	}

	function clamp(number, min, max) {
		return Math.max(min, Math.min(number, max));
	}

	function createPreviewElements() {
		if (PICTAL.DIV) return;

		PICTAL.DIV = document.createElement("div");
		document.documentElement.appendChild(PICTAL.DIV);
		PICTAL.DIV.style.cssText = `
		    padding: 0px;
		    margin: 3px;
		    background: rgb(248, 248, 255) padding-box;
		    border: 3px solid rgba(242, 242, 242, 0.6);
		    border-radius: 2px;
		    box-shadow: rgb(102, 102, 102) 0px 0px 2px;
		    transition: all;
		    visibility: visible;
		    opacity: 0;
		    z-index: 2147483646;
		    width: 0;
		    height: 0;
		    position: fixed !important;   
		    inset: 0;
		    pointer-events: none;
		    opacity: 0;
		`;

		PICTAL.IMG = document.createElement("img");
		PICTAL.IMG.alt = "";
		PICTAL.IMG.style.cssText = `
        	display: none;
        	width: 100%;
        	height: 100%;
        	cursor: zoom-in;
		`;
		PICTAL.IMG.onloadeddata = () => {
			if (PICTAL.State != "loading") return;

			PICTAL.LOADER.style.opacity = "0";
			PICTAL.DIV.style.opacity = "1";
			PICTAL.IMG.style.display = "block";
			PICTAL.State = "preview";

			renderFrame();
		};
		PICTAL.IMG.addEventListener("load", function() {
			PICTAL.IMG.onloadeddata();
			if (!PICTAL.Preferences["preload_ahead"]) return;

			for (let i = PICTAL.FileIndex; i <= PICTAL.FileIndex + 2; i++) {
				const file = PICTAL.Files[i];
				if (!file) break;

				if (file.video) continue;

				let imagePreloader = new Image();
				imagePreloader.src = file.url;
			}
		}, false);
		PICTAL.IMG.addEventListener("error", function() {
			clearInterval(PICTAL.IMGTIMER);

			PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
		}, false);
		PICTAL.DIV.appendChild(PICTAL.IMG);


		PICTAL.VIDEO = document.createElement("video");
		PICTAL.VIDEO.autoplay = true;
		PICTAL.VIDEO.controls = true;
		PICTAL.VIDEO.preload = "auto";
		PICTAL.VIDEO.volume = PICTAL.Volume;
		PICTAL.VIDEO.style.cssText = `
		    display: none;
		    width: 100%;
		    height: 100%;
		    cursor: zoom-in;
		`;
		PICTAL.VIDEO.onloadedmetadata = function(e) {
			if (PICTAL.State != "loading") return;


			if (PICTAL.Files[PICTAL.FileIndex].videojs) {
				PICTAL.VIDEOJS.el().style.display = "block";
				PICTAL.VIDEOJS.loop(PICTAL.VIDEOJS.duration() <= 60);
				PICTAL.VIDEOJS.muted(PICTAL.Muted);
				PICTAL.VIDEOJS.volume(PICTAL.Volume);
				PICTAL.VIDEOJS.play().catch(() => {
					PICTAL.VIDEOJS.muted(true);
					PICTAL.Muted = true;
					PICTAL.VIDEOJS.play();
				});
			} else {
				PICTAL.VIDEO.loop = (PICTAL.VIDEO.duration <= 60);
				PICTAL.VIDEO.style.display = "block";
				PICTAL.VIDEO.volume = PICTAL.Volume;
				PICTAL.VIDEO.play().catch(() => {
					PICTAL.VIDEO.muted = true;
					PICTAL.Muted = true;
					PICTAL.VIDEO.play();
				});
			}

			PICTAL.LOADER.style.opacity = "0";
			PICTAL.DIV.style.opacity = "1";
			PICTAL.State = "preview";
			renderFrame();
		};
		PICTAL.DIV.appendChild(PICTAL.VIDEO);

		PICTAL.HEADER = document.createElement("div");
		PICTAL.HEADER.id = "pictal-header";
		PICTAL.HEADER.style.cssText = `
		    position: absolute;
		    white-space: ${PICTAL.Preferences["wrap_caption"] || "nowrap"};
		    box-shadow: rgb(221, 221, 221) 0px 0px 1px inset;
		    padding: 2px;
		    border-radius: 3px;
		    background: rgba(0, 0, 0, 0.75) !important;
		    color: rgb(255, 255, 255) !important;
		    top: -24px;
		    font: 13px/1.4em "Trebuchet MS", sans-serif;
		    opacity: 0;
		`;
		PICTAL.DIV.appendChild(PICTAL.HEADER);

		PICTAL.PAGINATOR = document.createElement("b");
		PICTAL.PAGINATOR.style.cssText = `
		    display: none;
		    transition: background-color 0.1s;
		    border-radius: 3px;
		    padding: 0px 2px;
		    color: rgb(0, 0, 0);
		    background-color: rgb(255, 255, 0);
		`;
		PICTAL.HEADER.appendChild(PICTAL.PAGINATOR);

		PICTAL.RESOLUTION = document.createElement("b");
		PICTAL.RESOLUTION.style.cssText = `
		    display: none;
		    color: rgb(120, 210, 255);
		`;
		PICTAL.HEADER.appendChild(PICTAL.RESOLUTION);

		PICTAL.CAPTION = document.createElement("span");
		PICTAL.CAPTION.style.cssText = `
		    color: inherit;
		    display: none;
		`;
		PICTAL.HEADER.appendChild(PICTAL.CAPTION);
	}

	PICTAL.OUTLINE = document.createElement("div");
	PICTAL.OUTLINE.style.cssText = `
	    position: absolute;
	    box-sizing: content-box;
	    pointer-events: none;
	    z-index: 2147483645;
	    opacity: 0;
	    padding: 0;
	    margin: 0;
		outline: red dashed 2px;
	`;
	document.documentElement.appendChild(PICTAL.OUTLINE);

	PICTAL.LOADER = document.createElement("img");
	PICTAL.LOADER.style.cssText = `
	    padding: 5px;
	    border-radius: 50% !important;
	    box-shadow: 0px 0px 5px 1px #a6a6a6 !important;
	    background-color: rgb(255, 255, 255);
	    background-clip: padding-box;
	    width: 38px;
	    height: 38px;
	    position: fixed !important;
	    z-index: 2147483647;
	    display: block;
	    inset: 0;
	    margin: 0;
	    opacity: 0;
	    pointer-events: none;
	`;
	PICTAL.LOADER.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOng9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWluWU1pbiBub25lIj48Zz48cGF0aCBpZD0icCIgZD0iTTMzIDQyYTEgMSAwIDAgMSA1NS0yMCAzNiAzNiAwIDAgMC01NSAyMCIvPjx1c2UgeDpocmVmPSIjcCIgdHJhbnNmb3JtPSJyb3RhdGUoNzIgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgxNDQgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgyMTYgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgyODggNTAgNTApIi8+PGFuaW1hdGVUcmFuc2Zvcm0gYXR0cmlidXRlTmFtZT0idHJhbnNmb3JtIiB0eXBlPSJyb3RhdGUiIHZhbHVlcz0iMzYwIDUwIDUwOzAgNTAgNTAiIGR1cj0iMS44cyIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiLz48L2c+PC9zdmc+";
	document.documentElement.appendChild(PICTAL.LOADER);

	function updateLoader() {
		if (PICTAL.State != "loading") return;

		PICTAL.LOADER.style.opacity = "1";
		if (PICTAL.Center) {
			const minHeight = 15;
			const maxHeight = window.innerHeight - 15 - minHeight;
			const maxWidth = window.innerWidth - 25;

			PICTAL.LOADER.style.top = `${(maxHeight / 2)}px`;
			PICTAL.LOADER.style.left = `${(maxWidth / 2)}px`;
		} else {
			PICTAL.LOADER.style.left = `${PICTAL.MouseX}px`;
			PICTAL.LOADER.style.top = `${PICTAL.MouseY - 50}px`;
		}
	}

	function loadPreviewFiles(fullURL = null) {
		if (fullURL) {
			PICTAL.FileCache[fullURL] = PICTAL.Files;
		}

		const file = PICTAL.Files[PICTAL.FileIndex];
		if (PICTAL.VIDEO.src == file.url || PICTAL.VIDEOJS?.currentSrc() || file.url == PICTAL.IMG.src) return;

		clearInterval(PICTAL.IMGTIMER);
		PICTAL.CenterZoom = .75;
		PICTAL.IMG.style.display = "none";
		PICTAL.IMG.removeAttribute("src");

		PICTAL.VIDEO.style.display = "none";
		PICTAL.VIDEO.pause();
		PICTAL.VIDEO.removeAttribute("src");

		if (PICTAL.VIDEOJS) PICTAL.VIDEOJS.el().style.display = "none";
		PICTAL.VIDEOJS?.dispose(); // resetting or changing src is way too slow so just delete and recreate the object
		PICTAL.VIDEOJS = null;

		if (file.video) {
			if (file.videojs) {
				setupVideoJS();
				PICTAL.VIDEOJS.src({
					src: file.url
				});
			} else {
				PICTAL.VIDEO.src = file.url;
			}
		} else {
			PICTAL.IMG.src = file.url;
			PICTAL.IMGTIMER = setInterval(function() { // faster than waiting for the entire image to load before showing preview
				if (PICTAL.IMG.naturalWidth) {
					clearInterval(PICTAL.IMGTIMER);
					PICTAL.IMG.onloadeddata();
				}
			}, 100);
		}

		PICTAL.State = "loading";
		PICTAL.HEADER.style.opacity = (PICTAL.Files.length > 1 || PICTAL.Files[PICTAL.FileIndex].caption || PICTAL.Preferences["show_resolution"]) ? "1" : "0";
	}

	function setupTimer(sieve, target, targetURL) {
		clearTimeout(PICTAL.HoverTimer);
		PICTAL.HoverTimerVars = {
			sieve: sieve,
			target: target,
			targetURL: targetURL
		};

		const fullURL = targetURL[1] + targetURL[2];

		PICTAL.HoverTimer = setTimeout(() => {
			PICTAL.State = "loading";
			updateLoader();
			createPreviewElements();

			if (PICTAL.FileCache[fullURL]) {
				PICTAL.Files = PICTAL.FileCache[fullURL];
				loadPreviewFiles();
				return;
			}


			if (targetURL[0] == "link") {
				let request_url = fullURL;
				const link_regex = new RegExp(sieve.link_regex, "i");

				if (sieve.link_request_javascript) {
					try {
						request_url = Function(`'use strict';` + sieve.link_request_javascript).bind({
							protocol: targetURL[1],
							link: targetURL[2],
							regex: link_regex,
							regex_match: targetURL[2].match(link_regex),
							node: target
						})();
						request_url = request_url;
					} catch (error) {
						console.error("[link_request_javascript]:", error);
						PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
						return;
					}
					if (typeof request_url != "string") {
						console.error("[link_request_javascript]:", "The returned object is not a string.");
						PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
						return;
					}
				}

				function runParseJavascript(body, passthrough = {}) {
					try {
						var files = Function(`'use strict';` + sieve.link_parse_javascript).bind({
							protocol: targetURL[1],
							link: targetURL[2],
							regex: link_regex,
							regex_match: targetURL[2].match(link_regex),
							node: target,
							body: body,
							passthrough: passthrough,
						})();
					} catch (error) {
						console.error("[link_parse_javascript]", error);
						PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
						return [];
					}
					return files;
				}

				function recursiveRequest(url, passthrough = {}) {
					return makeRequest(url, "GET").then(resp => {
						if (PICTAL.State != "loading" || target != PICTAL.TargetedElement) return;
						const body = resp.body;

						if (!body) {
							console.error(`${url} returned without a body.`);
							PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
							return;
						}


						const files = runParseJavascript(body, passthrough);

						if (files?.loop) {
							return recursiveRequest(files.loop, files?.passthrough);
						}

						if (!files?.length || typeof files != "object") {
							console.error("[link_parse_javascript]:", "The returned object is not an array.");
							PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
							return;
						}

						return files;
					}).then(r => r);
				}

				function handleFiles(files) {
					PICTAL.Files = files;

					if (!PICTAL.Files?.length) {
						console.error("Empty files");
						PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
						return;
					}

					PICTAL.LOADER.style.backgroundColor = "rgb(222, 255, 205)";
					loadPreviewFiles(fullURL);
				}

				if (!sieve.link_parse_javascript) {
					handleFiles([{
						url: request_url
					}]);
				} else if (!sieve.link_request_javascript) {
					handleFiles(runParseJavascript(""));
				} else {
					recursiveRequest(request_url).then(handleFiles);
				}
			}


			if (targetURL[0] == "image") {
				let links = [fullURL];
				const image_regex = new RegExp(sieve.image_regex, "i");
				if (sieve.image_parse_javascript) {
					try {
						var request_url = Function(`'use strict';` + sieve.image_parse_javascript).bind({
							protocol: targetURL[1],
							link: targetURL[2],
							regex: image_regex,
							regex_match: targetURL[2].match(image_regex),
							node: target
						})();
					} catch (error) {
						console.error("[image_parse_javascript]:", error);
						PICTAL.LOADER.style.backgroundColor = "rgb(255, 204, 204)";
						return;
					}

					// construct a url for each # permutation 
					const match = request_url.match(/#([^#]+)#/);
					links = match ? match[1].trim().split(/\s+/).map(ext => request_url.replace(match[0], ext)) : [request_url];
				}

				// if it's a single possible link and we know the filetype then just use it
				const ext = new URL(links[0])?.pathname?.split(".").pop();
				if (links.length == 1 && ext && /^(png|jpe?g|gif|avif|mp[34]|web[mp])$/gi.test(ext)) {
					PICTAL.Files = [{
						url: links[0],
						video: /^(mp[34]|webm)$/gi.test(ext)
					}];
					PICTAL.LOADER.style.backgroundColor = "rgb(222, 255, 205)";
					loadPreviewFiles(fullURL);
					return;
				}

				// look for valid links and figure out the filetype
				for (const l in links) {
					makeRequest(links[l], "HEAD").then(resp => {
						if (resp.status == 200 || resp.status == 206) {
							PICTAL.Files = [{
								url: links[l]
							}];
							if (resp.headers["content-type"].split("/")[0] == "video") {
								PICTAL.Files = [{
									url: links[l],
									video: true
								}];
							}


							const url = new URL(links[l]);
							let filename = url.pathname.split("/").pop();
							if (!filename.includes(".")) {
								switch (resp.headers["content-type"]) {
									case "image/jpg":
									case "image/jpeg":
										filename += ".jpeg";
										break;
									case "image/png":
										filename += ".png";
										break;
									case "image/webp":
										filename += ".webp";
										break;
									case "image/gif":
										filename += ".gif";
										break;
									case "video/mp4":
										filename += ".mp4";
										break;
									case "video/webm":
										filename += ".webm";
										break;
									default:
										break;
								}
							}
							PICTAL.Files[0].filename = filename;

							PICTAL.LOADER.style.backgroundColor = "rgb(222, 255, 205)";
							loadPreviewFiles(fullURL);
						}
					});
				}
			}
		}, PICTAL.Preferences["selection_delay"]);
	}

	function sieveURLs(urls, type, regex) {
		const linkRegex = new RegExp(regex, "i");
		for (const e of urls) {
			if (!protocolRegex.test(e)) continue;
			const [, protocol, url] = e.match(protocolRegex);
			if (linkRegex.test(url)) {
				return [type, protocol, url];
			}
		};
		return null;
	}

	document.addEventListener("mousemove", (e) => {
		PICTAL.MouseX = e.clientX;
		PICTAL.MouseY = e.clientY;

		if (PICTAL.State == "loading") {
			updateLoader();
		}

		if (PICTAL.State == "selecting") {
			setupTimer(PICTAL.HoverTimerVars.sieve, PICTAL.HoverTimerVars.target, PICTAL.HoverTimerVars.targetURL);
		}
	});

	// select elements to parse and preview
	document.addEventListener("mouseover", (e) => {
		if (PICTAL.Preferences && ((PICTAL.Preferences["hold_to_activate"] == "disabled" && PICTAL.isHoldingActivateKey) || (PICTAL.Preferences["hold_to_activate"] == "enabled" && !PICTAL.isHoldingActivateKey))) return;
		if (PICTAL.TargetedElement || PICTAL.State != "idle") return;

		const target = e.target;
		if (target == document.documentElement || target == document.body || target == document.header) return;
		if (target.children.length > 5) return;

		let elements = new Set();

		// find closest elements in ancestors
		elements.add(target.closest("a"));
		elements.add(target.closest("img"));
		elements.add(target.closest("video"));
		elements.add(target.closest("article"));
		elements.add(target.closest("source"));

		let parent = target;
		const targetRects = target.getClientRects()[0];
		for (let i = 0; i < 5; i++) {
			if (parent == document.body) break;

			let imgEls = parent.getElementsByTagName("img");
			if (imgEls.length > 1) {
				imgEls = [imgEls[0], imgEls[imgEls.length - 1]]; // just check first and last elements
			}

			for (const el of imgEls) {
				if (elements.has(el)) continue;
				if (!el.offsetWidth || !el.offsetHeight) continue; // if invisible
				const elRects = el.getClientRects()[0];

				// the image you're looking for is usually the size and location of whatever container you've got selected even if it's a cousin of the selected element
				if (Math.abs(elRects.x - targetRects.x) > 5 || Math.abs(elRects.y - targetRects.y) > 5) continue;
				if (Math.abs(elRects.width - targetRects.width) > 20 || Math.abs(elRects.height - targetRects.height) > 20) continue;

				elements.add(el);
			};

			parent = parent.parentNode;
		}
		if (elements.size == 1 && elements.has(null)) return;

		// look for urls in all element candidates
		const urls = new Set();
		elements.forEach(el => {
			if (!el) return;
			if (el.href && !el.href.startsWith("javascript:")) urls.add(el.href);
			if (el.src) urls.add(el.src);
			if (el.srcset) urls.add(el.srcset.split(",")[0]); // steam pfps
			if (el.hasAttribute("data-file-url")) urls.add(el.getAttribute("data-file-url"));
			if (el.hasAttribute("data-source")) urls.add(el.getAttribute("data-source"));
		});
		if (urls.size == 1 && urls.has(null)) return;

		// look for link regex and image regex matches and use the first match
		let sieve = null;
		let targetURL = null;
		for (const s in PICTAL.Sieves) {
			if (!PICTAL.Sieves[s].enabled) continue;

			if (PICTAL.Sieves[s].prioritize_images) {
				if (PICTAL.Sieves[s].image_regex) {
					targetURL = sieveURLs(urls, "image", PICTAL.Sieves[s].image_regex);
				}
				if (!targetURL && PICTAL.Sieves[s].link_regex) {
					targetURL = sieveURLs(urls, "link", PICTAL.Sieves[s].link_regex);
				}
			} else {
				if (PICTAL.Sieves[s].link_regex) {
					targetURL = sieveURLs(urls, "link", PICTAL.Sieves[s].link_regex);
				}
				if (!targetURL && PICTAL.Sieves[s].image_regex) {
					targetURL = sieveURLs(urls, "image", PICTAL.Sieves[s].image_regex);
				}
			}

			if (targetURL) {
				sieve = PICTAL.Sieves[s];
				break;
			}
		}
		if (!targetURL) return;
		targetURL[1] = targetURL[1] || ""; // "data:" urls don't have a protocol


		if (targetURL) {
			PICTAL.TargetedElement = target;
			PICTAL.TargetedElement.title = ""; // hide tooltips that would interfere with the preview window
			PICTAL.State = "selecting";

			updateOutline();

			setupTimer(sieve, target, targetURL);
		}
	});

	function updateOutline() {
		if (!PICTAL.TargetedElement) return;

		const rect = PICTAL.TargetedElement.getBoundingClientRect();
		Object.assign(PICTAL.OUTLINE.style, {
			position: "fixed",
			top: rect.top + "px",
			left: rect.left + "px",
			width: rect.width + "px",
			height: rect.height + "px"
		});
		PICTAL.OUTLINE.style.display = "block";
		PICTAL.OUTLINE.style.opacity = "1";
	}
	window.addEventListener("resize", updateOutline);
	window.addEventListener("scroll", updateOutline, true);

	function renderFrame() {
		if (PICTAL.State == "idle" || PICTAL.State == "selecting") return;

		// hide preview when switching between files in a gallery
		if (PICTAL.State == "loading") {
			PICTAL.DIV.style.opacity = "0";
			updateLoader();
			requestAnimationFrame(renderFrame);
			return;
		}

		// get actual image resolution
		if (PICTAL.Files[PICTAL.FileIndex].video) {
			if (PICTAL.Files[PICTAL.FileIndex].videojs) {
				if (!PICTAL.VIDEOJSQUALITY.qlInternal.length) {
					requestAnimationFrame(renderFrame);
					return;
				}
				const res = PICTAL.VIDEOJSQUALITY.qlInternal[PICTAL.VIDEOJSQUALITY.qlInternal.selectedIndex];
				var elHeight = res.height;
				var elWidth = res.width;
			} else {
				var elHeight = PICTAL.VIDEO.videoHeight;
				var elWidth = PICTAL.VIDEO.videoWidth;
			}
		} else {
			var elHeight = PICTAL.IMG.naturalHeight;
			var elWidth = PICTAL.IMG.naturalWidth;
		}
		elHeight = Math.floor(elHeight);
		elWidth = Math.floor(elWidth);


		// bounds of the page
		const minHeight = 15;
		const maxHeight = document.documentElement.clientHeight - minHeight - 15;
		const maxWidth = document.documentElement.clientWidth;


		let scale = Math.min(maxWidth / elWidth, maxHeight / elHeight);
		if (Math.abs(PICTAL.Rotation % 180) != 0) {
			scale = Math.min(maxHeight / elWidth, maxWidth / elHeight);
		}
		scale = Math.min(scale, 1); // don't exceed original resolution

		if (!PICTAL.Center) {
			const height = elHeight * scale;
			const width = elWidth * scale;
			// image container size
			PICTAL.DIV.style.height = `${height}px`;
			PICTAL.DIV.style.width = `${width}px`;

			let left = PICTAL.MouseX;
			let top = PICTAL.MouseY;

			// re-fit and re-place horizontally rotated images
			if (PICTAL.Rotation % 180 != 0) {
				let diff = (height - width) / 2;

				if (PICTAL.MouseY < maxHeight / 2) { // top half of page
					top = top - diff;
					top = clamp(top, -diff, maxHeight - height + diff + 10);
				} else { // bottom half of page
					top = top - height + diff;
					top = clamp(top, -diff + 10, maxHeight - height + diff + 20) - 10;
				}

				left = (PICTAL.MouseX < maxWidth / 2) ? left + diff : left - width - diff - 20; // left and right half of page
				left = clamp(left, diff, maxWidth - height + diff - 10);
			} else {
				left = (PICTAL.MouseX < maxWidth / 2) ? left : left - width - 20;
				left = clamp(left, 0, maxWidth - width - 10);

				top = (PICTAL.MouseY < maxHeight / 2) ? top : top - height;
				top = clamp(top, minHeight, maxHeight - height);
			}

			PICTAL.DIV.style.top = `${top}px`;
			PICTAL.DIV.style.left = `${left}px`;
			PICTAL.LOADER.style.top = `${PICTAL.MouseY - 50}px`;
			PICTAL.LOADER.style.left = `${PICTAL.MouseX}px`;

		} else {
			let height = elHeight;
			let width = elWidth;

			if (PICTAL.ViewMode == "fit_to_width") {
				PICTAL.CenterZoom = (PICTAL.Rotation % 180 == 0) ? (maxWidth / width) : (maxWidth / height);
				PICTAL.ViewMode = "natural_size";
			} else if (PICTAL.ViewMode == "fit_to_height") {
				PICTAL.CenterZoom = (PICTAL.Rotation % 180 == 0) ? (maxHeight / height) : (maxHeight / width);
				PICTAL.ViewMode = "natural_size";
			}

			if (PICTAL.ViewMode == "default" || PICTAL.ViewMode == "auto_fit") {
				height *= PICTAL.CenterZoom * scale;
				width *= PICTAL.CenterZoom * scale;
			} else if (PICTAL.ViewMode == "natural_size") {
				height *= PICTAL.CenterZoom;
				width *= PICTAL.CenterZoom;
			}

			PICTAL.DIV.style.height = `${height}px`;
			PICTAL.DIV.style.width = `${width}px`;

			PICTAL.LOADER.style.top = `${(maxHeight / 2)}px`;
			PICTAL.LOADER.style.left = `${(maxWidth / 2)}px`;


			const side_spacing = (PICTAL.CenterZoom > 1 ? 40 : 0);
			height += side_spacing;
			width += side_spacing * 2;

			if (height > maxHeight) { // vertical zoom pan with mouse
				PICTAL.DIV.style.top = side_spacing + (-(PICTAL.MouseY / maxHeight) * (height - maxHeight)) + "px";
			} else {
				PICTAL.DIV.style.top = side_spacing + ((maxHeight - height) / 2) + minHeight + "px";
			}

			if (width > maxWidth) { // horizontal zoom pan with mouse
				PICTAL.DIV.style.left = side_spacing + (-(PICTAL.MouseX / maxWidth) * (width - maxWidth)) + "px";
			} else {
				PICTAL.DIV.style.left = side_spacing + ((maxWidth - width) / 2) + "px";
			}
		}

		if (PICTAL.Files.length > 1) {
			PICTAL.PAGINATOR.style.display = "inline-block";
			PICTAL.PAGINATOR.innerText = `${PICTAL.FileIndex+1} / ${PICTAL.Files.length}`;
		} else {
			PICTAL.PAGINATOR.style.display = "none";
		}
		if (PICTAL.Preferences["show_resolution"]) {
			PICTAL.RESOLUTION.style.display = "inline-block";
			PICTAL.RESOLUTION.innerText = `${elWidth}x${elHeight}`;
			PICTAL.RESOLUTION.style.marginLeft = (PICTAL.Files.length > 1 ? "4px" : "0px");
		} else {
			PICTAL.RESOLUTION.style.display = "none";
		}
		if (PICTAL.Files[PICTAL.FileIndex].caption && PICTAL.Preferences["show_caption"]) {
			PICTAL.CAPTION.style.display = "inline";
			PICTAL.CAPTION.innerText = PICTAL.Files[PICTAL.FileIndex].caption.replace(/[\n\r]+/g, " ");
			PICTAL.CAPTION.style.marginLeft = ((PICTAL.Files.length > 1 || PICTAL.Preferences["show_resolution"]) ? "4px" : "0px");
		} else {
			PICTAL.CAPTION.innerText = "";
			PICTAL.CAPTION.style.display = "none";
		}

		requestAnimationFrame(renderFrame);
	}

	// stop everything and reset to initial conditions
	function reset() {
		if (PICTAL.HoverTimer) {
			clearTimeout(PICTAL.HoverTimer);
			PICTAL.HoverTimer = null;
		}

		PICTAL.OUTLINE.style.opacity = "0";
		PICTAL.LOADER.style.opacity = "0";
		PICTAL.LOADER.style.backgroundColor = "rgb(255, 255, 255)";
		PICTAL.CenterZoom = .75;
		PICTAL.Center = false;
		PICTAL.TargetedElement = null;
		PICTAL.State = "idle";
		PICTAL.Files = [];
		PICTAL.FileIndex = 0;
		PICTAL.Scale = [1, 1];
		PICTAL.Rotation = 0;
		PICTAL.ViewMode = "default";

		if (!PICTAL.DIV) return;

		PICTAL.DIV.style.pointerEvents = "none";
		PICTAL.DIV.style.opacity = "0";
		PICTAL.DIV.style.transform = `rotate(${PICTAL.Rotation}deg)`;
		PICTAL.IMG.style.display = "none";
		PICTAL.IMG.removeAttribute("src");
		PICTAL.IMG.style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
		clearInterval(PICTAL.IMGTIMER);
		PICTAL.VIDEO.pause();
		PICTAL.VIDEO.removeAttribute("src");
		PICTAL.VIDEO.style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
		PICTAL.VIDEOJS?.reset();
	}

	document.addEventListener("mouseout", (e) => {
		if (PICTAL.State != "idle" && !PICTAL.Center) reset();
	});

	document.addEventListener("blur", () => {
		PICTAL.isHoldingActivateKey = false;
	});

	window.addEventListener("keyup", (e) => {
		if (e.key == PICTAL.Preferences["hold_to_activate_trigger"]) {
			PICTAL.isHoldingActivateKey = false;
		}
	}, {
		capture: true,
		passive: false
	});

	window.addEventListener("keydown", (e) => {
		if (e.key == PICTAL.Preferences["hold_to_activate_trigger"]) {
			PICTAL.isHoldingActivateKey = true;
		}

		if (PICTAL.State == "idle") return;
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();

		const file = PICTAL.Files[PICTAL.FileIndex];

		if (!e.ctrlKey && !e.shiftKey) {
			if (e.key == "Escape" || e.key == PICTAL.Preferences["hold_to_activate_trigger"]) reset();

			if ((e.key == PICTAL.Shortcuts.zoom_in || e.key == PICTAL.Shortcuts.natural_size || e.key == PICTAL.Shortcuts.auto_fit || e.key == PICTAL.Shortcuts.fit_to_width || e.key == PICTAL.Shortcuts.fit_to_height || e.key == "Enter" || e.key == "NumpadEnter") && (PICTAL.State == "loading" || PICTAL.State == "preview")) {
				if (e.key != PICTAL.Shortcuts.zoom_in && e.key != "Enter" && e.key != "NumpadEnter") {
					PICTAL.Center = true;
					PICTAL.CenterZoom = 1;
				}

				switch (e.key) {
					case PICTAL.Shortcuts.natural_size:
						PICTAL.ViewMode = "natural_size";
						break;
					case PICTAL.Shortcuts.auto_fit:
						PICTAL.CenterZoom = 1;
						PICTAL.ViewMode = "auto_fit";
						break;
					case PICTAL.Shortcuts.fit_to_width:
						PICTAL.ViewMode = "fit_to_width";
						break;
					case PICTAL.Shortcuts.fit_to_height:
						PICTAL.ViewMode = "fit_to_height";
						break;
					default:
						PICTAL.Center = !PICTAL.Center;
						PICTAL.CenterZoom = .75;
				}

				PICTAL.DIV.style.pointerEvents = PICTAL.Center ? "initial" : "none";
				updateLoader();
			}

			if (PICTAL.State != "preview") return;

			if (e.key == PICTAL.Shortcuts.open_image_in_new_tab) {
				window.open(file.url, "_blank");
			}

			if (e.key == PICTAL.Shortcuts.wrap_caption) {
				if (PICTAL.HEADER.style.whiteSpace == "nowrap") {
					PICTAL.HEADER.style.whiteSpace = "pre-line";
				} else {
					PICTAL.HEADER.style.whiteSpace = "nowrap";
				}
			}

			if (e.key == PICTAL.Shortcuts.open_options) {
				chrome.runtime.sendMessage({
					type: "OpenOptions"
				});
			}

			if (e.key == PICTAL.Shortcuts.flip_vertical || e.key == PICTAL.Shortcuts.flip_horizontal) {
				let i = Number(e.key == PICTAL.Shortcuts.flip_vertical);
				PICTAL.Scale[i] = -1 * PICTAL.Scale[i];
				if (file.video) {
					if (file.videojs) {
						PICTAL.VIDEOJS.el().style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
					} else {
						PICTAL.VIDEO.style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
					}
				} else {
					PICTAL.IMG.style.transform = `scale(${PICTAL. Scale[0]}, ${PICTAL.Scale[1]})`;
				}
			}

			if (e.key == PICTAL.Shortcuts.rotate_left || e.key == PICTAL.Shortcuts.rotate_right) {
				PICTAL.Rotation += (e.key == PICTAL.Shortcuts.rotate_right ? 90 : -90);
				PICTAL.DIV.style.transform = `rotate(${PICTAL.Rotation}deg)`;
				PICTAL.HEADER.style.opacity = PICTAL.Rotation % 360 ? 0 : 1;
			}

			if (PICTAL.Files.length > 1) {
				if (e.key == "Home" || e.key == "End") {
					PICTAL.FileIndex = (e.key == "Home" ? 0 : PICTAL.Files.length - 1);
					loadPreviewFiles();
				}
			}

			if (file.video) {
				if (e.key == "ArrowUp" || e.key == "ArrowDown") {
					if (e.key == "ArrowUp") {
						if (PICTAL.VIDEO.muted) {
							PICTAL.VIDEO.muted = false;
							PICTAL.VIDEO.volume = 0;
							if (file.videojs) PICTAL.VIDEOJS.muted(false);
						}
					}
					PICTAL.VIDEO.volume = clamp(PICTAL.VIDEO.volume + (e.key == "ArrowUp" ? .05 : -.05), 0, 1);
					if (file.videojs) PICTAL.VIDEOJS.volume(PICTAL.VIDEO.volume);
					PICTAL.Volume = PICTAL.VIDEO.volume;
				}

				if (e.key == "PageUp" || e.key == "PageDown") {
					let time = (e.key == "PageUp" ? 1 : -1) * .04;
					if (file.videojs) {
						PICTAL.VIDEOJS.pause();
						PICTAL.VIDEOJS.currentTime(PICTAL.VIDEOJS.currentTime() + time);
					} else {
						PICTAL.VIDEO.pause();
						PICTAL.VIDEO.currentTime += time;
					}
				}

				if (e.key == "m") {
					PICTAL.VIDEO.muted = !PICTAL.VIDEO.muted;
					PICTAL.Muted = PICTAL.VIDEO.muted;
					if (file.videojs) PICTAL.VIDEOJS.muted(PICTAL.VIDEO.muted);
				}
			}
		}

		if (PICTAL.State != "preview") return;

		if (e.ctrlKey && e.key == "c") {
			navigator.clipboard.writeText(file.url);
		}

		const step_forward = (e.key == "ArrowRight" || (!e.shiftKey && e.key == " ") || e.key == "PageDown");
		const step_backward = (e.key == "ArrowLeft" || (e.shiftKey && e.key == " ") || e.key == "PageUp");
		if ((step_forward || step_backward) && PICTAL.Files.length > 1) {
			PICTAL.FileIndex = clamp(PICTAL.FileIndex + ((step_forward ? 1 : -1) * ((e.shiftKey && e.key != " ") ? 5 : 1)), 0, PICTAL.Files.length - 1);
			loadPreviewFiles();
		}

		if (!e.shiftKey && file.video) {
			if (e.key == " " && (PICTAL.Files.length == 1 || e.ctrlKey)) {
				PICTAL.VIDEO.paused ? PICTAL.VIDEO.play() : PICTAL.VIDEO.pause();
				if (file.videojs) PICTAL.VIDEOJS.paused() ? PICTAL.VIDEOJS.play() : PICTAL.VIDEOJS.pause();
			}
		}

		if (file.video) {
			if ((e.key == "ArrowLeft" || e.key == "ArrowRight") && (PICTAL.Files.length == 1 || e.ctrlKey)) {
				const time = (e.key == "ArrowRight" ? 5 : -5) * (e.shiftKey ? 3 : 1);
				if (file.videojs) {
					PICTAL.VIDEOJS.currentTime(PICTAL.VIDEOJS.currentTime() + time);
				} else {
					PICTAL.VIDEO.currentTime += time;
				}
			}
		}

		if (!e.ctrlKey && e.shiftKey && e.key == " " && file.video) {
			if (file.videojs) {
				PICTAL.VIDEOJS.controls(!PICTAL.VIDEOJS.controls());
			} else {
				PICTAL.VIDEO.controls = !PICTAL.VIDEO.controls;
			}
		}

		if (e.ctrlKey && e.key == "s") {
			let filename = file.filename;
			if (!filename) {
				let url = new URL(file.url);
				filename = url.pathname.split("/").pop();
			}

			// try to download through chrome.downloads.download with just the url
			chrome.runtime.sendMessage({
				type: "Download",
				url: file.url,
				filename: filename
			}, (resp) => {
				if (resp.ok == false) {
					// have to window.open, chrome.tabs.create doesn't work for all cases
					if (platform == "chrome") {
						// chrome.downloads.download returns immediately in chrome so we can't use a separate window because the download window is also closed upon window.close
						window.open(file.url + "#PICTALFILENAME=" + filename, "_blank");
					} else {
						// window.open forces focus on new tab/window and a new window is less annoying than a new tab
						window.open(file.url + "#PICTALFILENAME=" + filename, "_blank", "width=500,height=1,resizable=yes");
					}
				}
			});
		}
	}, {
		capture: true,
		passive: false
	});

	document.addEventListener("mousedown", (e) => {
		if (PICTAL.State != "preview") return;
		e.preventDefault();

		if (e.buttons == 1 && !PICTAL.DIV.contains(e.target)) reset();
	});

	document.addEventListener("wheel", (e) => {
		if (PICTAL.State == "idle" || PICTAL.State == "selecting") return;
		if (PICTAL.State == "loading" || PICTAL.Center) e.preventDefault();

		if (PICTAL.Center && (PICTAL.DIV.contains(e.target) || PICTAL.Files.length == 1)) {
			e.preventDefault();
			if (e.wheelDelta < 0 && PICTAL.CenterZoom > .1) {
				PICTAL.CenterZoom *= .75;
			}
			if (e.wheelDelta > 0 && PICTAL.CenterZoom < 10) {
				PICTAL.CenterZoom *= 1 / .75;
			}
		} else if ((!PICTAL.Center && PICTAL.Files.length > 1) || (PICTAL.Center && !PICTAL.DIV.contains(e.target))) {
			e.preventDefault();
			if (e.wheelDelta < 0) {
				PICTAL.FileIndex = clamp(++PICTAL.FileIndex, 0, PICTAL.Files.length - 1);
			}
			if (e.wheelDelta > 0) {
				PICTAL.FileIndex = clamp(--PICTAL.FileIndex, 0, PICTAL.Files.length - 1);
			}

			loadPreviewFiles();
		}
	}, {
		capture: true,
		passive: false
	});
}