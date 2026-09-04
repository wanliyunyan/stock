const EASTMONEY_SEARCH_API = "https://np-tjxg-g.eastmoney.com/api/smart-tag/stock/v3/pw/search-code";
const EASTMONEY_QUOTE_API = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const EASTMONEY_QUOTE_FALLBACK_API = "https://push2his.eastmoney.com/api/qt/ulist.np/get";

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        if (url.pathname === "/" || url.pathname === "") {
            return jsonResponse(
                {
                    ok: true,
                    routes: ["/api/stocks", "/api/quotes"],
                    note: "Use this Worker as the API base for the GitHub Pages frontend."
                },
                200
            );
        }

        if (url.pathname === "/api/stocks") {
            return proxySearch(request);
        }

        if (url.pathname === "/api/quotes") {
            return proxyQuotes(request);
        }

        return new Response("Not Found", {
            status: 404,
            headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8" })
        });
    }
};

async function proxySearch(request) {
    if (request.method !== "POST") {
        return methodNotAllowed(["POST"]);
    }

    try {
        const body = await request.text();
        if (!body) {
            return jsonResponse({ ok: false, error: "Missing request body" }, 400);
        }

        const upstream = await fetch(EASTMONEY_SEARCH_API, {
            method: "POST",
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json;charset=UTF-8",
                Origin: "https://xuangu.eastmoney.com",
                Referer: "https://xuangu.eastmoney.com/"
            },
            body
        });

        return relay(upstream);
    } catch (error) {
        return jsonResponse({ ok: false, error: cleanError(error) }, 502);
    }
}

async function proxyQuotes(request) {
    if (request.method !== "GET") {
        return methodNotAllowed(["GET"]);
    }

    try {
        const incomingUrl = new URL(request.url);
        const upstream = await fetchFirstAvailableQuoteApi(incomingUrl.searchParams);
        return relay(upstream);
    } catch (error) {
        return jsonResponse({ ok: false, error: cleanError(error) }, 502);
    }
}

async function fetchFirstAvailableQuoteApi(searchParams) {
    const apis = [EASTMONEY_QUOTE_API, EASTMONEY_QUOTE_FALLBACK_API];
    let lastError = null;

    for (const api of apis) {
        try {
            const upstreamUrl = new URL(api);
            for (const [key, value] of searchParams.entries()) {
                upstreamUrl.searchParams.set(key, value);
            }

            const upstream = await fetch(upstreamUrl.toString(), {
                headers: {
                    Accept: "application/json, text/plain, */*",
                    Origin: "https://quote.eastmoney.com",
                    Referer: "https://quote.eastmoney.com/"
                }
            });
            if (upstream.ok) return upstream;
            lastError = new Error(`Quote upstream HTTP ${upstream.status}`);
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Quote upstream unavailable");
}

async function relay(upstream) {
    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    return new Response(body, {
        status: upstream.status,
        headers: corsHeaders({ "Content-Type": contentType })
    });
}

function methodNotAllowed(allowMethods) {
    return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders({
            Allow: allowMethods.join(", "),
            "Content-Type": "text/plain; charset=utf-8"
        })
    });
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: corsHeaders({
            "Content-Type": "application/json; charset=utf-8"
        })
    });
}

function corsHeaders(extra = {}) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Accept, Content-Type, Origin, Referer, X-Requested-With",
        "Access-Control-Max-Age": "86400",
        "Cache-Control": "no-store",
        ...extra
    };
}

function cleanError(error) {
    const message = String(error && error.message ? error.message : error).replace(/\s+/g, " ");
    return message.slice(0, 160);
}
