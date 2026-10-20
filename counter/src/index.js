// isolate-level cache: survives across requests that share the same worker instance
let memCache = new Map();

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

		if (req.method === "GET" && url.pathname === "/preview") {
			const target = url.searchParams.get("url");
			if (!target || !/^https?:\/\//i.test(target)) {
				return Response.json({ error: "bad url" }, { status: 400, headers: cors });
			}
			const key = "pv:" + target.slice(0, 200);
			const mem = memCache.get(key);
			if (mem && Date.now() - mem.ts < 600000) {
				return new Response(mem.data, { headers: { ...cors, "Content-Type": "application/json" } });
			}
			const cached = await env.COUNTS.get(key);
			if (cached) {
				memCache.set(key, { data: cached, ts: Date.now() });
				return new Response(cached, { headers: { ...cors, "Content-Type": "application/json" } });
			}
			try {
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), 6000);
				const res = await fetch(target, {
					signal: ctrl.signal,
					headers: {
						"User-Agent": "Mozilla/5.0 (compatible; mollys.dev link preview)",
						Accept: "text/html",
					},
					redirect: "follow",
				});
				clearTimeout(t);
				const ct = res.headers.get("content-type") || "";
				if (!res.ok || !ct.includes("html")) throw new Error("not html");

				// stream only the first 256KB instead of the whole page
				const reader = res.body.getReader();
				const chunks = [];
				let total = 0;
				while (total < 256000) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
					total += value.byteLength;
				}
				reader.cancel().catch(() => {});
				const buf = new Uint8Array(total);
				let off = 0;
				for (const c of chunks) {
					buf.set(c, off);
					off += c.byteLength;
				}
				const html = new TextDecoder().decode(buf.subarray(0, 256000));
				const meta = (attr) => {
					const m =
						html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + attr + '["\'][^>]*content=["\']([^"\']+)', "i")) ||
						html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + attr, "i"));
					return m ? m[1] : null;
				};
				const decode = (s) =>
					s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
				const titleTag = html.match(/<title[^>]*>([^<]+)</i);
				const title = meta("og:title") || (titleTag ? titleTag[1] : "") || target;
				const data = JSON.stringify({
					title: decode(title).trim().slice(0, 140),
					image: meta("og:image"),
					desc: decode(meta("og:description") || "").slice(0, 200),
					url: target,
				});
				await env.COUNTS.put(key, data, { expirationTtl: 86400 });
				memCache.set(key, { data, ts: Date.now() });
				return new Response(data, { headers: { ...cors, "Content-Type": "application/json" } });
			} catch (e) {
				return Response.json({ error: String((e && e.message) || e) }, { status: 502, headers: cors });
			}
		}

		return new Response("not found", { status: 404, headers: cors });
	},
};
