"use strict";

const platform = location.protocol === "moz-extension:" ? "firefox" : "chrome";
if (platform == "firefox") var chrome = browser; // firefox doesn't recognize chrome in V2(?)

const DefaultPreferences = {
	hold_to_activate: "disabled",
	hold_to_activate_trigger: "Control",
	selection_delay: 500,
	video_volume: 50,
	show_resolution: false,
	preload_ahead: true,
	instantly_show_cached: true,
	add_hovered_to_history: false,
	cyclical_albums: false,
	loader_offset: 50,
	keep_cached_gallery_index: true,
	show_caption: true,
	wrap_caption: false,
	caption_position: "top",
};

const DefaultShortcuts = {
	zoom_in: "z",
	wrap_caption: "c",
	open_image_in_new_tab: "o",
	add_to_history: "h",
	save_image: "",
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
};

// if settings or shortcuts don't exist then fill in with a default value
function prepareConfig(defaultTbl, tbl) {
	for (const i in defaultTbl) {
		if (tbl[i] == null) {
			tbl[i] = defaultTbl[i];
		}
	}
	return tbl;
}

async function getSieves() {
	return chrome.storage.local.get("sieves").then(result => {
		if (!result.sieves) {
			return fetch(chrome.runtime.getURL("data/sieves.json")).then(r => r.json())
				.then(json => {
					chrome.storage.local.set({
						sieves: json
					});
					return json;
				});
		} else {
			return result.sieves;
		}
	});
}

var HeaderRules = new Set();

function onMessage(message, sender, sendResponse) {
	if (message.type == "GetSieves") {
		getSieves().then(sieve => {
			sendResponse({
				sieves: sieve
			});
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
		fetch(chrome.runtime.getURL("lib/videojs/video.js")).then(r => r.text())
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
				await response.body(); // required on Chrome for some reason
				return response.ok;
			} catch (err) {
				return false;
			}
		}

		tryURL((platform == "chrome" ? message.url : "")).then(ok => {
			let url = message.url;
			if (!ok && platform == "chrome") {
				if (!message.blob) {
					sendResponse({
						ok: false
					});
					return;
				}
			}
			const params = {
				url: url,
				filename: message.filename || "pictal_downloaded_file", // chrome.downloads.download fails silently if filename is empty
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
	if (message.type == "AddToHistory") {
		if (chrome.extension?.inIncognitoContext || sender.tab?.incognito) return;
		chrome.history.addUrl({
			url: message.url
		});
		return;
	}
	if (message.type == "ReloadScript") {
		registerContentScripts();
		return;
	}
	if (message.type == "ReloadListeners") {
		getSieves().then(sieve => {
			addModifyHeaderListeners(sieve);
		});
		return;
	}
}

async function registerContentScripts() {
	if (chrome.runtime.getManifest().manifest_version == 2) return;
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
		getSieves().then(sieve => {
			addModifyHeaderListeners(sieve);
		});
	} else if (e.reason === "install") {
		chrome.runtime.openOptionsPage();
	}
});


function wildcardMatch(url, pattern) {
	const escaped = pattern.replace(/[-\/\\^$+?.()|[\]{}]/g, "\\$&");
	const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
	const regex = new RegExp(regexStr, "i");
	return regex.test(url);
}

function rewriteRequestUserAgentHeader(e) {
	for (const sieve of HeaderRules) {
		if (!wildcardMatch(e.url, sieve.url_wildcard)) continue;
		if (sieve.action == "add" && sieve.apply_on == "request") {
			e.requestHeaders.push({
				name: sieve.header_name,
				value: sieve.header_value
			});
		}
		if (sieve.action == "modify" && sieve.apply_on == "request") {
			let header = e.requestHeaders.find(i => i.name == sieve.header_name);
			if (header) header.value = sieve.header_value;
		}
	}

	return {
		requestHeaders: e.requestHeaders
	};
}

function rewriteResponseUserAgentHeader(e) {
	for (const sieve of HeaderRules) {
		if (!wildcardMatch(e.url, sieve.url_wildcard)) continue;
		if (sieve.action == "add" && sieve.apply_on == "response") {
			e.responseHeaders.push({
				name: sieve.header_name,
				value: sieve.header_value
			});
		}
		if (sieve.action == "modify" && sieve.apply_on == "response") {
			let header = e.responseHeaders.find(i => i.name == sieve.header_name);
			if (header) header.value = sieve.header_value;
		}
	}
	return {
		responseHeaders: e.responseHeaders
	};
}

function addModifyHeaderListeners(sieves) {
	HeaderRules = new Set();
	let requestHeadersURLs = [];
	let responseHeadersURLs = [];

	for (const sieve in sieves) {
		if (sieves[sieve].modify_headers_json) {
			JSON.parse(sieves[sieve].modify_headers_json).forEach(rule => {
				HeaderRules.add(rule);
				if (rule.apply_on == "request" && rule.url_wildcard) requestHeadersURLs.push(rule.url_wildcard);
				if (rule.apply_on == "response" && rule.url_wildcard) responseHeadersURLs.push(rule.url_wildcard);
			})
		}
	};


	if (platform == "firefox") {
		chrome.webRequest.onBeforeSendHeaders.removeListener(rewriteRequestUserAgentHeader);
		if (!requestHeadersURLs.length) return;
		chrome.webRequest.onBeforeSendHeaders.addListener(
			rewriteRequestUserAgentHeader, {
				urls: requestHeadersURLs
			},
			["blocking", "requestHeaders"],
		);

		chrome.webRequest.onHeadersReceived.removeListener(rewriteResponseUserAgentHeader);
		if (!responseHeadersURLs.length) return;
		chrome.webRequest.onHeadersReceived.addListener(
			rewriteResponseUserAgentHeader, {
				urls: responseHeadersURLs
			},
			["blocking", "responseHeaders"]
		);
	} else {

		let rules = [];
		let ruleID = 1;
		for (const sieve of HeaderRules) {
			let headers = [
				{
					header: sieve.header_name,
					operation: "set",
					value: sieve.header_value
				}
			]

			let rule = {
				id: ruleID++,
				priority: 2,
				action: {
					type: "modifyHeaders",
				},
				condition: {
					urlFilter: sieve.url_wildcard,
					resourceTypes: [
                	    "main_frame",
                	    "sub_frame",
                	    "stylesheet",
                	    "script",
                	    "image",
                	    "font",
                	    "object",
                	    "xmlhttprequest",
                	    "ping",
                	    "csp_report",
                	    "media",
                	    "websocket",
                	    "webtransport",
                	    "webbundle",
                	    "other"
                	]
				}
			};

			if (sieve.apply_on == "request") {
				rule.action.requestHeaders = headers;
			} else if (sieve.apply_on == "response") {
				rule.action.responseHeaders = headers;
			}
			
			rules.push(rule);
		}


		chrome.declarativeNetRequest.getDynamicRules(function (r) {
		    if (!!r) {
		        const rulesToDelete = new Array();
		        r.forEach((rule) => {
		            rulesToDelete.push(rule.id);
		        });
				chrome.declarativeNetRequest.updateDynamicRules({
					removeRuleIds: rulesToDelete,
					addRules: rules
				}, () => {
					if (chrome.runtime.lastError) {
						console.error("Error updating dynamic rules:", chrome.runtime.lastError);
					}
				});
		    }
		});
	}
} 
