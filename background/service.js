"use strict";

const platform = location.protocol === "moz-extension:" ? "firefox" : "chrome";

const DefaultPreferences = {
	hold_to_activate: "disabled",
	hold_to_activate_trigger: "Control",
	selection_delay: 500,
	reset_delay_on_mouse_move: true,
	default_video_volume: 50,
	default_video_muted: false,
	show_resolution: false,
	images_preloaded_ahead: 2,
	instantly_show_cached: false,
	add_hovered_to_history: false,
	cyclical_albums: false,
	loader_offset: 25,
	distance_from_cursor: 20,
	hide_cursor_delay: 1500,
	keep_cached_album_index: true,
	click_to_close: true,
	select_biggest_element: true,
	debug_mode: false,
	show_caption: true,
	wrap_caption: false,
	caption_position: "top",
	default_zoom_mode: "auto_fit",
	always_full_zoom: false,
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

		// chrome's implementation of download is different from firefox and experiences problems on certain sites
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
			addModifyHeaderRules(sieve);
		});
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



const protocolRegex = new RegExp(/^(?:(https?:\/\/(?:www\.)?))?(.*)$/i);

function isBlacklisted(filters, _url) {
	const [, , url] = _url.match(protocolRegex);
	let blacklisted = false;
	for (const f of filters.split("\n")) {
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
	return blacklisted;
}

function updateIcon(tabID, tabURL) {
	if (!tabURL) return;
	chrome.storage.local.get("filters").then(result => {
		const filters = result?.filters || "";
		if (isBlacklisted(filters, tabURL)) {
			chrome.action.setBadgeText({
				text: "X",
				tabId: tabID
			});
			chrome.action.setBadgeBackgroundColor({
				color: "#ff8080ff",
				tabId: tabID
			});
			chrome.action.setBadgeTextColor({
				color: "#FFF",
				tabId: tabID
			});
		} else {
			chrome.action.setBadgeText({
				text: "",
				tabId: tabID
			});
		}
	});
}

function createBlacklistRegex(_url) {
	_url = new URL(_url).origin;
	let [, , url] = _url.match(protocolRegex);
	url = `!:^${url}`.replace(".", "\\.");
	return url;
}

chrome.action.onClicked.addListener((tab) => {
	if (tab.url.includes("moz-extension://") || tab.url.includes("chrome-extension://")) return;
	chrome.storage.local.get("filters").then(result => {
		const filters = result?.filters || "";
		let filterArray = filters.split("\n");

		const blacklistRegex = createBlacklistRegex(tab.url);

		// if blacklisted and doesn't match generated blacklist regex then it's custom
		if (!filterArray.includes(blacklistRegex) && isBlacklisted(filters, tab.url)) {
			chrome.tabs.create({
				url: "options/options.html#sites"
			});
			return;
		}

		if (filterArray.includes(blacklistRegex)) {
			filterArray.splice(filterArray.indexOf(blacklistRegex), 1);
		} else {
			filterArray.push(blacklistRegex);
		}

		chrome.storage.local.set({
			filters: filterArray.join("\n")
		});

		updateIcon(tab.id, tab.url);
	});
});

// update badge on tab update
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
	if (!tab.active) return;
	updateIcon(tabId, tab.url);
});

// update badge on tab activation
chrome.tabs.onActivated.addListener(async function(info) {
	updateIcon(info.tabId, (await chrome.tabs.get(info.tabId)).url);
});



chrome.runtime.onMessage?.addListener(onMessage);

chrome.runtime.onUserScriptMessage?.addListener(onMessage);

chrome.runtime.onInstalled.addListener(function(e) {
	if (e.reason === "update") {
		registerContentScripts();
		getSieves().then(sieve => {
			addModifyHeaderRules(sieve);
		});
	} else if (e.reason === "install") {
		chrome.runtime.openOptionsPage();
	}
});

function addModifyHeaderRules(sieves) {
	let rules = [];
	let ruleID = 1;
	for (const sieve in sieves) {
		if (!sieves[sieve].modify_headers_json) continue;
		JSON.parse(sieves[sieve].modify_headers_json).forEach(sieveRule => {
			if (!sieveRule.header_name || !sieveRule.url_wildcard || !sieveRule.apply_on) return;
			let headers;
			if (sieveRule.action == "add" || sieveRule.action == "modify"){
				if (!sieveRule.header_value) return;
				headers = [{
					header: sieveRule.header_name,
					operation: "set",
					value: sieveRule.header_value
				}];
			}
			else if (sieveRule.action == "delete"){
				headers = [{
					header: sieveRule.header_name,
					operation: "remove"
				}];
			}

			let rule = {
				id: ruleID++,
				priority: 2,
				action: {
					type: "modifyHeaders",
				},
				condition: {
					urlFilter: sieveRule.url_wildcard,
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
						//"webtransport",
						//"webbundle",
						"other"
					]
				}
			};

			if (sieveRule.apply_on == "request") {
				rule.action.requestHeaders = headers;
			} else if (sieveRule.apply_on == "response") {
				rule.action.responseHeaders = headers;
			}

			rules.push(rule);
		});
	}


	chrome.declarativeNetRequest.getDynamicRules(function(r) {
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

// keep service worker alive otherwise button stops working in chrome
setInterval(chrome.runtime.getPlatformInfo, 25000);
