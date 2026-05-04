"use strict";

const protocolRegex = new RegExp(/^(?:(https?:\/\/(?:www\.)?))?(.*)$/i);

chrome.runtime.sendMessage({
	type: "GetSiteFilters"
}, (response) => {
	let [, , url] = window.location.href.match(protocolRegex);

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


// backup file downloader that bypasses CORS and referer requirements
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

		makeRequest("GET", link, true).then(resp => {
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
		PICTAL.Volume = PICTAL.Preferences["default_video_volume"] / 100;
		PICTAL.Muted = PICTAL.Preferences["default_video_muted"];
		reset();
	});
	chrome.runtime.sendMessage({
		type: "GetShortcuts"
	}, (response) => {
		PICTAL.Shortcuts = response.shortcuts;
	});

	// object meant to organize the files and metadata used for the preview
	class URLCache {
		parsedLinkCache = {}; // table of album objects from links already parsed by sieves
		currentURL = null;

		set(url) {
			this.currentURL = url;
		}

		add(url, files) {
			this.parsedLinkCache[url] = {
				files: files,
				index: 0
			};
		}

		getFile() {
			return this.parsedLinkCache[this.currentURL]?.files[this.parsedLinkCache[this.currentURL].index];
		}

		getFiles() {
			return this.parsedLinkCache[this.currentURL]?.files || [];
		}

		contains(url) {
			return this.parsedLinkCache[url] != null;
		}

		incrementIndex() {
			let ind = this.parsedLinkCache[this.currentURL].index + 1;
			if (PICTAL.Preferences["cyclical_albums"] && ind == this.parsedLinkCache[this.currentURL].files.length) {
				ind = 0;
			}
			this.parsedLinkCache[this.currentURL].index = Math.min(ind, this.parsedLinkCache[this.currentURL].files.length - 1);
		}

		decrementIndex() {
			let ind = this.parsedLinkCache[this.currentURL].index - 1;
			if (PICTAL.Preferences["cyclical_albums"] && ind == -1) {
				ind = this.parsedLinkCache[this.currentURL].files.length - 1;
			}
			this.parsedLinkCache[this.currentURL].index = Math.max(ind, 0);
		}

		setIndex(ind) {
			this.parsedLinkCache[this.currentURL].index = ind;
		}

		getIndex() {
			return this.parsedLinkCache[this.currentURL].index;
		}
	}
	const HoveredLinks = new URLCache();

	const PICTAL = {
		State: "idle",
		isHoldingActivateKey: false,
		MouseX: 0,
		MouseY: 0,
		Scale: [1, 1],
		Rotation: 0,
		HoverTimer: null,
	}

	const COLORS = {
		WHITE: "rgb(255, 255, 255)",
		GREEN: "rgb(222, 255, 205)",
		RED: "rgb(255, 204, 204)"
	}

	function setupVideoJS() {
		if (PICTAL.VIDEOJS) return;

		const vid = PICTAL.VIDEO.cloneNode();
		vid.className = "video-js vjs-default-skin";
		vid.style.display = "block";
		PICTAL.DIV.appendChild(vid);

		PICTAL.VIDEOJS = videojs(vid, {
			html5: {
				vhs: {
					limitRenditionByPlayerDimensions: false // videojs will set quality based on player size by default so disable it
				}
			}
		});
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
		PICTAL.VIDEOJS.on("volumechange", PICTAL.VIDEO.onvolumechange);
		PICTAL.VIDEOJS.on("error", () => {
			PICTAL.LOADER.style.backgroundColor = COLORS.RED;
		});
	}

	function clamp(number, min, max) {
		return Math.max(min, Math.min(number, max));
	}

	function createPreviewElements() {
		if (PICTAL.DIV?.parentNode) return;

		PICTAL.DIV = document.createElement("div");
		PICTAL.DIV.style.cssText = `
			position: fixed !important;
			display: none;
			padding: 0px;
			margin: 3px;
			background: rgb(255, 255, 255) padding-box;
			box-shadow: rgb(102, 102, 102) 0px 0px 2px;
			border: 3px solid rgba(242, 242, 242, 0.6);
			border-radius: 2px;
			z-index: 2147483646;
			width: 0;
			height: 0;
			inset: 0;
			pointer-events: none;
		`;
		document.documentElement.appendChild(PICTAL.DIV);

		PICTAL.IMG = document.createElement("img");
		PICTAL.IMG.alt = "";
		PICTAL.IMG.style.cssText = `
			display: none;
			width: 100%;
			height: 100%;
		`;
		PICTAL.IMG.onload = function(e) {
			if (PICTAL.State == "loading" && e.target.src == HoveredLinks.getFile().url) {
				PICTAL.IMG.style.display = "initial";
				fileLoaded();
				updateDIV();
			}

			for (let i = HoveredLinks.getIndex(); i <= HoveredLinks.getIndex() + Number(PICTAL.Preferences["images_preloaded_ahead"]); i++) {
				const file = HoveredLinks.getFiles()[i];
				if (!file) break;
				if (file.video) continue;
				new Image().src = file.url;
			}
		};
		PICTAL.IMG.onerror = function(e) {
			if (e.target.src != HoveredLinks.getFile().url) return;
			clearInterval(PICTAL.IMGTimer);
			PICTAL.DIV.style.display = "none";
			updateLoader(); // cached links don't show a loader so show one if a cached link doesn't work
			PICTAL.LOADER.style.backgroundColor = COLORS.RED;
		};
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

			if (HoveredLinks.getFile().videojs) {
				PICTAL.VIDEOJS.el().style.display = "inherit";
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
				PICTAL.VIDEO.style.display = "initial";
				PICTAL.VIDEO.volume = PICTAL.Volume;
				PICTAL.VIDEO.play().catch(() => {
					PICTAL.VIDEO.muted = true;
					PICTAL.Muted = true;
					PICTAL.VIDEO.play();
				});
			}

			fileLoaded();
			updateDIV();
		};
		PICTAL.VIDEO.onerror = function(e) {
			if (e.target.src != HoveredLinks.getFile().url) return;
			PICTAL.DIV.style.display = "none";
			updateLoader();
			PICTAL.LOADER.style.backgroundColor = COLORS.RED;
		};
		PICTAL.VIDEO.onvolumechange = function(e) {
			if (PICTAL.State != "preview") return;
			if (e.target.localName == "video") {
				PICTAL.Volume = PICTAL.VIDEO.volume;
				PICTAL.Muted = PICTAL.VIDEO.muted;
			} else {
				PICTAL.Volume = PICTAL.VIDEOJS.volume();
				PICTAL.Muted = PICTAL.VIDEOJS.muted();
			}
		};
		PICTAL.DIV.appendChild(PICTAL.VIDEO);

		PICTAL.HEADER = document.createElement("div");
		PICTAL.HEADER.style.cssText = `
			position: absolute;
			padding: 2px;
			box-shadow: rgb(221, 221, 221) 0px 0px 1px inset;
			background: rgba(0, 0, 0, 0.75) !important;
			border-radius: 3px;
			white-space: ${PICTAL.Preferences["wrap_caption"] || "nowrap"};
			color: rgb(255, 255, 255) !important;
			font: 13px/1.4em "Trebuchet MS", sans-serif;
		`;
		PICTAL.DIV.appendChild(PICTAL.HEADER);

		PICTAL.PAGINATOR = document.createElement("b");
		PICTAL.PAGINATOR.style.cssText = `
			display: inline-block;
			padding: 0px 2px;
			border-radius: 3px;
			color: rgb(0, 0, 0);
			background-color: rgb(255, 255, 0);
		`;
		PICTAL.HEADER.appendChild(PICTAL.PAGINATOR);

		PICTAL.RESOLUTION = document.createElement("b");
		PICTAL.RESOLUTION.style.cssText = `
			display: inline-block;
			color: rgb(120, 210, 255);
		`;
		PICTAL.HEADER.appendChild(PICTAL.RESOLUTION);

		PICTAL.CAPTION = document.createElement("span");
		PICTAL.CAPTION.style.cssText = `
			display: inline;
			color: inherit;
		`;
		PICTAL.HEADER.appendChild(PICTAL.CAPTION);
	}

	function createOutline() {
		if (PICTAL.OUTLINE?.parentNode) return;

		PICTAL.OUTLINE = document.createElement("div");
		PICTAL.OUTLINE.style.cssText = `
			position: fixed;
			box-sizing: content-box;
			outline: red dashed 1.5px;
			z-index: 2147483645;
			opacity: 0;
			padding: 0;
			margin: 0;
			pointer-events: none;
		`;
		document.documentElement.appendChild(PICTAL.OUTLINE);
	}
	createOutline();

	function createLoader() {
		if (PICTAL.LOADER?.parentNode) return;

		PICTAL.LOADER = document.createElement("img");
		PICTAL.LOADER.style.cssText = `
			position: fixed !important;
			display: none;
			padding: 5px;
			border-radius: 50% !important;
			box-shadow: 0px 0px 5px 1px #a6a6a6 !important;
			background-color: rgb(255, 255, 255);
			background-clip: padding-box;
			z-index: 2147483647;
			width: 28px;
			height: 28px;
			inset: 0;
			margin: 0;
			pointer-events: none;
			box-sizing: initial;
		`;
		PICTAL.LOADER.src = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOng9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZpZXdCb3g9IjAgMCAxMDAgMTAwIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJ4TWluWU1pbiBub25lIj48Zz48cGF0aCBpZD0icCIgZD0iTTMzIDQyYTEgMSAwIDAgMSA1NS0yMCAzNiAzNiAwIDAgMC01NSAyMCIvPjx1c2UgeDpocmVmPSIjcCIgdHJhbnNmb3JtPSJyb3RhdGUoNzIgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgxNDQgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgyMTYgNTAgNTApIi8+PHVzZSB4OmhyZWY9IiNwIiB0cmFuc2Zvcm09InJvdGF0ZSgyODggNTAgNTApIi8+PGFuaW1hdGVUcmFuc2Zvcm0gYXR0cmlidXRlTmFtZT0idHJhbnNmb3JtIiB0eXBlPSJyb3RhdGUiIHZhbHVlcz0iMzYwIDUwIDUwOzAgNTAgNTAiIGR1cj0iMS44cyIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiLz48L2c+PC9zdmc+";
		document.documentElement.appendChild(PICTAL.LOADER);
	}
	createLoader();

	function updateLoader(show = true) {
		if (PICTAL.State != "loading") return;

		const headerSize = (PICTAL.Rotation % 360 == 0 && PICTAL.HEADER.style.display != "none") ? 25 : 0; // header isn't visible when rotated so don't add extra space
		const divBorderSize = 12; // image resolution doesn't reflect the size of the div due to the border so account for the space the border takes up
		const maxHeight = document.documentElement.clientHeight - headerSize - divBorderSize;
		const maxWidth = document.documentElement.clientWidth - divBorderSize;

		if (show) PICTAL.LOADER.style.display = "initial";
		if (PICTAL.Center && !PICTAL.Preferences["always_full_zoom"]) {
			PICTAL.LOADER.style.top = `${(maxHeight / 2)}px`;
			PICTAL.LOADER.style.left = `${(maxWidth / 2)}px`;
		} else {
			const offset = Number(PICTAL.Preferences["loader_offset"]);
			const loaderOffset = 38 / 2;
			const x = PICTAL.MouseX - loaderOffset;
			const y = PICTAL.MouseY - loaderOffset;

			if (PICTAL.MouseX < maxWidth / 2) {
				PICTAL.LOADER.style.left = `${x + offset}px`;
			} else {
				PICTAL.LOADER.style.left = `${x - offset}px`;
			}
			if (PICTAL.MouseY < maxHeight / 2) {
				PICTAL.LOADER.style.top = `${y + offset + 20}px`;
			} else {
				PICTAL.LOADER.style.top = `${y - offset}px`;
			}
		}
	}

	function getResolution() {
		let elHeight, elWidth;
		const file = HoveredLinks.getFile();
		if (!file) return [null, null];

		if (file.video) {
			if (file.videojs) {
				elHeight = PICTAL.VIDEOJS.videoHeight();
				elWidth = PICTAL.VIDEOJS.videoWidth();
			} else {
				elHeight = PICTAL.VIDEO.videoHeight;
				elWidth = PICTAL.VIDEO.videoWidth;
			}
		} else {
			elHeight = PICTAL.IMG.naturalHeight;
			elWidth = PICTAL.IMG.naturalWidth;
		}
		elHeight = Math.floor(elHeight);
		elWidth = Math.floor(elWidth);

		return [elWidth, elHeight];
	}

	function fileLoaded(elWidth = null, elHeight = null) {
		const file = HoveredLinks.getFile();
		const albumSize = HoveredLinks.getFiles().length;

		clearInterval(PICTAL.LoaderTimer);

		PICTAL.ViewMode = PICTAL.Preferences["default_zoom_mode"];

		PICTAL.State = "preview";

		PICTAL.LOADER.style.display = "none";
		PICTAL.DIV.style.display = "initial";
		PICTAL.DIV.style.pointerEvents = PICTAL.Center ? "initial" : "none";

		PICTAL.HEADER.style.display = ((albumSize > 1 || file.caption || PICTAL.Preferences["show_resolution"]) && PICTAL.Rotation % 360 == 0) ? "block" : "none";
		if (albumSize > 1) {
			PICTAL.PAGINATOR.style.display = "initial";
			PICTAL.PAGINATOR.innerText = `${HoveredLinks.getIndex()+1} / ${albumSize}`;
		} else {
			PICTAL.PAGINATOR.style.display = "none";
		}
		if (PICTAL.Preferences["show_resolution"]) {
			if (!elWidth)[elWidth, elHeight] = getResolution();
			PICTAL.RESOLUTION.style.display = "initial";
			PICTAL.RESOLUTION.innerText = `${elWidth}x${elHeight}`;
			PICTAL.RESOLUTION.style.marginLeft = (albumSize > 1 ? "4px" : "0px");
		} else {
			PICTAL.RESOLUTION.style.display = "none";
		}
		if (file.caption && PICTAL.Preferences["show_caption"]) {
			PICTAL.CAPTION.style.display = "initial";
			PICTAL.CAPTION.innerText = file.caption.replace(/[\n\r]+/g, " ");
			PICTAL.CAPTION.style.marginLeft = ((albumSize > 1 || PICTAL.Preferences["show_resolution"]) ? "4px" : "0px");
		} else {
			PICTAL.CAPTION.style.display = "none";
		}
	}

	let LastFilePreviewed = null;

	function loadPreviewFile() {
		if (PICTAL.State == "idle") return;

		const file = HoveredLinks.getFile();
		if (file && LastFilePreviewed?.url == file.url) return;

		PICTAL.State = "loading";
		PICTAL.LOADER.style.backgroundColor = COLORS.GREEN;

		clearInterval(PICTAL.IMGTimer);

		if (PICTAL.VIDEOJS) PICTAL.VIDEOJS.el().style.display = "none";
		PICTAL.VIDEOJS?.dispose(); // resetting or changing src is way too slow so just delete and recreate the object
		PICTAL.VIDEOJS = null;

		if ((LastFilePreviewed?.video && !file.video) || (!LastFilePreviewed?.video && file.video)) PICTAL.DIV.style.display = "none"; // hide white flash from the DIV due to VIDEO and IMG being invisible during changes from video to image and vice versa
		LastFilePreviewed = file;

		// if it takes longer than 100ms to load the next file then hide and show loader
		PICTAL.LoaderTimer = setTimeout(() => {
			if (PICTAL.State != "loading") return;
			PICTAL.DIV.style.display = "none";
			PICTAL.IMG.style.display = "none";
			PICTAL.VIDEO.style.display = "none";
			PICTAL.VIDEO.pause();
			updateLoader();
		}, 100);

		if (file.video) {
			if (file.videojs) {
				setupVideoJS();
				PICTAL.VIDEOJS.src({
					src: file.url
				});
			} else {
				PICTAL.VIDEO.src = file.url;
			}

			PICTAL.DIV.style.display = "none";
			PICTAL.IMG.style.display = "none";
		} else {
			const loader = new Image();
			loader.src = file.url;

			clearInterval(PICTAL.IMGTimer);
			PICTAL.IMGTimer = setInterval(function() { // start displaying the image as it is downloading
				if (loader.naturalWidth) {
					clearInterval(PICTAL.IMGTimer);
					PICTAL.IMG.removeAttribute("src");
					PICTAL.IMG.src = file.url;
					PICTAL.IMG.style.display = "initial";
					fileLoaded(loader.naturalWidth, loader.naturalHeight);
					updateDIV(loader.naturalWidth, loader.naturalHeight);
					loader.src = "";
				}
			}, 1);
			loader.onerror = PICTAL.IMG.onerror;

			PICTAL.VIDEO.style.display = "none";
			PICTAL.VIDEO.pause();
		}
	}

	function updateDIV(elWidth = null, elHeight = null) {
		if (PICTAL.State == "idle" || PICTAL.State == "selecting") return;

		// get actual image resolution
		if (!elWidth)[elWidth, elHeight] = getResolution();
		if (!elWidth || !elHeight) return;

		// bounds of the page
		const headerSize = (PICTAL.Rotation % 360 == 0 && PICTAL.HEADER.style.display != "none") ? 25 : 0; // header isn't visible when rotated so don't add extra space
		const divBorderSize = 12; // image resolution doesn't reflect the size of the div due to the border so account for the space the border takes up
		const maxHeight = window.innerHeight - headerSize - divBorderSize;
		const maxWidth = document.documentElement.clientWidth - divBorderSize;

		const distanceFromCursor = Number(PICTAL.Preferences["distance_from_cursor"]);

		let scale = Math.min(maxWidth / elWidth, maxHeight / elHeight);
		if (Math.abs(PICTAL.Rotation % 180) != 0) {
			scale = Math.min(maxHeight / elWidth, maxWidth / elHeight);
		}
		scale = Math.min(scale, 1); // don't exceed original resolution

		// this is all a giant mess that was figured out through trial and error lol
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

				top = (PICTAL.MouseY < maxHeight / 2) ? top - diff : top - height + diff; // top and bottom half of page
				top = clamp(top, -diff, maxHeight - height + diff);

				left = (PICTAL.MouseX < maxWidth / 2) ? left + diff : left - width - diff; // left and right half of page
				left = clamp(left, diff, maxWidth - height + diff);
			} else {
				if (PICTAL.MouseX < maxWidth / 2) {
					left = Math.min(left + distanceFromCursor, maxWidth - width);
				} else {
					left = Math.max(left - width - divBorderSize - distanceFromCursor, 0);
				}

				const headerSpace = (PICTAL.Preferences["caption_position"] != "bottom") ? headerSize : 0;
				if (PICTAL.MouseY < maxHeight / 2) {
					top = Math.min(top + distanceFromCursor, maxHeight - height + headerSpace);
				} else {
					top = Math.max(top - height - distanceFromCursor, headerSpace);
				}
			}

			PICTAL.DIV.style.top = `${top}px`;
			PICTAL.DIV.style.left = `${left}px`;
			if (PICTAL.Preferences["caption_position"] == "bottom") {
				PICTAL.HEADER.style.top = `${height + 4}px`;
			} else {
				PICTAL.HEADER.style.top = "-26px";
			}
		} else {
			let height = elHeight;
			let width = elWidth;

			if (PICTAL.ViewMode == "fit_to_width") {
				PICTAL.CenterZoom = (PICTAL.Rotation % 180 == 0) ? (maxWidth / width) : (maxWidth / height);
				PICTAL.ViewMode = "";
			} else if (PICTAL.ViewMode == "fit_to_height") {
				PICTAL.CenterZoom = (PICTAL.Rotation % 180 == 0) ? (maxHeight / height) : (maxHeight / width);
				PICTAL.ViewMode = "";
			} else if (PICTAL.ViewMode == "auto_fit") {
				PICTAL.CenterZoom = scale;
				PICTAL.ViewMode = "";
			} else if (PICTAL.ViewMode == "natural_size") {
				PICTAL.CenterZoom = 1;
				PICTAL.ViewMode = "";
			}
			height *= PICTAL.CenterZoom;
			width *= PICTAL.CenterZoom;

			height = Math.floor(height);
			width = Math.floor(width);

			PICTAL.DIV.style.height = `${height}px`;
			PICTAL.DIV.style.width = `${width}px`;

			let topSpace = headerSize;
			if (PICTAL.Preferences["caption_position"] == "bottom") {
				PICTAL.HEADER.style.top = `${height + 4}px`;
				topSpace = 0;
			} else {
				PICTAL.HEADER.style.top = "-26px";
			}

			const edgeSpace = 20; // extra space on all sides when zoomed in
			if (PICTAL.Rotation % 180 != 0) {
				const diff = (height - width) / 2;
				if (width > maxHeight) { // vertical zoom pan with mouse
					height += edgeSpace * 2;
					PICTAL.DIV.style.top = edgeSpace + (Math.min(PICTAL.MouseY / maxHeight, 1) * (maxHeight - height + 2 * diff) - diff) + "px";
				} else {
					PICTAL.DIV.style.top = topSpace + ((maxHeight - height) / 2) + "px";
				}

				if (height > maxWidth) { // horizontal zoom pan with mouse
					PICTAL.DIV.style.left = edgeSpace + (Math.min(PICTAL.MouseX / maxWidth, 1) * (maxWidth - height) + diff) + "px";
				} else {
					PICTAL.DIV.style.left = ((maxWidth - width) / 2) + "px";
				}
			} else {
				if (height > maxHeight) { // vertical zoom pan with mouse
					height += edgeSpace * 2;
					PICTAL.DIV.style.top = topSpace + edgeSpace + (-Math.min(PICTAL.MouseY / maxHeight, 1) * (height - maxHeight)) + "px";
				} else {
					PICTAL.DIV.style.top = topSpace + ((maxHeight - height) / 2) + "px";
				}

				if (width > maxWidth) { // horizontal zoom pan with mouse
					width += edgeSpace * 2;
					PICTAL.DIV.style.left = edgeSpace + (-Math.min(PICTAL.MouseX / maxWidth, 1) * (width - maxWidth)) + "px";
				} else {
					PICTAL.DIV.style.left = ((maxWidth - width) / 2) + "px";
				}
			}
		}
	}

	// stop everything and reset to initial conditions
	function reset() {
		if (PICTAL.HoverTimer) {
			clearTimeout(PICTAL.HoverTimer);
			PICTAL.HoverTimer = null;
		}

		LastFilePreviewed = null;
		PICTAL.OUTLINE.style.opacity = "0";
		PICTAL.LOADER.style.display = "none";
		PICTAL.LOADER.style.backgroundColor = COLORS.WHITE;
		PICTAL.Center = PICTAL.Preferences["always_full_zoom"];
		PICTAL.TargetedElement = null;
		PICTAL.State = "idle";
		PICTAL.Scale = [1, 1];
		PICTAL.Rotation = 0;
		PICTAL.ViewMode = PICTAL.Preferences["default_zoom_mode"];

		if (!PICTAL.DIV) return;

		PICTAL.DIV.style.pointerEvents = "none";
		PICTAL.DIV.style.display = "none";
		PICTAL.DIV.style.transform = `rotate(${PICTAL.Rotation}deg)`;
		PICTAL.IMG.style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
		clearInterval(PICTAL.IMGTimer);
		PICTAL.VIDEO.pause();
		PICTAL.VIDEO.removeAttribute("src");
		PICTAL.VIDEO.style.transform = `scale(${PICTAL.Scale[0]}, ${PICTAL.Scale[1]})`;
		PICTAL.VIDEOJS?.dispose();
		PICTAL.VIDEOJS = null;
	}

	let hoverArgs = [];

	function setupTimer(sieve = null, target = null, targetURL = null) {
		clearTimeout(PICTAL.HoverTimer);

		if (sieve) {
			hoverArgs = [
				sieve,
				target,
				targetURL
			];
		} else if (hoverArgs) {
			[sieve, target, targetURL] = hoverArgs;
		}

		if (PICTAL.Preferences["hold_to_activate"] == "enabled" && !PICTAL.isHoldingActivateKey) return;

		let [sieveType, protocol, link] = targetURL;

		const fullURL = protocol + link;

		let delay = PICTAL.Preferences["selection_delay"];
		if (PICTAL.Preferences["instantly_show_cached"] && HoveredLinks.contains(fullURL)) {
			delay = 0;
		}

		function handleFiles(url, files) {
			if (!files?.length) {
				console.error("[Files Object Check]", "The returned array is empty.");
				PICTAL.LOADER.style.backgroundColor = COLORS.RED;
				return;
			}

			if (new Set(files.map(x => x.url)).size != files.length) {
				console.error("[Files Object Check]", "The returned array contains duplicate urls.");
				PICTAL.LOADER.style.backgroundColor = COLORS.RED;
				return;
			}

			if (files.find(x => !x.url)) {
				console.error("[Files Object Check]", "The returned array contains an empty url.");
				PICTAL.LOADER.style.backgroundColor = COLORS.RED;
				return;
			}

			HoveredLinks.add(url, files);
			if (target != PICTAL.TargetedElement) return;
			HoveredLinks.set(url);
			loadPreviewFile(HoveredLinks.getFile());
		}

		// on timeout, start handling the link and loading the preview media
		PICTAL.HoverTimer = setTimeout(() => {
			PICTAL.State = "loading";
			hoverArgs = [];
			createPreviewElements();

			if (HoveredLinks.contains(fullURL)) {
				PICTAL.LOADER.style.backgroundColor = COLORS.GREEN;
				HoveredLinks.set(fullURL);
				if (!PICTAL.Preferences["keep_cached_album_index"]) HoveredLinks.setIndex(0);
				loadPreviewFile();
				return;
			}

			updateLoader();

			if (PICTAL.Preferences["add_hovered_to_history"]) {
				chrome.runtime.sendMessage({
					type: "AddToHistory",
					url: fullURL
				});
			}

			if (sieveType == "link") {
				const link_regex = new RegExp(sieve.link_regex, "i");

				async function runParseJavascript() {
					try {
						var files = await Function(`'use strict'; return (async () => {${sieve.link_parse_javascript}})();`).bind({
							protocol: protocol,
							link: link,
							regex: link_regex,
							regex_match: link.match(link_regex),
							request: makeRequest,
							node: target
						})();
					} catch (error) {
						console.error("[Link Parse Javascript]", error);
						PICTAL.LOADER.style.backgroundColor = COLORS.RED;
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
				const image_regex = new RegExp(sieve.image_regex, "i");
				if (sieve.image_parse_javascript) {
					try {
						var request_url = Function(`'use strict';` + sieve.image_parse_javascript).bind({
							protocol: protocol,
							link: link,
							regex: image_regex,
							regex_match: link.match(image_regex),
							node: target
						})();
					} catch (error) {
						console.error("[Image Parse Javascript]:", error);
						PICTAL.LOADER.style.backgroundColor = COLORS.RED;
						return;
					}

					if (!request_url) {
						console.error("[Image Parse Javascript]:", "A string was not returned by Image Parse Javascript.");
						PICTAL.LOADER.style.backgroundColor = COLORS.RED;
						return;
					}

					// construct a url for each # permutation 
					const match = request_url.match(/#([^#]+)#/);
					links = match ? match[1].trim().split(/\s+/).map(ext => request_url.replace(match[0], ext)) : [request_url];
				}

				// if it's a single possible link and we know the filetype then just use it
				const ext = new URL(links[0])?.pathname?.split(".").pop();
				if (links.length == 1 && ext && /^(png|jpe?g|gif|avif|mp[34]|web[mp])$/gi.test(ext)) {
					let files = [{
						url: links[0],
						video: /^(mp[34]|webm)$/gi.test(ext)
					}];
					PICTAL.LOADER.style.backgroundColor = COLORS.GREEN;
					handleFiles(fullURL, files);
					return;
				}

				// look for valid links and figure out the filetype
				for (const l in links) {
					makeRequest("HEAD", links[l]).then(resp => {
						if (resp.status == 200 || resp.status == 206) {
							let files = [{
								url: links[l]
							}];
							if (resp.headers["content-type"].split("/")[0] == "video") {
								files = [{
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
							files[0].filename = filename;

							PICTAL.LOADER.style.backgroundColor = COLORS.GREEN;
							handleFiles(fullURL, files);
						}
					});
				}
			}
		}, delay);
	}

	function checkSieveURLs(urls, type, regex, filter_javascript, target) {
		const linkRegex = new RegExp(regex, "i");
		for (const e of urls) {
			if (!protocolRegex.test(e)) continue;
			const [, protocol, url] = e.match(protocolRegex);
			if (linkRegex.test(url)) {
				if (filter_javascript) {
					const pass = Function(`'use strict';` + filter_javascript).bind({
						protocol: protocol,
						link: url,
						regex: linkRegex,
						regex_match: url.match(linkRegex),
						node: target
					})();
					if (pass != true) return null;
				}
				return [type, protocol, url];
			}
		};
		return null;
	}

	document.addEventListener("mousemove", (e) => {
		if (PICTAL.State == "idle") return;

		PICTAL.MouseX = e.clientX;
		PICTAL.MouseY = e.clientY;

		if (PICTAL.State == "loading") {
			updateLoader(false);
		}

		if (PICTAL.State == "selecting" && PICTAL.Preferences["reset_delay_on_mouse_move"]) {
			setupTimer();
		}
		if (PICTAL.State == "preview") {
			const albumSize = HoveredLinks.getFiles().length;
			if (PICTAL.Center && PICTAL.DIV.contains(e.target) && !(isNearSide(e) && albumSize > 1)) {
				PICTAL.IMG.style.cursor = "zoom-in";
				clearTimeout(PICTAL.HideCursorTimer);
				PICTAL.HideCursorTimer = setTimeout(() => {
					PICTAL.IMG.style.cursor = "none";
				}, PICTAL.Preferences["hide_cursor_delay"]);
			} else {
				PICTAL.IMG.style.cursor = "initial";
			}
			updateDIV();
		}
	});

	function getAncestors(el, size) {
		const ancestors = [];
		while (el && ancestors.length < size) {
			if (el != document && el.localName != "html" && el.localName != "header" && el.localName != "body") {
				ancestors.push(el);
			}
			el = el.parentNode;
		}
		return ancestors;
	}

	// select elements to parse and preview
	document.addEventListener("mouseover", (e) => {
		if (PICTAL.Preferences && PICTAL.Preferences["hold_to_activate"] == "disabled" && PICTAL.isHoldingActivateKey) return;
		if (PICTAL.TargetedElement || PICTAL.State != "idle") return;

		let target = e.target;
		if (target == document.documentElement || target == document.body || target == document.header) return;
		if (target.children.length > 5) return;


		// if navigating to another page without moving and the mouse is over an image then mouseover triggers so we need mouse coords
		PICTAL.MouseX = e.clientX;
		PICTAL.MouseY = e.clientY;

		// get 5 closest ancestors to the target element
		let targetSieve = null;
		let targetURL = null;
		let targetRect = null;
		for (const tgt of getAncestors(target, PICTAL.Preferences["select_biggest_element"] ? 5 : 1)) {

			const tgtRect = tgt.getClientRects()[0];
			if (!tgtRect) continue;
			if (tgt.localName != "a" && (!tgtRect.width || !tgtRect.height)) continue;

			let elements = new Set();

			// find closest elements in ancestors
			elements.add(tgt.closest("a"));
			elements.add(tgt.closest("img"));
			elements.add(tgt.closest("video"));
			elements.add(tgt.closest("article"));
			elements.add(tgt.closest("source"));

			Object.values(tgt.children).forEach((el) => {
				if (el.localName == "source") elements.add(el);
			});


			let parent = tgt;

			for (let i = 0; i < 5; i++) {
				if (parent == document.body) break;

				// add cousin imgs that are the same size and in the same location of the target element
				let imgEls = parent.getElementsByTagName("img");
				if (imgEls.length > 1) {
					imgEls = [imgEls[0], imgEls[imgEls.length - 1]]; // just check first and last elements
				}

				for (const el of imgEls) {
					if (elements.has(el)) continue;
					if (!el.offsetWidth || !el.offsetHeight) continue; // if invisible
					const elRect = el.getClientRects()[0];

					if (Math.abs(elRect.x - tgtRect.x) > 5 || Math.abs(elRect.y - tgtRect.y) > 5) continue;
					if (Math.abs(elRect.width - tgtRect.width) > 20 || Math.abs(elRect.height - tgtRect.height) > 20) continue;

					elements.add(el);
				};

				parent = parent.parentNode;
			}
			if (elements.size == 1 && elements.has(null)) continue;

			// look for urls in all element candidates
			const urls = new Set();
			elements.forEach(el => {
				if (!el) return;
				if (el.href && !el.href.startsWith("javascript:")) urls.add(el.href);
				if (el.src && !el.src.startsWith("blob:")) urls.add(el.src);
				if (el.srcset) {
					let biggestURL;
					let biggestSize = 0;
					el.srcset.split(",").forEach(src => {
						let [url, size] = src.trim().split(" ");
						if (!size) {
							if (!biggestURL) biggestURL = url;
							return;
						}
						let value = parseFloat(size);
						if (value > biggestSize) {
							biggestURL = url;
							biggestSize = value;
						}
					});
					if (biggestURL) urls.add(biggestURL);
				}
				if (el.hasAttribute("data-file-url")) urls.add(el.getAttribute("data-file-url"));
				if (el.hasAttribute("data-source")) urls.add(el.getAttribute("data-source"));
			});
			if (urls.size == 0) continue;
			if (urls.size == 1 && urls.has(null)) continue;


			// look for link regex and image regex matches and use the first match
			let tgtURL = null;
			for (const s in PICTAL.Sieves) {
				let sieve = PICTAL.Sieves[s];
				if (!sieve.enabled) continue;

				if (sieve.prioritize_images) {
					if (sieve.image_regex) {
						tgtURL = checkSieveURLs(urls, "image", sieve.image_regex, sieve.image_filter_javascript, tgt);
					}
					if (!tgtURL && sieve.link_regex) {
						tgtURL = checkSieveURLs(urls, "link", sieve.link_regex, sieve.link_filter_javascript, tgt);
					}
				} else {
					if (sieve.link_regex) {
						tgtURL = checkSieveURLs(urls, "link", sieve.link_regex, sieve.link_filter_javascript, tgt);
					}
					if (!tgtURL && sieve.image_regex) {
						tgtURL = checkSieveURLs(urls, "image", sieve.image_regex, sieve.image_filter_javascript, tgt);
					}
				}

				if (tgtURL) {
					if (!targetSieve) targetSieve = sieve;
					break;
				}
			}

			// get the highest up element that has the same target url as the deepest element's target url
			// this is so the largest container is used instead of swapping between several valid elements in a container
			if (tgtURL) {
				if (!targetURL) {
					targetURL = tgtURL;
					targetRect = tgtRect;
				}
				if (tgtURL[2] == targetURL[2] && targetRect.width <= tgtRect.width && targetRect.height <= tgtRect.height) { // only use containers that are as big or bigger than the hovered element
					target = tgt;

					// hide tooltips that would interfere with the preview window
					target.title = "";
					target.setAttribute("data-hover-text", "");
				}
			}
		}
		if (!targetURL) return;
		targetURL[1] = targetURL[1] || ""; // "data:" urls don't have a protocol

		createOutline();
		createLoader();
		PICTAL.TargetedElement = target;
		PICTAL.LOADER.style.backgroundColor = COLORS.WHITE;
		PICTAL.State = "selecting";

		updateOutline();

		setupTimer(targetSieve, target, targetURL);
	});

	function updateOutline() {
		if (!PICTAL.TargetedElement) return;

		const rect = PICTAL.TargetedElement.getBoundingClientRect();
		Object.assign(PICTAL.OUTLINE.style, {
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

	let pauseMouseOut = false;
	document.addEventListener("mouseout", (e) => {
		if (PICTAL.State == "idle") return;
		if (PICTAL.TargetedElement?.contains(e.relatedTarget)) return; // don't move selection to a child element, it'll probably have the same link
		if (PICTAL.State == "selecting") {
			reset();
		}
		if (PICTAL.State == "loading" && !PICTAL.Center && !PICTAL.Preferences["always_full_zoom"]) {
			reset();
		}
		if (PICTAL.State == "preview" && !PICTAL.Center && !pauseMouseOut) {
			reset();
		}
	});

	window.navigation.addEventListener("navigate", (e) => {
		if (PICTAL.State == "idle") return;
		reset();
	})

	document.addEventListener("blur", () => {
		PICTAL.isHoldingActivateKey = false;
	});

	window.addEventListener("keyup", (e) => {
		if (e.key == PICTAL.Preferences["hold_to_activate_trigger"]) {
			PICTAL.isHoldingActivateKey = false;
			stopPropagation(e);
		}

		if (PICTAL.State == "preview" && e.key == "Alt") stopPropagation(e); // stop annoying alt window bar menu
	}, {
		capture: true,
		passive: false
	});

	function stopPropagation(e) {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
	}

	window.addEventListener("keydown", (e) => {
		if (e.target.isContentEditable || e.target.localName == "input") return; // if typing in an input, don't use shortcuts

		if (e.key == PICTAL.Preferences["hold_to_activate_trigger"] && !PICTAL.isHoldingActivateKey) {
			PICTAL.isHoldingActivateKey = true;
			stopPropagation(e);
			if (PICTAL.Preferences["hold_to_activate"] == "enabled" && PICTAL.State == "selecting" && !PICTAL.HoverTimer) {
				setupTimer();
			}
		}

		if (!e.ctrlKey && ((e.key == "Escape" && !e.shiftKey) || e.key == PICTAL.Shortcuts.close_preview)) {
			stopPropagation(e);
			reset();
		}


		if (PICTAL.State == "idle" || PICTAL.State == "selecting") return;

		if (!e.ctrlKey && (e.key == PICTAL.Shortcuts.zoom_in || (e.key == "Enter" && !e.shiftKey) || (e.key == "NumpadEnter" && !e.shiftKey))) {
			stopPropagation(e);
			PICTAL.Center = !PICTAL.Center;
			PICTAL.ViewMode = PICTAL.Preferences["default_zoom_mode"];
			if (PICTAL.Preferences["always_full_zoom"]) reset();
			PICTAL.DIV.style.pointerEvents = PICTAL.Center ? "initial" : "none";
			updateLoader();
			updateDIV();
		}

		if (!e.ctrlKey && (e.key == PICTAL.Shortcuts.natural_size || e.key == PICTAL.Shortcuts.auto_fit || e.key == PICTAL.Shortcuts.fit_to_width || e.key == PICTAL.Shortcuts.fit_to_height)) {
			stopPropagation(e);
			PICTAL.Center = true;

			switch (e.key) {
				case PICTAL.Shortcuts.natural_size:
					PICTAL.ViewMode = "natural_size";
					break;
				case PICTAL.Shortcuts.auto_fit:
					PICTAL.ViewMode = "auto_fit";
					break;
				case PICTAL.Shortcuts.fit_to_width:
					PICTAL.ViewMode = "fit_to_width";
					break;
				case PICTAL.Shortcuts.fit_to_height:
					PICTAL.ViewMode = "fit_to_height";
					break;
			}

			PICTAL.DIV.style.pointerEvents = "initial";
			updateLoader();
			updateDIV();
		}


		if (!e.ctrlKey && e.key == PICTAL.Shortcuts.wrap_caption) {
			stopPropagation(e);
			if (PICTAL.HEADER.style.whiteSpace == "nowrap") {
				PICTAL.HEADER.style.whiteSpace = "pre-line";
			} else {
				PICTAL.HEADER.style.whiteSpace = "nowrap";
			}
		}

		if (!e.ctrlKey && e.key == PICTAL.Shortcuts.open_options) {
			stopPropagation(e);
			chrome.runtime.sendMessage({
				type: "OpenOptions"
			});
		}


		const file = HoveredLinks.getFile();
		const albumSize = HoveredLinks.getFiles().length;

		const step_forward = (e.key == "ArrowRight" || (!e.shiftKey && e.key == " ") || e.key == "PageDown");
		const step_backward = (e.key == "ArrowLeft" || (e.shiftKey && e.key == " ") || e.key == "PageUp");
		if (!e.ctrlKey && (step_forward || step_backward)) {
			stopPropagation(e);
			if (albumSize > 1) {
				HoveredLinks.setIndex(clamp(HoveredLinks.getIndex() + ((step_forward ? 1 : -1) * ((e.shiftKey && e.key != " ") ? 5 : 1)), 0, albumSize - 1));
				loadPreviewFile();
			}
		}


		if (PICTAL.State != "preview") return;

		if (!e.ctrlKey && e.key == PICTAL.Shortcuts.open_image_in_new_tab) {
			stopPropagation(e);
			window.open(file.url, "_blank");
		}

		if (!e.ctrlKey && e.key == PICTAL.Shortcuts.add_to_history) {
			stopPropagation(e);
			chrome.runtime.sendMessage({
				type: "AddToHistory",
				url: file.url
			});
		}

		if (!e.ctrlKey && (e.key == PICTAL.Shortcuts.flip_vertical || e.key == PICTAL.Shortcuts.flip_horizontal)) {
			stopPropagation(e);
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

		if (!e.ctrlKey && (e.key == PICTAL.Shortcuts.rotate_left || e.key == PICTAL.Shortcuts.rotate_right)) {
			stopPropagation(e);
			PICTAL.Rotation += (e.key == PICTAL.Shortcuts.rotate_right ? 90 : -90);
			PICTAL.DIV.style.transform = `rotate(${PICTAL.Rotation}deg)`;
			fileLoaded();
			updateDIV();
		}

		if (PICTAL.Center && !e.ctrlKey && (e.key == "-" || e.key == "=")) {
			stopPropagation(e);
			if (e.key == "-") previewZoom(false);
			if (e.key == "=") previewZoom(true);
			updateDIV();
		}

		if (albumSize > 1) {
			if (!e.ctrlKey && !e.shiftKey && (e.key == "Home" || e.key == "End")) {
				stopPropagation(e);
				HoveredLinks.setIndex(e.key == "Home" ? 0 : albumSize - 1);
				loadPreviewFile();
			}
		}

		if (file.video) {
			if (!e.ctrlKey && (e.key == "ArrowUp" || e.key == "ArrowDown")) {
				stopPropagation(e);
				if (e.key == "ArrowUp") {
					if (PICTAL.VIDEO.muted) {
						PICTAL.VIDEO.muted = false;
						PICTAL.VIDEO.volume = 0;
						if (file.videojs) PICTAL.VIDEOJS.muted(false);
					}
				}
				PICTAL.VIDEO.volume = clamp(PICTAL.VIDEO.volume + (e.key == "ArrowUp" ? .05 : -.05), 0, 1);
				if (file.videojs) PICTAL.VIDEOJS.volume(PICTAL.VIDEO.volume);
			}

			if (!e.ctrlKey && (e.key == "," || e.key == ".")) {
				stopPropagation(e);
				let time = (e.key == "." ? 1 : -1) * .04;
				if (file.videojs) {
					PICTAL.VIDEOJS.pause();
					PICTAL.VIDEOJS.currentTime(PICTAL.VIDEOJS.currentTime() + time);
				} else {
					PICTAL.VIDEO.pause();
					PICTAL.VIDEO.currentTime += time;
				}
			}

			if (!e.ctrlKey && (e.key == "m")) {
				stopPropagation(e);
				PICTAL.VIDEO.muted = !PICTAL.VIDEO.muted;
				if (file.videojs) PICTAL.VIDEOJS.muted(PICTAL.VIDEO.muted);
			}
		}

		if (!e.shiftKey && e.ctrlKey && e.key == "c") {
			stopPropagation(e);
			navigator.clipboard.writeText(file.url);
		}

		if (!e.shiftKey && file.video) {
			if (e.key == " " && (albumSize == 1 || e.ctrlKey)) {
				stopPropagation(e);
				PICTAL.VIDEO.paused ? PICTAL.VIDEO.play() : PICTAL.VIDEO.pause();
				if (file.videojs) PICTAL.VIDEOJS.paused() ? PICTAL.VIDEOJS.play() : PICTAL.VIDEOJS.pause();
			}
		}

		if (file.video) {
			if ((e.key == "ArrowLeft" || e.key == "ArrowRight") && (albumSize == 1 || e.ctrlKey)) {
				stopPropagation(e);
				const time = (e.key == "ArrowRight" ? 5 : -5) * (e.shiftKey ? 3 : 1);
				if (file.videojs) {
					PICTAL.VIDEOJS.currentTime(PICTAL.VIDEOJS.currentTime() + time);
				} else {
					PICTAL.VIDEO.currentTime += time;
				}
			}
		}

		if (!e.ctrlKey && e.shiftKey && e.key == "End" && albumSize > 1) {
			stopPropagation(e);
			pauseMouseOut = true;
			let search = prompt("Enter the number of the page you want to jump to or to the first page with the caption text you're looking for.", "");
			setTimeout(() => { // prevent mouseout when execution resumes because the browser thinks you moused away
				pauseMouseOut = false;
			}, 1);

			if (search) {
				let index = HoveredLinks.getFiles().findIndex(f => f.caption?.includes(search));
				if (/^\d+$/.test(search)) { // is number
					HoveredLinks.setIndex(clamp(search - 1, 0, albumSize - 1));
					loadPreviewFile();
				} else if (index > -1) {
					HoveredLinks.setIndex(index);
					loadPreviewFile();
				} else if (index == -1) {
					alert(`"${search}" not found.`);
				}
			}
		}

		if (!e.ctrlKey && e.shiftKey && e.key == " " && file.video) {
			stopPropagation(e);
			if (file.videojs) {
				PICTAL.VIDEOJS.controls(!PICTAL.VIDEOJS.controls());
			} else {
				PICTAL.VIDEO.controls = !PICTAL.VIDEO.controls;
			}
		}

		if ((e.ctrlKey && !e.shiftKey && e.key == "s") || (!e.ctrlKey && e.key == PICTAL.Shortcuts.save_image)) {
			stopPropagation(e);
			let filename = file.filename;
			if (filename == false) return; // option to prevent downloading certain files
			if (!filename) {
				let url = new URL(file.url);
				filename = url.pathname.replace(/\/$/, "").split("/").pop();
			}

			// try to download through chrome.downloads.download with just the url
			chrome.runtime.sendMessage({
				type: "Download",
				url: file.url,
				filename: filename
			}, (resp) => {
				if (resp.ok == false) {
					// have to use window.open, chrome.tabs.create doesn't work for all cases
					// chrome.downloads.download returns immediately in chrome so we can't use a separate window because the download window is also closed upon window.close
					window.open(file.url + "#PICTALFILENAME=" + filename, "_blank");
				}
			});
		}
	}, {
		capture: true,
		passive: false
	});

	document.addEventListener("mousedown", (e) => {
		if (e.buttons == 1 && (PICTAL.State == "preview" && (!PICTAL.DIV.contains(e.target) || PICTAL.Preferences["click_to_close"]) || PICTAL.State == "loading")) {
			const file = HoveredLinks.getFile();
			if (file?.video && PICTAL.DIV.contains(e.target)) {
				if (e.target.localName != "video") return;
				if (!file.videojs && PICTAL.VIDEO.paused) return;
				if (file.videojs && PICTAL.VIDEOJS.paused()) return;
			}
			stopPropagation(e);
			reset();
		}
	});

	function isNearSide(e) {
		const horizontalMargin = document.documentElement.clientWidth / 20;
		const verticalMargin = document.documentElement.clientHeight / 20;
		const nearSide = (e.clientX < horizontalMargin || e.clientX > (document.documentElement.clientWidth - horizontalMargin) || e.clientY < verticalMargin || e.clientY > (document.documentElement.clientHeight - verticalMargin));
		return nearSide;
	}

	function previewZoom(zoom_in) {
		const [width, height] = getResolution();
		if (!width || !height) return;

		const maxHeight = document.documentElement.clientHeight;
		const maxWidth = document.documentElement.clientWidth;
		const imageRatio = Math.max(width / height, height / width);
		const scale = Math.min(maxWidth / width, maxHeight / height);
		const min = scale / 25; // zoom out
		const max = scale * imageRatio * 25; // zoom in

		if (!zoom_in && PICTAL.CenterZoom > min) {
			PICTAL.CenterZoom *= .75;
		}
		if (zoom_in && PICTAL.CenterZoom < max) {
			PICTAL.CenterZoom *= 1 / .75;
		}
	}

	document.addEventListener("wheel", (e) => {
		if (PICTAL.State == "idle" || PICTAL.State == "selecting") return;
		if (PICTAL.State == "loading" || PICTAL.Center) stopPropagation(e);

		if (PICTAL.Center && ((PICTAL.DIV.contains(e.target) && !isNearSide(e)) || HoveredLinks.getFiles().length == 1 || e.altKey) && !e.shiftKey) {
			stopPropagation(e);
			if (e.wheelDelta < 0) previewZoom(false);
			if (e.wheelDelta > 0) previewZoom(true);
			updateDIV();
		} else if (HoveredLinks.getFiles().length > 1 && (!PICTAL.Center || (PICTAL.Center && (!PICTAL.DIV.contains(e.target) || isNearSide(e))) || e.shiftKey)) {
			stopPropagation(e);
			if (e.wheelDelta < 0) {
				HoveredLinks.incrementIndex();
			}
			if (e.wheelDelta > 0) {
				HoveredLinks.decrementIndex();
			}

			loadPreviewFile();
		}
	}, {
		capture: true,
		passive: false
	});
}
