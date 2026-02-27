"use strict";

function beautify(value) {
    return js_beautify(value, {
        "indent_size": "1",
        "indent_char": "\t",
        "max_preserve_newlines": "5",
        "preserve_newlines": true,
        "keep_array_indentation": false,
        "break_chained_methods": false,
        "indent_scripts": "normal",
        "brace_style": "collapse",
        "space_before_conditional": true,
        "unescape_strings": false,
        "jslint_happy": false,
        "end_with_newline": false,
        "wrap_line_length": "0",
        "indent_inner_html": false,
        "comma_first": false,
        "e4x": false,
        "indent_empty_lines": false
    });
}

function addSieve(sieve_name, sieve) {
    const sieve_config = document.createElement("div");
    sieve_config.classList.add("sieve");
    if (!sieve.enabled) sieve_config.classList.add("disabled");

    sieve_config.innerHTML = `
        <span id="sieve_title" contenteditable="false" title="${sieve_name}">${sieve_name}</span>
        <div>
            <div class="rule_line">
                <label>Link Regex:</label>
                <textarea id="link_regex" wrap="soft" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="height: 45px;">${sieve.link_regex || ""}</textarea>
            </div>
            <div class="rule_line">
                <label style="width: 90px">Link Filter Javascript:</label>
                <pre id="link_filter_javascript"></pre>
            </div>
            <div class="rule_line">
                <label style="width: 90px">Link Request Javascript:</label>
                <pre id="link_request_javascript"></pre>
            </div>
            <div class="rule_line">
                <label style="width: 70px">Link Parse Javascript:</label>
                <pre id="link_parse_javascript"></pre>
            </div>
            <hr>
            <div class="rule_line">
                <input id="prioritize_img_checkbox" type="checkbox" style="display: none" ${sieve.prioritize_images ? "checked" : ""}>
                <label id="prioritize_img_indicator" class="checkbox" style="cursor: pointer;"></label>
                <label>Prioritize "Image" over "Link"</label>
            </div>
            <div class="rule_line">
                <label>Image Regex:</label>
                <textarea id="image_regex" wrap="soft" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="height: 45px;">${sieve.image_regex || ""}</textarea>
            </div>
            <div class="rule_line">
                <label style="width: 90px">Image Filter Javascript:</label>
                <pre id="image_filter_javascript"></pre>
            </div>
            <div class="rule_line">
                <label style="width: 82px">Image Parse Javascript:</label>
                <pre id="image_parse_javascript"></pre>
            </div>
            <hr>
            <div class="rule_line">
                <label style="width: 82px">Notes:</label>
                <textarea id="notes" wrap="soft" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" style="height: 120px;">${sieve.notes || ""}</textarea>
            </div>
        </div>
        <div class="action_buttons">
            <span id="rename" title="Rename sieve">✏️</span><span id="copy" title="Copy sieve to clipboard">&#x1F4CB;</span><span id="toggle" title="Toggle sieve">🚫</span><span id="delete" title="Delete sieve">🗑️</span>
        </div>
    `;

    ["link_request_javascript", "link_filter_javascript", "link_parse_javascript", "image_filter_javascript", "image_parse_javascript"].forEach(m => {
        const editor = ace.edit(sieve_config.querySelector("#" + m));
        editor.session.setMode("ace/mode/javascript");
        editor.setOptions({
            fontSize: "14px",
            showPrintMargin: false,
            wrap: true
        });
        if (m == "link_request_javascript") editor.setValue(beautify(sieve.link_request_javascript || ""), -1);
        if (m == "link_filter_javascript") editor.setValue(beautify(sieve.link_filter_javascript || ""), -1);
        if (m == "link_parse_javascript") editor.setValue(beautify(sieve.link_parse_javascript || ""), -1);
        if (m == "image_filter_javascript") editor.setValue(beautify(sieve.image_filter_javascript || ""), -1);
        if (m == "image_parse_javascript") editor.setValue(beautify(sieve.image_parse_javascript || ""), -1);
        const observer = new ResizeObserver(() => {
            editor.resize();
        });
        observer.observe(editor.container);
    });

    sieve_config.querySelector("span").onclick = function (e) {
        const title = sieve_config.querySelector("#sieve_title");
        if (e.target == this && title.contentEditable == "false") {
            sieve_config.classList.toggle("opened");
        }
    }

    sieve_config.querySelector("#rename").onclick = function () {
        const title = sieve_config.querySelector("#sieve_title");
        title.contentEditable = (title.contentEditable == "false" ? "true" : "false");
        title.classList.toggle("focus");
        title.textContent = title.textContent.trim();
        document.querySelectorAll("#sieve_title").forEach(el => {
            if (title == el) return;
            if (title.textContent == el.textContent) {
                title.textContent += " " + Date.now();
            }
        });
        highlightSaveButton();
    }

    sieve_config.querySelector("#delete").onclick = function () {
        if (confirm("Are you sure you want to delete " + sieve_config.querySelector("#sieve_title").textContent + "?")) {
            sieve_config.remove();
            delete SAVED_SIEVES[sieve_name];
            highlightSaveButton();
        }
    }

    sieve_config.querySelector("#toggle").onclick = function () {
        sieve_config.classList.toggle("disabled");
        highlightSaveButton();
    }

    sieve_config.querySelector("#copy").onclick = function () {
        navigator.clipboard.writeText(JSON.stringify(getSieves("", [sieve_config]), null, 4));
        alert("The sieve has been copied to your clipboard.")
    }

    sieve_config.querySelector("#prioritize_img_indicator").addEventListener("click", function (e) {
        const checkbox = sieve_config.querySelector("#prioritize_img_checkbox");
        checkbox.checked = !checkbox.checked;
        highlightSaveButton();
    });

    sieve_config.querySelectorAll("textarea, input").forEach(el => {
        el.oninput = highlightSaveButton
    });

    sieve_config.querySelectorAll(".checkbox").forEach(el => {
        el.onclick = highlightSaveButton
    });

    document.querySelector("#sieve_container").appendChild(sieve_config);
}


