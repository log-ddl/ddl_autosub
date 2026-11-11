import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { filterVoices, voiceKey } from "../src/components/tts/voice-catalog";
import { voicePreviewText } from "../src/components/tts/voice-preview-text";
import type { CatalogVoice } from "../src/components/tts/types";
const voices:CatalogVoice[] = JSON.parse(readFileSync(new URL("../src-tauri/resources/tts/voices.json", import.meta.url), "utf8"));
const all={language:"all",gender:"all",query:"",favoritesOnly:false};
test("hidden provider ID still finds the exact voice",()=>{
  const found=filterVoices(voices,{...all,query:" irhapoxlvnw57qjpqh2p "},new Set());
  assert.equal(found.length,1);assert.equal(found[0].id,"IRHApOXLvnW57QJPQH2P");
});
test("favorites and language/gender filters intersect",()=>{
  const male=voices.find(v=>v.provider==="elevenlabs"&&v.language==="en"&&v.gender==="male")!;
  const female=voices.find(v=>v.provider==="elevenlabs"&&v.language==="ar"&&v.gender==="female")!;
  const favorites=new Set([voiceKey(male),voiceKey(female)]);
  assert.equal(filterVoices(voices,{...all,favoritesOnly:true},favorites).length,2);
  assert.deepEqual(filterVoices(voices,{...all,favoritesOnly:true,language:"en",gender:"male"},favorites),[male]);
  assert.equal(filterVoices(voices,{...all,favoritesOnly:true,language:"en",gender:"female"},favorites).length,0);
});
test("favorites never bleed between providers or languages",()=>{
  const voice=voices[0];assert.notEqual(voiceKey(voice),voiceKey({...voice,provider:"capcut"}));
  assert.notEqual(voiceKey(voice),voiceKey({...voice,language:"vi"}));
});
test("every language has translated names and a native preview sample",()=>{
  const en=JSON.parse(readFileSync(new URL("../src/i18n/locales/en/translation.json",import.meta.url),"utf8")).tts.provider;
  const vi=JSON.parse(readFileSync(new URL("../src/i18n/locales/vi/translation.json",import.meta.url),"utf8")).tts.provider;
  for(const language of new Set(voices.map(v=>v.language))){
    assert.ok(en.languages[language]);assert.ok(vi.languages[language]);
    assert.notEqual(en.languages[language],language);assert.notEqual(vi.languages[language],language);
    assert.ok(voicePreviewText(language));
    if(language!=="en")assert.notEqual(voicePreviewText(language),voicePreviewText("en"));
  }
  assert.deepEqual(Object.keys(en).sort(),Object.keys(vi).sort());
});
test("unbundled voice IDs do not create synthetic matches",()=>{
  const elevenVoices=voices.filter(v=>v.provider==="elevenlabs");
  assert.equal(filterVoices(elevenVoices,{...all,query:"CustomVoiceId9999999"},new Set()).length,0);
});
