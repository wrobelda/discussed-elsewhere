// Live lookup against the real endpoints; prints what each source found.
import { discover } from "../src/discussed-elsewhere.js";
const url = process.argv[2] || "https://dawidwrobel.com/journal/initializing-lte-modem-using-raw-usb-communication/";
const started = Date.now();
const { discussions, errors } = await discover(url);
console.log(`${url}\n${Date.now() - started} ms`);
for (const d of discussions) console.log(`- ${d.label}: ${d.comments} comments, score ${d.score}, ${d.posts} post(s) → ${d.url}`);
for (const e of errors) console.log(`! ${e.source}: ${e.error?.message || e.error}`);