var SAVED_SIEVES = {};
var DEFAULT_PREFERENCES = {};
var DEFAULT_SHORTCUTS = {};

function getSieves(search = "", sieve = null) {
    const sieves = sieve || document.querySelectorAll(".sieve");

    let regular_sieves = {};
    let last_sieves = {};
    for (var i = 0; i < sieves.length; i++) {
        const sieve = sieves[i];

        const id = sieve.querySelector("#sieve_title").textContent.trim();
        if (!id.includes(search)) continue;
        const enabled = !sieve.classList.contains("disabled");
        const link_regex = sieve.querySelector("#link_regex").value;
        const link_filter_javascript = ace.edit(sieve.querySelector("#link_filter_javascript")).getValue();
        const link_request_javascript = ace.edit(sieve.querySelector("#link_request_javascript")).getValue();
        const link_parse_javascript = ace.edit(sieve.querySelector("#link_parse_javascript")).getValue();
        const image_regex = sieve.querySelector("#image_regex").value;
        const image_filter_javascript = ace.edit(sieve.querySelector("#image_filter_javascript")).getValue();
        const image_parse_javascript = ace.edit(sieve.querySelector("#image_parse_javascript")).getValue();
        const prioritize_images = sieve.querySelector("#prioritize_img_checkbox").checked || "";
        const notes = sieve.querySelector("#notes").value;

        let new_sieve = {
            enabled: enabled,
            link_regex: link_regex.trim(),
            link_filter_javascript: link_filter_javascript.trim(),
            link_request_javascript: link_request_javascript.trim(),
            link_parse_javascript: link_parse_javascript.trim(),
            image_regex: image_regex.trim(),
            image_filter_javascript: image_filter_javascript.trim(),
            image_parse_javascript: image_parse_javascript.trim(),
            prioritize_images: prioritize_images,
            notes: notes.trim()
        };

        Object.keys(new_sieve).forEach(key => {
            if (typeof new_sieve[key] == "string" && !new_sieve[key].trim()) delete new_sieve[key];
        });


        if (id[0] == "~") last_sieves[id] = new_sieve;
        else regular_sieves[id] = new_sieve;
    }

    let sorted = Object.entries(regular_sieves).sort((a, b) =>
        a[0].localeCompare(b[0], undefined, {
            numeric: true
        })
    );

    const sorted_last = Object.entries(last_sieves).sort((a, b) =>
        a[0].localeCompare(b[0], undefined, {
            numeric: true
        })
    );

    sorted = sorted.concat(sorted_last);
    return Object.fromEntries(sorted);
}

