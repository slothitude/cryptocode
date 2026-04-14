import * as https from "node:https";
import * as http from "node:http";

/**
 * Fetches raw bytes from a URL. Used to obtain pad material from Wikipedia pages.
 * Returns the full response body as a Buffer.
 */
export async function fetchUrl(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const mod = url.startsWith("https") ? https : http;
		const request = mod.get(url, { timeout: 30000 }, (res) => {
			// Follow redirects
			if (
				res.statusCode &&
				res.statusCode >= 300 &&
				res.statusCode < 400 &&
				res.headers.location
			) {
				fetchUrl(res.headers.location).then(resolve).catch(reject);
				return;
			}

			if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
				reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
				return;
			}

			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve(Buffer.concat(chunks)));
			res.on("error", reject);
		});

		request.on("error", reject);
		request.on("timeout", () => {
			request.destroy();
			reject(new Error(`Timeout fetching ${url}`));
		});
	});
}

/**
 * Build a Wikipedia URL from an article title.
 * Handles titles with spaces, special characters, etc.
 */
export function wikipediaUrlFromTitle(title: string): string {
	const encoded = encodeURIComponent(title.replace(/ /g, "_"));
	return `https://en.wikipedia.org/wiki/${encoded}`;
}

/**
 * Extract a Wikipedia article title from a URL.
 */
export function titleFromWikipediaUrl(url: string): string {
	const match = url.match(/\/wiki\/(.+)$/);
	if (!match) throw new Error(`Not a valid Wikipedia URL: ${url}`);
	return decodeURIComponent(match[1]).replace(/_/g, " ");
}
