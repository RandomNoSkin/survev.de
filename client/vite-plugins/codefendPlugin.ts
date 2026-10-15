import * as codefend from "codefend";
import type { Plugin } from "vite";

function randomString() {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = "";
    const length = Math.floor(Math.random() * 4) + 3;
    while (result.length < length) {
        result += chars.at(Math.floor(Math.random() * chars.length));
    }
    return result;
}
const previousStrings = new Set();
function uniqueString() {
    let string = randomString();
    while (previousStrings.has(string)) {
        string = randomString();
    }
    previousStrings.add(string);
    return string;
}

/**
 * codefend renames every `m_<identifier>` it finds by plain text replacement, so the same
 * text inside a longer word gets rewritten too - "/api/custom_map_templates" contains
 * "m_map" (the `m_map` field) and shipped as "/api/custodgplUV_templates". That only
 * shows up in prod, so fail the build instead.
 */
function assertNoMangledSubstrings(code: string, fileName: string) {
    const ids = new Set(code.match(/(?<![a-zA-Z0-9])m(_[a-zA-Z0-9]+)+/g) ?? []);
    const hits: string[] = [];
    for (const id of ids) {
        const re = new RegExp(`[a-zA-Z0-9]${id}`, "g");
        for (const m of code.matchAll(re)) {
            hits.push(`"${code.slice(Math.max(0, m.index - 20), m.index + id.length + 20)}" (${id})`);
            if (hits.length > 10) break;
        }
    }
    if (hits.length) {
        throw new Error(
            `${fileName}: text that contains an m_ identifier would be mangled by codefend - rename it:\n  ${hits.join("\n  ")}`,
        );
    }
}

export function codefendPlugin(): Plugin {
    const runtimeOptions = codefend.buildRuntimeOptions();
    return {
        name: "codefend-plugin",
        renderChunk(code, chunk) {
            assertNoMangledSubstrings(code, chunk.fileName);
            return codefend.obfuscate(
                code,
                {
                    prefix: "_0x",
                    static: [],
                    ignore: [],
                    pool: Array.from({ length: 500 }, uniqueString),
                },
                {
                    name: "codeOnly",
                    regexList: [
                        {
                            name: "main",
                            regex: /(?<![a-zA-Z0-9])m((_[a-zA-Z0-9]+)+)/g,
                        },
                    ],
                },
                runtimeOptions,
            );
        },
        generateBundle() {
            codefend.stats({ stats: false }, runtimeOptions);
        },
    };
}
