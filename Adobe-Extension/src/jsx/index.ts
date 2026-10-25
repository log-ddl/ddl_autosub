// @include './lib/json2.js'

import { ns } from "../shared/shared";

import * as ppro from "./ppro";

//@ts-ignore
const host = typeof $ !== "undefined" ? $ : window;

// The panel only runs in Premiere Pro (see cep.config.ts).
$.writeln("[AutoSubs] Mapping PPRO functions...");
host[ns] = ppro;

export type Scripts = typeof ppro;
