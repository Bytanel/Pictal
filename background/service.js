"use strict";

const platform = location.protocol === "moz-extension:" ? "firefox" : "chrome";

const DefaultPreferences = {
	hold_to_activate: "disabled",
	hold_to_activate_trigger: "Control",
	selection_delay: 500,
	video_volume: 50,
	show_resolution: false,
	show_caption: true,
	wrap_caption: false,
	preload_ahead: true
};

const DefaultShortcuts = {
	zoom_in: "z",
	wrap_caption: "c",
	open_image_in_new_tab: "o",
	close_preview: "",
	open_options: "p",
	flip_horizontal: "w",
	flip_vertical: "q",
	rotate_left: "e",
	rotate_right: "r",
	natural_size: "1",
	auto_fit: "2",
	fit_to_width: "3",
	fit_to_height: "4",
}

function prepareConfig(defaultTbl, tbl) {
	for (const i in defaultTbl) {
		if (tbl[i] == null) {
			tbl[i] = defaultTbl[i];
		}
	}
	return tbl;
}


function onMessage(message, sender, sendResponse) {
	if (message.type == "GetSieves") {
		chrome.storage.local.get("sieves").then(result => {
			if (!result.sieves) {
				fetch(chrome.runtime.getURL("data/sieves.json")).then(r => r.json())
					.then(json => {
						chrome.storage.local.set({
							sieves: json
						});
						sendResponse({
							sieves: json
						});
					});
			} else {
				sendResponse({
					sieves: result.sieves
				});
			}
		});
		return true;
	}
	if (message.type == "GetPreferences") {
		chrome.storage.local.get("preferences").then(result => {
			sendResponse({
				preferences: prepareConfig(DefaultPreferences, result?.preferences || {}),
				default: DefaultPreferences
			});
		});
		return true;
	}
	if (message.type == "GetShortcuts") {
		chrome.storage.local.get("shortcuts").then(result => {
			sendResponse({
				shortcuts: prepareConfig(DefaultShortcuts, result?.shortcuts || {}),
				default: DefaultShortcuts
			});
		});
		return true;
	}
	if (message.type == "GetSiteFilters") {
		chrome.storage.local.get("filters").then(result => {
			sendResponse({
				filters: result?.filters || ""
			});
		});
		return true;
	}
	if (message.type == "GetVideoJSJavacript") {
		fetch(chrome.runtime.getURL("lib/videojs/video.min.js")).then(r => r.text())
			.then(js => {
				sendResponse({
					js: js
				})
			});
		return true;
	}
	if (message.type == "GetVideoJSCSS") {
		fetch(chrome.runtime.getURL("lib/videojs/video-js.min.css")).then(r => r.text())
			.then(css => {
				sendResponse({
					css: css
				})
			});
		return true;
	}
	if (message.type == "OpenOptions") {
		chrome.tabs.create({
			url: "options/options.html"
		});
		return;
	}
	if (message.type == "MakeRequest") { // required to be done in a service worker because of CORS
		fetch(message.url, {
			method: message.method,
			credentials: "include",
			cache: "default"
		}).then(r => {
			const headers = {};
			for (const [k, v] of r.headers.entries()) headers[k] = v;

			r.text().then(body => {
				sendResponse({
					status: r.status,
					headers: headers,
					body: body
				});
			})
		});
		return true; // keep open channel for async
	}
	if (message.type == "Download") {

		async function tryURL(url) {
			try {
				const response = await fetch(url, {
					method: "GET",
					headers: {
						"Range": "bytes=0-0"
					}
				});
				return response.ok;
			} catch (err) {
				return false;
			}
		}

		tryURL(message.url).then(ok => {
			let url = message.url;
			if (!ok) {
				if (!message.blob) {
					sendResponse({
						ok: false
					});
					return;
				}
				url = (platform == "chrome" ? message.url : URL.createObjectURL(message.blob)); // URL.createObjectURL is disabled here in chrome and using blob urls from content.js in firefox has permissions issues
			}
			const params = {
				url: url,
				filename: message.filename,
				conflictAction: "uniquify",
				saveAs: true
			};
			if (platform == "firefox" && sender.tab?.incognito) {
				params.incognito = sender.tab.incognito;
			}
			chrome.downloads.download(params).then(sendResponse).catch(sendResponse); // chrome returns immediately while firefox waits until you close the save-as window
		});

		return true;
	}
	if (message.type == "ReloadScript") {
		registerContentScripts();
		return;
	}
}

async function registerContentScripts() {
	try {
		await chrome.userScripts.configureWorld({
			csp: "script-src 'self' 'unsafe-eval'",
			messaging: true
		});
	} catch {
		chrome.runtime.openOptionsPage();
		return;
	}

	await chrome.runtime.onUserScriptMessage?.addListener(onMessage);

	// register the content.js as a user script so that unsafe functions like eval are able to be run for sieves
	await chrome.userScripts.unregister();
	await chrome.userScripts.register([{
		id: "content.js",
		allFrames: true,
		matches: ["<all_urls>"],
		runAt: "document_start",
		world: "USER_SCRIPT",
		js: [{
			file: "content/content.js"
		}],
	}, ]);
}

chrome.runtime.onMessage?.addListener(onMessage);

chrome.runtime.onUserScriptMessage?.addListener(onMessage);

chrome.runtime.onInstalled.addListener(function(e) {
	if (e.reason === "update") {
		registerContentScripts();
	} else if (e.reason === "install") {
		chrome.runtime.openOptionsPage();
	}
});