function save() {
    document.querySelector("#save_button").classList.remove("alert");

    SAVED_SIEVES = getSieves();

    chrome.storage.local.set({
        sieves: SAVED_SIEVES
    });


    let SAVED_PREFERENCES = {};
    document.querySelectorAll("#settings-sec input[name]").forEach(el => {
        SAVED_PREFERENCES[el.name] = (el.type == "checkbox" ? el.checked : el.value);
    });

    document.querySelectorAll("#settings-sec select").forEach(el => {
        SAVED_PREFERENCES[el.name] = el.value;
    });

    chrome.storage.local.set({
        preferences: SAVED_PREFERENCES
    });


    let SAVED_SHORTCUTS = {};
    document.querySelectorAll("#shortcuts-sec input").forEach(el => {
        SAVED_SHORTCUTS[el.name] = el.value;
    });

    chrome.storage.local.set({
        shortcuts: SAVED_SHORTCUTS
    });

    chrome.storage.local.set({
        filters: document.querySelector("#filters").value
    });
}

function new_sieve() {
    const sieve_name = "new sieve " + Date.now();
    SAVED_SIEVES[sieve_name] = {}
    addSieve(sieve_name, SAVED_SIEVES[sieve_name]);
}

function highlightSaveButton() {
    document.querySelector("#save_button").classList.add("alert");
}

function findKeyConflicts(els) {
    const keys = {};
    els.forEach(inputEl => {
        if (inputEl.value) {
            keys[inputEl.value] = (keys[inputEl.value] || 0) + 1;
        }
        inputEl.style.color = "initial";
    });
    Object.keys(keys).filter(key => keys[key] > 1).forEach(k => {
        Array.from(els).filter(input => input.value === k).forEach(kk => {
            kk.style.color = "red";
        });
    });
}

function setupPreferences(preferences) {
    document.querySelectorAll("#settings-sec input[name], select").forEach(el => {
        if (preferences[el.name]) {
            if (el.type == "checkbox" && el.localName == "input") {
                el.checked = preferences[el.name];
            } else {
                el.value = preferences[el.name];
            }
        }

        if (el.localName == "select") {
            el.onchange = highlightSaveButton;
        } else {
            el.oninput = highlightSaveButton;
        }
    });
}

function setupShortcuts(shortcuts) {
    const els = document.querySelectorAll("#shortcuts-sec input");
    els.forEach(el => {
        if (shortcuts[el.name] != null) {
            el.value = shortcuts[el.name];
        }

        // handle shortcut inputs on shortcut page
        el.addEventListener("input", function (e) {
            el.value = e.data;
            highlightSaveButton();
            findKeyConflicts(els);
        });
    });
    findKeyConflicts(els);
}

function sievesFromJSON(json) {
    document.querySelector("#sieve_container").innerHTML = '';
    for (const sieve in json) {
        SAVED_SIEVES[sieve] = json[sieve];
    }
    for (const sieve in SAVED_SIEVES) {
        addSieve(sieve, SAVED_SIEVES[sieve]);
    }
}

