// Content-Security-Policy bypass
window.addEventListener("message", async (e) => {
	if (e.source != window) return;
	if (!e.data) return;
	if (e.data.type != "PICTAL_FETCH") return;
	
	try {
		const response = await fetch(e.data.url);
		const body = await response.text();
		var headers = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});

		window.postMessage({
			type: "PICTAL_FETCH_RESULT",
			requestID: e.data.requestID,
			status: response.status,
			body: body,
			headers: headers
		}, "*");

	} catch (err) {
		window.postMessage({
			type: "PICTAL_FETCH_ERROR",
			requestID: e.data.requestID,
			error: err.toString()
		}, "*");
	}
});