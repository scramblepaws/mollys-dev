export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (req.method === "POST" && url.pathname === "/hit") {
			const key = (url.searchParams.get("d") || "default").slice(0, 64);
			let n = parseInt(await env.COUNTS.get(key), 10);
			n = Number.isFinite(n) ? n + 1 : 1;
			await env.COUNTS.put(key, String(n));
			return new Response(String(n), {
				headers: {
					"Access-Control-Allow-Origin": "*",
					"Cache-Control": "no-store",
				},
			});
		}
		if (req.method === "GET" && url.pathname === "/count") {
			const key = (url.searchParams.get("d") || "default").slice(0, 64);
			const n = await env.COUNTS.get(key);
			return new Response(n || "0", {
				headers: { "Access-Control-Allow-Origin": "*" },
			});
		}
		return new Response("molly counter", { status: 404 });
	},
};