window.addEventListener("load", function () {
    location.hash = location.hash || "#settings";
    const section = document.querySelector("#nav_menu").querySelector(`a[href="${location.hash}"]`);
    if (section) {
        section.classList.add("active");
        document.body.querySelector(location.hash + "-sec").style.display = "block";
        if (location.hash == "#sieves") {
            document.body.querySelector("#new_button").style.display = "initial";
            document.body.querySelector("#default_button").style.display = "none";
        } else {
            document.body.querySelector("#default_button").style.display = "initial";
            document.body.querySelector("#new_button").style.display = "none";
        }
    }

    // load sieves
    chrome.runtime.sendMessage({
        type: "GetSieves"
    }, (response) => {
        for (const sieve in response.sieves) {
            addSieve(sieve, response.sieves[sieve]);
        }
        SAVED_SIEVES = response.sieves;
    });

    // load preferences
    chrome.runtime.sendMessage({
        type: "GetPreferences"
    }, (response) => {
        DEFAULT_PREFERENCES = response.default;
        setupPreferences(response.preferences);
    });

    // load shortcuts
    chrome.runtime.sendMessage({
        type: "GetShortcuts"
    }, (response) => {
        DEFAULT_SHORTCUTS = response.default;
        setupShortcuts(response.shortcuts);
    });

    // load site filters
    chrome.runtime.sendMessage({
        type: "GetSiteFilters"
    }, (response) => {
        const el = document.querySelector("#filters");
        el.value = response.filters;
    });

    document.querySelector(".clear_search").onclick = function () {
        document.querySelector("#sieve_search").value = "";
        document.querySelector(".clear_search").style.visibility = "hidden";
        document.querySelectorAll(".sieve").forEach(el => {
            el.style.display = "initial";
        });
    }
    document.querySelector("#sieve_search").value = "";
    document.querySelector("#sieve_search").oninput = function (e) {
        const sieves = getSieves(e.target.value);
        if (e.target.value) {
            document.querySelector(".clear_search").style.visibility = "visible";
        } else {
            document.querySelector(".clear_search").style.visibility = "hidden";
        }
        document.querySelectorAll(".sieve").forEach(el => {
            if (sieves[el.querySelector("#sieve_title").innerText]) {
                el.style.display = "initial";
            } else {
                el.style.display = "none";
            }
        });
    }

    document.querySelector("#import_sieves").onclick = function () {
        let json = prompt("Paste the JSON of the sieves you want to import. If an imported sieve has the same name as an existing sieve then the existing sieve will be overwritten.", "{}");
        if (json) {
            try {
                sievesFromJSON(JSON.parse(json));
                highlightSaveButton();
            } catch (err) {
                alert("The imported json is malformed.");
            }
        }
    }

    document.querySelector("#update_sieves").onclick = function () {
        fetch("https://raw.githubusercontent.com/Bytanel/Pictal/refs/heads/master/data/sieves.json").then(response => {
            if (!response.ok) {
                alert("Failed to download sieves. Status: " + response.status);
                return;
            }
            return response.json();
        }).then(json => {
            if (confirm(`Downloaded ${Object.keys(json).length} sieves. Do you wish to import them? Any sieves with the same name will be overwritten.`)) {
                sievesFromJSON(json);
                highlightSaveButton();
            }
        });
    }

    document.querySelector("#copy_rules_to_clipboard").onclick = function () {
        navigator.clipboard.writeText(JSON.stringify(getSieves(), null, 4));
        alert("The sieves have been copied to your clipboard.")
    }

    document.querySelector("#default_button").onclick = function () {
        setupPreferences(DEFAULT_PREFERENCES);
        setupShortcuts(DEFAULT_SHORTCUTS);
        highlightSaveButton();
    }
    document.querySelector("#save_button").onclick = save;
    document.querySelector("#new_button").onclick = new_sieve;
    document.querySelector("#allow_scripts_message").onclick = function (e) {
        e.preventDefault();
        chrome.permissions.request({
            permissions: ["userScripts"]
        });
    }
    setTimeout(checkUserScripts, 500);

    // swap between the different pages
    document.querySelector("#nav_menu").onclick = function (e) {
        if (e.target.hash) {
            document.querySelectorAll("#nav_menu > a").forEach(el => {
                el.classList.remove("active");
                const section = document.body.querySelector(el.hash + "-sec");
                if (section) section.style.display = (el == e.target ? "block" : "none");
            });
            e.target.classList.add("active");
            if (e.target.hash == "#sieves") {
                document.body.querySelector("#new_button").style.display = "initial";
                document.body.querySelector("#default_button").style.display = "none";
            } else {
                document.body.querySelector("#default_button").style.display = "initial";
                document.body.querySelector("#new_button").style.display = "none";
            }
        }
    }
}, false);

document.addEventListener("keydown", function (e) {
    if (e.code === "KeyS" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
    }
}, true);

async function checkUserScripts() {
    const msg = document.querySelector("#allow_scripts_message");
    try {
        const scripts = await chrome.userScripts.getScripts();
        if (scripts?.length > 0) {
            msg.innerHTML = `Great! \"Pictal\" is ready now.`;
            msg.style.backgroundColor = "#dcfad7";
            return;
        } else {
            chrome.runtime.sendMessage({
                type: "ReloadScript"
            });
        }
    } catch (e) {
        msg.innerHTML = `To continue you have to <a href=\"#\">allow User Scripts</a>.`;
        msg.style.display = "block";
    }

    setTimeout(checkUserScripts, 2000);
}
