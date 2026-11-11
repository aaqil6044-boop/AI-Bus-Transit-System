// Kannada page text: every pattern compiles, keeps names and numbers, and covers the live-panel lines.
const test = require("node:test");
const assert = require("node:assert");
global.window = {};
require("../static/i18n.js");
const pack = window.BT_I18N;
const patterns = pack.knPatterns.map(([source, replacement]) => [new RegExp(`^${source}$`), replacement]);
function kn(text) {
    if (Object.prototype.hasOwnProperty.call(pack.kn, text)) return pack.kn[text];
    for (const [pattern, replacement] of patterns) if (pattern.test(text)) return text.replace(pattern, replacement);
    return null;
}

test("all Kannada patterns compile and translate to Kannada", () => {
    assert.ok(patterns.length > 50);
    for (const [, replacement] of pack.knPatterns) assert.match(replacement, /[ಀ-೿]/);
});

test("numbers, times, stop names and route numbers are kept as they are", () => {
    assert.strictEqual(kn("3 stops away"), "3 ನಿಲ್ದಾಣ ದೂರ");
    assert.strictEqual(kn("Leave 8:05 (in 12 min)"), "8:05 ಕ್ಕೆ ಹೊರಡಿ (12 ನಿಮಿಷದಲ್ಲಿ)");
    assert.strictEqual(kn("2 of 5 live, 3 old or untimed"), "5 ರಲ್ಲಿ 2 ಲೈವ್, 3 ಹಳೆಯ ಅಥವಾ ಸಮಯವಿಲ್ಲದವು");
    const board = kn("Board KIA-9 toward Kempegowda Bus Station at Military Dairy Farm FLY (Esteem Mall), scheduled 01:42.");
    for (const kept of ["KIA-9", "Kempegowda Bus Station", "Military Dairy Farm FLY (Esteem Mall)", "01:42"]) assert.ok(board.includes(kept), kept);
    assert.strictEqual(kn("1.4 km straight-line from boarding"), "ಹತ್ತುವ ನಿಲ್ದಾಣದಿಂದ ನೇರ ರೇಖೆಯಲ್ಲಿ 1.4 ಕಿ.ಮೀ");
    assert.strictEqual(kn("towards KR Market"), "KR Market ಕಡೆಗೆ");
    assert.strictEqual(kn("➤ Heading north-east"), "➤ ಈಶಾನ್ಯ ದಿಕ್ಕಿಗೆ ಹೋಗುತ್ತಿದೆ");
});

test("the timetable-not-live warnings stay honest in Kannada", () => {
    assert.match(kn("from the BMTC timetable, not live arrivals"), /ಲೈವ್ ಆಗಮನಗಳಲ್ಲ/);
    assert.match(kn("Scheduled from the BMTC timetable. Not a live arrival: buses can run early, late or not at all."), /ಲೈವ್ ಆಗಮನವಲ್ಲ/);
    assert.strictEqual(kn("STALE"), "ಹಳೆಯದು");
});
