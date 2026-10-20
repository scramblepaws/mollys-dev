export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const cors = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
			"Cache-Control": "no-store",
		};
		if (req.method === "OPTIONS") return new Response(null, { headers: cors });

		if (req.method === "GET" && url.pathname === "/list") {
			const list = await env.COUNTS.list({ prefix: "gb:" });
			// ponytail: newest 50 only; prune or paginate if the book grows past KV list limits
			const keys = list.keys.slice(-50).reverse();
			const entries = await Promise.all(
				keys.map(async (k) => {
					try {
						return JSON.parse(await env.COUNTS.get(k.name));
					} catch {
						return null;
					}
				})
			);
			return Response.json(entries.filter(Boolean), { headers: cors });
		}

		if (req.method === "POST" && url.pathname === "/post") {
			let body;
			try {
				body = await req.json();
			} catch {
				return Response.json({ ok: false, error: "bad json" }, { status: 400, headers: cors });
			}
			const name = String(body.name || "anon").slice(0, 40);
			const msg = String(body.msg || "").slice(0, 500).trim();
			if (!msg) {
				return Response.json({ ok: false, error: "empty message" }, { status: 400, headers: cors });
			}

			const ip = req.headers.get("CF-Connecting-IP") || "unknown";
			const rateKey = "rate:" + ip;
			const last = parseInt(await env.COUNTS.get(rateKey), 10) || 0;
			const now = Date.now();
			if (now - last < 30000) {
				return Response.json({ ok: false, error: "slow down, try again in a bit" }, { status: 429, headers: cors });
			}
			await env.COUNTS.put(rateKey, String(now));

			const key = "gb:" + now.toString().padStart(13, "0") + ":" + Math.random().toString(36).slice(2, 8);
			const entry = { name, msg, ts: now };
			await env.COUNTS.put(key, JSON.stringify(entry));
			return Response.json({ ok: true, entry }, { headers: cors });
		}

		return new Response("not found", { status: 404, headers: cors });
	},
};
