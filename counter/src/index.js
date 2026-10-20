// isolate-level cache: survives across requests that share the same worker instance
let memCache = new Map();

const SPOTIFY_CLIENT_ID = "b240a3e433a34fd3b2e7b406c585c510";

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

		if (req.method === "GET" && url.pathname === "/login") {
			const redirect = "https://" + new URL(req.url).host + "/callback";
			const authUrl =
				"https://accounts.spotify.com/authorize?" +
				new URLSearchParams({
					client_id: SPOTIFY_CLIENT_ID,
					response_type: "code",
					redirect_uri: redirect,
					scope: "user-read-currently-playing user-read-playback-state",
					state: "molly",
				});
			return Response.redirect(authUrl, 302);
		}

		if (req.method === "GET" && url.pathname === "/callback") {
			const code = url.searchParams.get("code");
			const redirect = "https://" + new URL(req.url).host + "/callback";
			if (!code) {
				return new Response("no code :(", { status: 400 });
			}
			const r = await fetch("https://accounts.spotify.com/api/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: redirect,
					client_id: SPOTIFY_CLIENT_ID,
				}),
			});
			const j = await r.json();
			if (!j.refresh_token) {
				return new Response("auth failed: " + JSON.stringify(j), { status: 400 });
			}
			await env.COUNTS.put("sp_ref", j.refresh_token);
			return new Response(
				"saved! you can close this tab. mollys.dev now shows what you're listening to.",
				{ headers: { "Content-Type": "text/plain; charset=utf-8" } }
			);
		}

		if (req.method === "GET" && url.pathname === "/now-playing") {
			const refresh = await env.COUNTS.get("sp_ref");
			if (!refresh) return Response.json({ error: "not authed" }, { headers: cors });

			let access = await env.COUNTS.get("sp_acc");
			if (!access) {
				const r = await fetch("https://accounts.spotify.com/api/token", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: refresh,
						client_id: SPOTIFY_CLIENT_ID,
					}),
				});
				const j = await r.json();
				if (!j.access_token) {
					return Response.json({ error: "refresh failed: " + (j.error || "?") }, { headers: cors });
				}
				access = j.access_token;
				await env.COUNTS.put("sp_acc", access, {
					expirationTtl: Math.max(60, (j.expires_in || 3600) - 60),
				});
			}

			const np = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
				headers: { Authorization: "Bearer " + access },
			});
			if (np.status === 204) return Response.json({ playing: false }, { headers: cors });
			if (!np.ok) {
				await env.COUNTS.delete("sp_acc");
				return Response.json({ playing: false, error: "spotify " + np.status }, { headers: cors });
			}
			const body = await np.json();
			const item = body.item;
			if (!item) return Response.json({ playing: false }, { headers: cors });
			const art =
				item.album && item.album.images && item.album.images[1] ? item.album.images[1].url : null;
			const artist = item.artists
				? item.artists.map((a) => a.name).join(", ")
				: item.show
					? item.show.name
					: "";
			return Response.json(
				{
					playing: body.is_playing !== false,
					title: item.name,
					artist,
					art,
					progress: body.progress_ms || 0,
					duration: item.duration_ms || 0,
				},
				{ headers: cors }
			);
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
