/* HTPC Display skill - index.js (Alexa-hosted, Node.js)
 * Fetches HTPC activity state and renders an APL now-playing screen.
 */
const Alexa = require('ask-sdk-core');
const https = require('https');

const STATE_URL = 'https://YOUR-ADDRESS/htpcart/state?k=YOUR-KEY';
const KEEPALIVE_URL = 'https://YOUR-ADDRESS/htpcart/keepalive.mp4?k=YOUR-KEY';
const SILENCE_URL = 'https://YOUR-ADDRESS/htpcart/silence.mp3?k=YOUR-KEY';
// 'apl' = designed APL screen only (no native card). 'audio' = native card only. 'rich' = APL then card handoff.
const DISPLAY_MODE = 'apl';
// Reuse the TLS connection across the frequent /state polls so each fetch skips the
// TCP+TLS handshake (~100-300ms saved per fetch while the container is warm). A cold
// launch still pays one fresh handshake - that slice of the gap is Alexa's, not ours.
const stateAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// How often the on-screen document phones home (SendEvent -> UserEvent -> /state fetch).
// Two jobs: (a) drift-correction sync, (b) HEARTBEAT - every fetch stamps the watcher's
// LastStateReqTicks, and the watcher reclaims the screen (re-pulse via HA) when the
// heartbeat goes silent while media is active, i.e. the media screen was dismissed or
// replaced by something else. History: this was 1000ms and every response carried
// directives, which kept re-pinning Alexa's pulldown panel with the skill attribution
// (the 'stuck pulldown'). Now the steady-state response is EMPTY (see AplUserEventHandler:
// the doc reports its Pos/Paused in the event arguments, and an in-sync doc gets no
// directives back), so a 6s cadence stays panel-friendly while giving the watcher a
// tight detection window. Overlays that merely COVER the doc leave the heartbeat running,
// so temporary 2-3s messages are never cut short - only a killed screen triggers reclaim.
const SYNC_INTERVAL_MS = 15000;
// Device-direct heartbeat: an invisible Image refetches /state?hb=N straight from the
// watcher every beat - no Alexa cloud, no skill lambda, no session politics. Log-proven
// need: after a render, SendEvent -> UserEvent delivery dies on-device, so the skill
// round-trip cannot be the liveness signal. Image fetches stamp LastStateReqTicks in the
// C# server directly, and APL suspends tick handlers when the doc is not on duty, so
// fetches == 'doc alive': exactly what the watcher's reclaim detector needs.
const HB_INTERVAL_MS = 2000;             // aggressive floor: 2s beats let the watcher declare death at 5s
                                         // (>= 2.5x beat, so one delayed beat can never false-trigger a
                                         // mid-playback re-render). Cost: one ~600-byte LAN fetch per beat.

// --- Progress bar / play-pause / time-label sizing -------------------------------
// Flip PROGRESS_SCALE to compare size steps on-device (redeploy after each change):
//   'base' = original, 'A' = conservative bump, 'B' = medium, 'C' = largest.
const PROGRESS_SCALE = 'B';
const PBAR_PRESETS = {
    base: { icon: 28, barH: 6, barR: 3, rowH: 28, gap: 19, labelPt: 2, labelFs: 23 },
    A:    { icon: 32, barH: 7, barR: 4, rowH: 32, gap: 22, labelPt: 2, labelFs: 26 },
    B:    { icon: 36, barH: 8, barR: 4, rowH: 36, gap: 24, labelPt: 3, labelFs: 30 },
    C:    { icon: 40, barH: 9, barR: 5, rowH: 40, gap: 27, labelPt: 3, labelFs: 33 }
};
const PBAR = PBAR_PRESETS[PROGRESS_SCALE] || PBAR_PRESETS.base;

// --- Source icon sizing (logo precedes the app name; larger than the 40dp text) -----------
// Flip ICON_SCALE to compare on-device: 'base' = original (icon smaller than text),
// 'A' = conservative larger, 'B' = midway between A and the earlier larger step. Gap
// icon width is scaled in buildDatasource so the logo's aspect ratio is preserved.
const ICON_SCALE = 'B';
const ICON_PRESETS = {
    base: { h: 36, gap: 28 },
    A:    { h: 44, gap: 34 },
    B:    { h: 48, gap: 37 }
};
const ICON = ICON_PRESETS[ICON_SCALE] || ICON_PRESETS.base;

// --- Clock (top-right) --------------------------------------------------------------
// Familiar media-info treatment: time over date, right-aligned, sitting diagonally
// opposite the source pill so the top row reads as a matched pair. The sizes are not
// invented - the time reuses the source pill's app-name type (40dp / weight 600 / white)
// and the date reuses the subtitle's (30dp / #B8BDC7), so the primary-over-secondary
// relationship matches the title/subtitle stack below it.
// localTime is device-local milliseconds since epoch with the timezone offset and DST
// already applied by the device, so the Show renders PST/PDT itself: no watcher field, no
// skill round-trip, and no RenderDocument - the binding re-evaluates on-device, which
// matters given how much of this document exists to avoid re-renders. Amazon publishes no
// AM/PM formatting code (the codes return digits only), so the meridiem is appended using
// their documented Time.hours() bind-and-concatenate pattern. 'M/D/YY' is a native format
// string and is already unpadded: 4/23/26, not 04/23/26.
// The halos are one step stronger than each line's type-peer because this is the only
// text in the document with neither a pill nor the bottom gradient behind it - it sits on
// raw artwork. Same reasoning as TAG_HALO above: a dark halo is invisible on dark artwork
// and only helps on bright artwork, so it cannot regress any existing case.
const CLOCK_TOP = 64;                    // <-- DIAL: baseline-matched to the pill, not top-matched.
                                         // The pill is a bordered chip whose label sits 26dp below
                                         // its frame top; bare text has no such inset, so equal top
                                         // values would leave the two labels visibly out of line.
                                         // Measured from a render: capTop = top + 0.275*fontSize and
                                         // capHeight = 0.70*fontSize. Pill label baseline at
                                         // PILL_TOP+56 = 112; a 48dp clock at top 64 lands at 111.
                                         // Keep this exactly 8dp below PILL_TOP when moving the row.
const CLOCK_TIME_FS = 48;                // one step above the pill's 40dp app name, below the
                                         // 52dp title, and on the 8dp grid
const CLOCK_TIME_WEIGHT = '600';         // same weight as the app name
const CLOCK_TIME_COLOR = '#FFFFFF';
const CLOCK_DATE_FS = 30;                // matches the subtitle line exactly
const CLOCK_DATE_COLOR = '#B8BDC7';      // matches the subtitle colour exactly
const CLOCK_GAP = 2;                     // <-- DIAL: leading between the two lines

// --- Tag pill vertical metrics ----------------------------------------------------
// textAlignVertical centres the LINE BOX, not the glyphs. A 30dp line box reserves
// descender space that all-caps labels (RTX, Reflex, HDR10, 4K, LIVE) never use, so
// they render visually high. Making the top padding 2dp greater than the bottom shifts
// the text box down by exactly half that - 1dp - which optically centres cap-height
// text, and also makes the pill 2dp taller. Both tag layouts share these values, so
// every tag on every source stays identical.
const TAG_PAD_TOP = 6;                   // <-- DIAL: raise to push text further down
const TAG_PAD_BOTTOM = 4;                //     (optical offset = (top - bottom) / 2)
const TAG_ROW_OUTDENT = 16;              // MIDPOINT alignment: halfway between edge-align (8) and
                                         // text-align (24 = TAG_PAD_X): the pill overshoots the title
                                         // edge while its label stays left of the text line. Implemented as: bottom
                                         // stack shifted left by this amount, every row EXCEPT the tag row
                                         // padded back right (negative offsets are clamped by the core).

// --- Tag text: subtle dimensional white --------------------------------------------
// APL Text has no gradient fill, so a true per-glyph gradient is not possible. Instead
// the label is drawn as three offset copies - a cool shade 1dp low, a bright bloom 1dp
// high at partial opacity, and the main white fill on top. The main copy hides the middle
// of both, leaving a soft dark lower edge and a lifted upper edge, which gives the glyphs
// a slight silver/pearl dimensionality without tinting them. Offsets stay at 1dp so it
// reads as a sheen, not an outline. Same technique the source-pill label already uses.
const TAG_TEXT = '#FFFFFF';              // main fill - the original white
const TAG_TEXT_HI = '#FFFFFF';           // upper bloom
const TAG_TEXT_LO = '#6C727C';           // lower shade (cool neutral, reads as silver)
const TAG_TEXT_HI_OPACITY = 0.5;         // <-- DIAL: sheen strength (0 = off)
// Dark halo on the main copy. A near-opaque, wide, centred shadow acts as a soft outline,
// so legibility comes from the glyph's own edge rather than from the backdrop. This is
// deliberately a TEXT-side fix: the scrim formula targets a composited luminance of ~128,
// which only yields ~3.8:1 against white text (less on the brightest pixels), and lowering
// that target would darken every bright-background pill. A dark halo is invisible on dark
// artwork and only helps on bright artwork, so it cannot regress any existing case.
const TAG_HALO = '#000000E6';            // <-- DIAL: halo colour/opacity
const TAG_HALO_RADIUS = '6dp';           // <-- DIAL: halo spread (3dp = old, subtle)
function tagLabel(textExpr) {
    const base = { type: 'Text', text: textExpr, fontSize: '30dp', height: '39dp', textAlign: 'center', textAlignVertical: 'center' };
    return {
        type: 'Container',
        items: [
            Object.assign({}, base, { color: TAG_TEXT_LO, position: 'absolute', left: '0dp', top: '1dp' }),
            Object.assign({}, base, { color: TAG_TEXT_HI, position: 'absolute', left: '0dp', top: '-1dp', opacity: TAG_TEXT_HI_OPACITY }),
            Object.assign({}, base, { color: TAG_TEXT, shadowColor: TAG_HALO, shadowHorizontalOffset: '0dp', shadowVerticalOffset: '1dp', shadowRadius: TAG_HALO_RADIUS })
        ]
    };
}

// --- Source pill 'frosted glass' backdrop ------------------------------------------
// APL has no backdrop-filter: nothing can blur what is BEHIND a component. The only
// blur available is the Image 'Blur' filter, so the pill draws a second copy of the
// same artwork, blurred, offset so it lines up pixel-for-pixel with the real
// background, and lets the pill's own bounds clip it (in APL the calculated component
// width/height ARE the clipping boundary). The adaptive scrim is then applied to that
// same Image via overlayColor, so blur + tint cost exactly one component.
// Offsets are computed here (build time) rather than bound at runtime so there is no
// expression that can fail to evaluate on-device.
const VP_W = 1920;                       // Echo Show 11 logical width (dp)
const VP_H = 1200;                       // Echo Show 11 logical height (dp)
const PILL_INSET = 64;                   // unified horizontal safe inset (both sides + pill top).
                                         // 96dp (5vw) was TV-overscan-era sizing; modern 10-ft media
                                         // UIs (Netflix/Google TV class) run 58-64dp keylines at this
                                         // resolution, and the Show is viewed nearer than a TV. All
                                         // frosted-glass registration derives from this constant.
const PILL_TOP = 56;                     // <-- DIAL: vertical inset for the top row, decoupled from
                                         // the horizontal keyline (64dp), which the tag row and the
                                         // bottom stack derive from and must not move. 56dp sits on
                                         // Material's 8dp baseline grid and well above MD3's 24dp
                                         // large-screen minimum, while dropping part of the 10-ft-TV
                                         // overscan allowance a near-viewed panel does not need.
                                         // 48 was tried and read as too high; 64 was the original.
                                         // Get-SourcePillRect in the watcher samples the pill's
                                         // luminance footprint and MUST track this value.
const PILL_BORDER = 0;                   // pill has no border: APL insets a Frame's
                                         // content by borderWidth, which held the blur 1dp
                                         // short of the edge and exposed a hard ring.
// Blur strength now lives in the watcher ($PillBlurStrength) - the artwork arrives
// already blurred, so no APL filter is involved.

function silencePlayDirective(h, behavior, prevToken) {
    const meta = { title: h.title || 'HTPC', subtitle: (h.app ? h.app + '  -  ' : '') + (h.line2 || '') };
    if (h.hasArt) {
        meta.art = { sources: [{ url: h.art }] };
        meta.backgroundImage = { sources: [{ url: h.art }] };
    }
    const d = {
        type: 'AudioPlayer.Play',
        playBehavior: behavior,
        audioItem: {
            stream: {
                url: SILENCE_URL + '&n=' + Date.now(),
                token: 'htpcSilence-' + Date.now(),
                offsetInMilliseconds: 0
            },
            metadata: meta
        }
    };
    if (behavior === 'ENQUEUE' && prevToken) { d.audioItem.stream.expectedPreviousToken = prevToken; }
    return d;
}

function telemetry(tag) {
    // fire-and-forget: surfaces Alexa-side lifecycle events in the watcher's [req] log
    try { https.get(STATE_URL + '&' + tag, { agent: stateAgent }, () => {}).on('error', () => {}); } catch (e) { }
}

function fetchState(retryOnError) {
    if (retryOnError === undefined) { retryOnError = true; }
    return new Promise((resolve) => {
        const req = https.get(STATE_URL, { agent: stateAgent, timeout: 4000 }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        });
        // A reused keep-alive socket can be closed server-side between polls; on that
        // fast error retry once with a fresh connection so a transient reset can't
        // collapse a launch to the idle/clear path. Timeouts are NOT retried (they
        // already waited) to avoid stacking delay onto the launch.
        req.on('error', () => { if (retryOnError) { fetchState(false).then(resolve); } else { resolve(null); } });
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) { return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'); }
    return m + ':' + String(ss).padStart(2, '0');
}

function buildDatasource(st) {
    if (!st) { st = { mode: 'idle', app: '', title: '', line2: '', hdr: false, art: '', pos: 0, dur: 0 }; }
    // dead-man's switch: if the watcher crashed, its 'updated' timestamp stops
    // advancing. A stale state (>60s old) is treated as idle so the Echo clears
    // the stuck media screen on the next sync instead of showing it forever.
    if (st.updated) {
        const ageMs = Date.now() - Date.parse(st.updated);
        if (isFinite(ageMs) && ageMs > 60000) {
            st = { mode: 'idle', app: '', title: '', line2: '', hdr: false, art: '', pos: 0, dur: 0 };
        }
    }
    const mode = st.mode || 'idle';
    const dur = Number(st.dur) || 0;
    const pos = Math.min(Number(st.pos) || 0, dur > 0 ? dur : Number(st.pos) || 0);
    let pct = 0;
    if (dur > 0) { pct = Math.max(0, Math.min(100, Math.round((pos / dur) * 100))); }
    let timeLeft = '';
    let timeRight = '';
    if (mode === 'gfn') {
        timeLeft = 'Playing for ' + fmtTime(pos);
    } else if (dur > 0) {
        timeLeft = fmtTime(pos);
        timeRight = fmtTime(dur);
    }
    // Title horizontal ticker: the title stays on ONE line. If its estimated width exceeds the
    // ~90vw column, slide it left to reveal the tail on a standard pause -> scroll -> pause ->
    // cycle loop (~70 dp/s, 2s dwell at each end). Titles that fit stay static. T_CHW (avg glyph
    // advance at 52dp) is the tuning dial if the trigger point feels early/late on real titles.
    const titleStr = (mode === 'idle') ? 'HTPC idle' : (st.title || '');
    const T_CHW = 28, T_COLW = 1728;              // avg glyph advance @52dp / column width (dp)
    const titleOver = (titleStr.length * T_CHW) - T_COLW;
    const titleScroll = titleOver > 24;
    const titleScrollDist = titleScroll ? (titleOver + 48) : 0;   // +tail margin so last chars clear
    const titleScrollDur = Math.max(1500, Math.round(titleScrollDist / 70 * 1000));
    const titleResetDur = Math.min(1500, Math.max(500, Math.round(titleScrollDist / 450 * 1000)));  // quick smooth reset
    // Explicit, over-generous render width so the one-line Text is NEVER width-constrained
    // (a constrained maxLines:1 Text truncates with an ellipsis, then scrolls the '...').
    const titleBoxW = titleStr.length * 48 + 80;
    // Timeline color: YouTube (video+music) and Netflix get their recognizable red; others keep gold.
    const appLC = (st.app || '').toLowerCase();
    const barColor = (appLC.indexOf('youtube') !== -1 || appLC.indexOf('netflix') !== -1) ? '#FF0000' : '#E0A33C';
    // ---- tag-row frosted-glass registration -----------------------------------------
    // Each tag pill shows the same blurred backdrop as the source pill, but unlike that
    // pill its screen position is not fixed: the row is bottom-anchored (so its Y depends
    // on which rows are visible beneath it) and every pill sits at a different X. Both
    // offsets are therefore resolved here, where the visibility flags are known, and handed
    // to the Pill layout so each pill's blur lines up with the background behind it.
    const TAG_PAD_X = 24, TAG_GAP = 14, TAG_FS = 30;
    function tagTextW(str) {
        let w = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charAt(i);
            if (c === ' ') { w += 0.26 * TAG_FS; }
            else if (c >= 'A' && c <= 'Z') { w += 0.62 * TAG_FS; }
            else if (c >= '0' && c <= '9') { w += 0.57 * TAG_FS; }
            else { w += 0.52 * TAG_FS; }
        }
        return w;
    }
    function tagPillW(label) { return Math.round(tagTextW(label) + TAG_PAD_X * 2); }

    const showBarB = dur > 0 && mode !== 'gfn' && mode !== 'idle';
    const line2B = (st.line2 || '') !== '';
    // distance from the tag row's BOTTOM edge down to the bottom of the screen
    let tagBelow = Math.round(VP_H * 0.05) + 32 + 70;          // 5vh inset + title gap + title clip
    if (line2B) { tagBelow += 12 + 38; }                        // subtitle: paddingTop + line
    if (showBarB) { tagBelow += 32 + PBAR.rowH + PBAR.labelPt + 38; }
    if (mode === 'gfn') { tagBelow += 24 + 28; }                // GFN detail line
    const tagYOff = -tagBelow;

    let tagX = 0;
    const tagOff = { live: 0, rtx: 0, reflex: 0, atmos: 0, res: 0, hdr: 0 };
    function placeTag(key, w) { tagOff[key] = -(PILL_INSET - TAG_ROW_OUTDENT + tagX); tagX += w + TAG_GAP; }
    if (st.live) { placeTag('live', Math.round(20 + 10 + tagTextW('LIVE') + TAG_PAD_X * 2)); }
    if (st.rtx) { placeTag('rtx', tagPillW('RTX')); }
    if (st.reflex) { placeTag('reflex', tagPillW('Reflex')); }
    if (st.atmos) { placeTag('atmos', tagPillW('Dolby Atmos')); }
    if (st.res) { placeTag('res', tagPillW(String(st.res))); }
    if (st.hdr) { placeTag('hdr', tagPillW('HDR10')); }

    return {
        htpc: {
            pos: pos,
            dur: dur,
            wide: !!st.wide,
            paused: !!st.paused,
            iconUrl: (st.icon ? 'https://YOUR-ADDRESS/htpcart/icon/' + st.icon + '.png?k=YOUR-KEY&v=' + (st.iconv || '0') : ''),
            iconw: Math.round((Number(st.iconw) || 36) * ICON.h / 36),
            mode: mode,
            app: st.app || '',
            title: (mode === 'idle') ? 'HTPC idle' : (st.title || ''),
            line2: st.line2 || '',
            hdr: !!st.hdr,
            live: !!st.live,
            rtx: !!st.rtx,
            reflex: !!st.reflex,
            res: st.res || '',
            atmos: !!st.atmos,
            art: st.art || '',
            artBlur: st.artBlur || '',
            tagYOff: tagYOff,
            tagOffLive: tagOff.live,
            tagOffRtx: tagOff.rtx,
            tagOffReflex: tagOff.reflex,
            tagOffAtmos: tagOff.atmos,
            tagOffRes: tagOff.res,
            tagOffHdr: tagOff.hdr,
            scrim: (st.scrim && /^#[0-9A-Fa-f]{8}$/.test(st.scrim)) ? st.scrim : '#00000035',
            scrimTag: (st.scrimTag && /^#[0-9A-Fa-f]{8}$/.test(st.scrimTag)) ? st.scrimTag : '#00000035',
            border: (st.border && /^#[0-9A-Fa-f]{8}$/.test(st.border)) ? st.border : '#FFFFFF3F',
            // Tag-pill border: same derivation as `border`, but sampled under the tag row.
            // Falls back to fully transparent so this document is a visual no-op until the
            // watcher starts publishing borderTag.
            borderTag: (st.borderTag && /^#[0-9A-Fa-f]{8}$/.test(st.borderTag)) ? st.borderTag : '#00000000',
            hasArt: !!(st.art && st.art.length > 0),
            hasBlur: !!(st.artBlur && st.artBlur.length > 0),
            isMusic: mode === 'music',
            showBar: dur > 0 && mode !== 'gfn' && mode !== 'idle',
            pct: pct,
            barWidth: pct + '%',
            timeLeft: timeLeft,
            timeRight: timeRight,
            titleScroll: titleScroll,
            titleScrollTo: -titleScrollDist,
            titleScrollDur: titleScrollDur,
            titleBoxW: titleBoxW,
            titleResetDur: titleResetDur,
            barColor: barColor,
            dbg: 'v65j'
        }
    };
}

const APL_DOC = {
    type: 'APL',
    version: '2023.3',
    graphics: {
        PlayG: {
            type: 'AVG', version: '1.2', width: 24, height: 24,
            items: [{ type: 'path', pathData: 'M6,3 L6,21 L21,12 z', fill: '#E6E8EB' }]
        },
        PauseG: {
            type: 'AVG', version: '1.2', width: 24, height: 24,
            items: [{ type: 'path', pathData: 'M7,4 h4 v16 h-4 z M14,4 h4 v16 h-4 z', fill: '#E6E8EB' }]
        }
    },
    settings: { idleTimeout: 900000 },
    // The device tells the doc when it is no longer the visible experience (home screen,
    // ambient clock, another skill). Without this the doc stays alive-but-invisible behind
    // the takeover: its heartbeat keeps running, so the watcher's silence detector never
    // fires, and every launch hits the token-match 'no redraw' branch - the exact stuck
    // state observed. The heartbeat now carries this so the skill can self-reclaim.
    onDisplayStateChange: [{
        type: 'SetValue', componentId: 'root', property: 'DispState', value: '${event.displayState}'
    }],
    // Idle command loop: a document executing a command is never inactive,
    // so the device idle timeout never engages (Amazon dev-forum technique)
    onMount: [{
        type: 'Sequential',
        repeatCount: 999999,
        commands: [{ type: 'Idle', delay: 60000 }]
    }],
    mainTemplate: {
        parameters: ['payload'],
        items: [{
            type: 'Container',
            id: 'root',
            bind: [
                { name: 'Pos', type: 'number', value: '${payload.htpc.pos}' },
                { name: 'PausedB', type: 'boolean', value: '${payload.htpc.paused}' },
                { name: 'DispState', value: 'foreground' },
                { name: 'Tick', type: 'number', value: 0 },
                { name: 'HbN', type: 'number', value: 0 },
                { name: 'BgBeats', type: 'number', value: 0 }
            ],
            // SINGLE handler: this device silently ignores every entry after the first
            // in a multi-handler handleTick array. All three cadences are therefore
            // driven off one 1s handler, gated by a Tick counter (HB every 2 ticks,
            // sync every 15). Commands run in order, so Tick is already current below.
            handleTick: [
                {
                    minimumDelay: 1000,
                    commands: [
                        { type: 'SetValue', componentId: 'root', property: 'Tick', value: '${Tick + 1}' },
                        {
                            type: 'SetValue',
                            when: '${payload.htpc.showBar && !PausedB && Pos < payload.htpc.dur}',
                            property: 'Pos',
                            value: '${Pos + 1}'
                        },
                        {
                            type: 'SetValue',
                            when: '${Tick % 2 == 0}',
                            componentId: 'root',
                            property: 'HbN',
                            value: '${HbN + 1}'
                        },
                        {
                            type: 'SetValue',
                            when: '${Tick % 15 == 0}',
                            componentId: 'root',
                            property: 'BgBeats',
                            value: "${DispState == 'foreground' ? 0 : BgBeats + 1}"
                        },
                        {
                            type: 'SendEvent',
                            when: '${Tick % 15 == 0}',
                            sequencer: 'syncSeq',
                            arguments: ['sync', '${Pos}', '${PausedB}', '${DispState}', '${BgBeats}']
                        }
                    ]
                }
            ],
            width: '100vw',
            height: '100vh',
            items: [
                {
                    type: 'Frame',
                    position: 'absolute',
                    width: '100vw',
                    height: '100vh',
                    backgroundColor: '#000000'
                },
                {
                    // heartbeat beacon: source changes with HbN, forcing a real device HTTP
                    // fetch each beat. /state returns JSON (not an image) - the decode fails
                    // silently, but the request has already stamped the watcher. 2dp at 0.004
                    // opacity: invisible, zero layout impact.
                    type: 'Image',
                    when: "${payload.htpc.mode != 'idle'}",
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '2dp',
                    height: '2dp',
                    opacity: 0.004,
                    source: 'https://YOUR-ADDRESS/htpcart/state?k=YOUR-KEY&hb=${HbN}'
                },
                {
                    type: 'Image',
                    when: '${payload.htpc.hasArt}',
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100vw',
                    height: '100vh',
                    source: '${payload.htpc.art}',
                    scale: "${payload.htpc.wide ? 'fill' : 'best-fit'}",
                    align: 'center'
                },
                {
                    type: 'Frame',
                    position: 'absolute',
                    bottom: 0,
                    width: '100vw',
                    height: '52vh',
                    background: {
                        type: 'linear',
                        angle: 180,
                        colorRange: ['#00000000', '#00000005', '#00000010', '#00000022', '#0000003F', '#0000007D', '#000000AD', '#000000D1', '#000000E4'],
                        inputRange: [0, 0.12, 0.25, 0.37, 0.47, 0.59, 0.71, 0.85, 1]
                    }
                },
                {
                    type: 'Frame',
                    when: "${payload.htpc.app != '' && payload.htpc.mode != 'idle'}",
                    position: 'absolute',
                    top: PILL_TOP + 'dp',
                    left: PILL_INSET + 'dp',
                    backgroundColor: "${payload.htpc.hasBlur && payload.htpc.wide ? '#00000000' : payload.htpc.scrim}",
                    borderRadius: '15.4dp',
                    borderWidth: '2dp',
                    borderColor: '${payload.htpc.border}',
                    shadowColor: '#00000073',
                    shadowHorizontalOffset: '0dp',
                    shadowVerticalOffset: '4dp',
                    shadowRadius: '14dp',
                    items: [{
                        // This wrapper fills the ENTIRE pill (the padding now lives on the row
                        // below), so the frosted layer can reach the pill's edges. A component
                        // clips its children to its own bounds - when the padding sat on the
                        // Frame, this wrapper was inset by it and the blur appeared as a small
                        // square patch hugging the text. Flush to the Frame, the Frame's
                        // borderRadius does the clipping and the rounded corners are preserved.
                        type: 'Container',
                        items: [
                            {
                                // Frosted backdrop: the pre-blurred artwork, shifted up/left by the
                                // pill's inset (+1dp border) so it registers exactly with the real
                                // background behind the pill. Absolutely positioned, so it does not
                                // affect the pill's auto-sizing. Falls back to the Frame's flat scrim
                                // when there is no artwork (Netflix) or when the art is letterboxed
                                // (wide=false, e.g. portrait YouTube Shorts), where the pill sits in
                                // the letterbox and a partial overlap would show a hard seam.
                                type: 'Image',
                                when: '${payload.htpc.hasBlur && payload.htpc.wide}',
                                position: 'absolute',
                                left: '-' + (PILL_INSET + PILL_BORDER) + 'dp',
                                top: '-' + (PILL_TOP + PILL_BORDER) + 'dp',
                                width: '100vw',
                                height: '100vh',
                                source: '${payload.htpc.artBlur}',
                                scale: 'fill',
                                align: 'center',
                                overlayColor: '${payload.htpc.scrim}'
                            },
                            {
                                type: 'Container',
                                direction: 'row',
                                alignItems: 'center',
                                paddingLeft: '28dp',
                                paddingRight: '28dp',
                                paddingTop: '15dp',
                                paddingBottom: '15dp',
                                items: [
                            {
                                type: 'Image',
                                when: "${payload.htpc.iconUrl != ''}",
                                source: '${payload.htpc.iconUrl}',
                                width: '${payload.htpc.iconw}dp',
                                height: ICON.h + 'dp',
                                scale: 'best-fit'
                            },
                            {
                                type: 'Frame',
                                when: "${payload.htpc.iconUrl != ''}",
                                width: ICON.gap + 'dp',
                                height: '1dp'
                            },
                            {
                                type: 'Text',
                                text: '${payload.htpc.app}',
                                fontSize: '40dp',
                                fontWeight: '600',
                                color: '#FFFFFF',
                                shadowColor: '#000000E6',
                                shadowHorizontalOffset: '0dp',
                                shadowVerticalOffset: '1dp',
                                shadowRadius: '8dp'
                            }
                                ]
                            }
                        ]
                    }]
                },
                {
                    // Clock: top-right, baseline-matched to the source pill on the opposite
                    // corner. Gated on mode like every other element.
                    // Legibility: this is the only text in the document with neither a pill nor
                    // the bottom gradient behind it, so both lines use the SAME two-layer
                    // technique as the title - a dark copy offset down-right, then the real
                    // glyphs with a wide near-opaque halo on top. The offset copy reads as a
                    // drop shadow on flat artwork and as a hard edge on busy artwork, which is
                    // where a halo alone starts to fail. Colours, halos and offsets are lifted
                    // verbatim from the title (#000000A8 / #000000EC / 11dp) and the subtitle
                    // (#B8BDC7 / #000000D9 / 6dp) so nothing new is introduced to the palette.
                    // Time is self-contained rather than bind-driven so both copies evaluate
                    // identically with no dependency on binding propagation.
                    type: 'Container',
                    when: "${payload.htpc.mode != 'idle'}",
                    position: 'absolute',
                    top: CLOCK_TOP + 'dp',
                    right: PILL_INSET + 'dp',
                    alignItems: 'end',
                    items: [
                        {
                            type: 'Container',
                            items: [
                                {
                                    type: 'Text',
                                    text: "${Time.format('h:mm', localTime) + (Time.hours(localTime) >= 12 ? ' PM' : ' AM')}",
                                    fontSize: CLOCK_TIME_FS + 'dp',
                                    fontWeight: CLOCK_TIME_WEIGHT,
                                    color: '#000000A8',
                                    position: 'absolute',
                                    left: '3dp',
                                    top: '3dp'
                                },
                                {
                                    type: 'Text',
                                    text: "${Time.format('h:mm', localTime) + (Time.hours(localTime) >= 12 ? ' PM' : ' AM')}",
                                    fontSize: CLOCK_TIME_FS + 'dp',
                                    fontWeight: CLOCK_TIME_WEIGHT,
                                    color: CLOCK_TIME_COLOR,
                                    shadowColor: '#000000EC',
                                    shadowHorizontalOffset: '0dp',
                                    shadowVerticalOffset: '2dp',
                                    shadowRadius: '11dp'
                                }
                            ]
                        },
                        {
                            type: 'Container',
                            paddingTop: CLOCK_GAP + 'dp',
                            items: [
                                {
                                    type: 'Text',
                                    text: "${Time.format('M/D/YY', localTime)}",
                                    fontSize: CLOCK_DATE_FS + 'dp',
                                    color: '#000000A8',
                                    position: 'absolute',
                                    left: '2dp',
                                    top: '2dp'
                                },
                                {
                                    type: 'Text',
                                    text: "${Time.format('M/D/YY', localTime)}",
                                    fontSize: CLOCK_DATE_FS + 'dp',
                                    color: CLOCK_DATE_COLOR,
                                    shadowColor: '#000000D9',
                                    shadowHorizontalOffset: '0dp',
                                    shadowVerticalOffset: '1dp',
                                    shadowRadius: '6dp'
                                }
                            ]
                        }
                    ]
                },
                {
                    type: 'Container',
                    when: "${payload.htpc.mode != 'idle'}",
                    position: 'absolute',
                    bottom: '5vh',
                    left: (PILL_INSET - TAG_ROW_OUTDENT) + 'dp',
                    right: PILL_INSET + 'dp',
                    items: [
                        {
                            type: 'Container',
                            direction: 'row',
                            items: [
                                { type: 'LivePill', when: '${payload.htpc.live}', xoff: '${payload.htpc.tagOffLive}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: '${payload.htpc.live}', width: '14dp', height: '1dp' },
                                { type: 'Pill', when: '${payload.htpc.rtx}', label: 'RTX', xoff: '${payload.htpc.tagOffRtx}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: '${payload.htpc.rtx}', width: '14dp', height: '1dp' },
                                { type: 'Pill', when: '${payload.htpc.reflex}', label: 'Reflex', xoff: '${payload.htpc.tagOffReflex}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: '${payload.htpc.reflex}', width: '14dp', height: '1dp' },
                                { type: 'Pill', when: '${payload.htpc.atmos}', label: 'Dolby Atmos', xoff: '${payload.htpc.tagOffAtmos}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: '${payload.htpc.atmos}', width: '14dp', height: '1dp' },
                                { type: 'Pill', when: "${payload.htpc.res != ''}", label: '${payload.htpc.res}', xoff: '${payload.htpc.tagOffRes}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: "${payload.htpc.res != ''}", width: '14dp', height: '1dp' },
                                { type: 'Pill', when: '${payload.htpc.hdr}', label: 'HDR10', xoff: '${payload.htpc.tagOffHdr}', yoff: '${payload.htpc.tagYOff}' },
                                { type: 'Frame', when: '${payload.htpc.hdr}', width: '14dp', height: '1dp' }
                            ]
                        },
                        {
                            type: 'Container',
                            paddingTop: '32dp',
                            paddingLeft: TAG_ROW_OUTDENT + 'dp',
                            items: [{
                                type: 'Frame',
                                width: '100%',
                                height: '70dp',
                                onMount: [
                                    {
                                        type: 'Sequential',
                                        when: '${payload.htpc.titleScroll}',
                                        commands: [
                                        { type: 'Idle', delay: 1500 },
                                        { type: 'AnimateItem', componentId: 'titleScroller', duration: '${payload.htpc.titleScrollDur}', easing: 'linear', value: [{ property: 'transform', from: [{ translateX: 0 }], to: [{ translateX: '${payload.htpc.titleScrollTo}' }] }] },
                                        { type: 'SetValue', componentId: 'titleScroller', property: 'transform', value: [{ translateX: '${payload.htpc.titleScrollTo}' }] },
                                        { type: 'Idle', delay: 2000 },
                                        { type: 'AnimateItem', componentId: 'titleScroller', duration: '${payload.htpc.titleResetDur}', easing: 'ease-in-out', value: [{ property: 'transform', from: [{ translateX: '${payload.htpc.titleScrollTo}' }], to: [{ translateX: 0 }] }] },
                                        { type: 'SetValue', componentId: 'titleScroller', property: 'transform', value: [{ translateX: 0 }] }
                                        ]
                                    },
                                    {
                                        type: 'Sequential',
                                        when: '${payload.htpc.titleScroll}',
                                        repeatCount: -1,
                                        commands: [
                                        { type: 'Idle', delay: 5000 },
                                        { type: 'AnimateItem', componentId: 'titleScroller', duration: '${payload.htpc.titleScrollDur}', easing: 'linear', value: [{ property: 'transform', from: [{ translateX: 0 }], to: [{ translateX: '${payload.htpc.titleScrollTo}' }] }] },
                                        { type: 'SetValue', componentId: 'titleScroller', property: 'transform', value: [{ translateX: '${payload.htpc.titleScrollTo}' }] },
                                        { type: 'Idle', delay: 2000 },
                                        { type: 'AnimateItem', componentId: 'titleScroller', duration: '${payload.htpc.titleResetDur}', easing: 'ease-in-out', value: [{ property: 'transform', from: [{ translateX: '${payload.htpc.titleScrollTo}' }], to: [{ translateX: 0 }] }] },
                                        { type: 'SetValue', componentId: 'titleScroller', property: 'transform', value: [{ translateX: 0 }] }
                                        ]
                                    }
                                ],
                                items: [{
                                    type: 'Container',
                                    id: 'titleScroller',
                                    position: 'absolute',
                                    left: '0dp',
                                    top: '0dp',
                                    direction: 'row',
                                    items: [
                                        {
                                            type: 'Text',
                                            text: '${payload.htpc.title}',
                                            fontSize: '52dp',
                                            fontWeight: '500',
                                            color: '#000000A8',
                                            width: '${payload.htpc.titleBoxW}dp',
                                            maxLines: 1,
                                            position: 'absolute',
                                            left: '3dp',
                                            top: '3dp'
                                        },
                                        {
                                            type: 'Text',
                                            text: '${payload.htpc.title}',
                                            fontSize: '52dp',
                                            fontWeight: '500',
                                            color: '#FFFFFF',
                                            width: '${payload.htpc.titleBoxW}dp',
                                            maxLines: 1,
                                            shadowColor: '#000000EC',
                                            shadowHorizontalOffset: '0dp',
                                            shadowVerticalOffset: '2dp',
                                            shadowRadius: '11dp'
                                        }
                                    ]
                                }]
                            }]
                        },
                        {
                            type: 'Text',
                            when: "${payload.htpc.line2 != ''}",
                            text: '${payload.htpc.line2}',
                            fontSize: '30dp',
                            color: '#B8BDC7',
                            shadowColor: '#000000D9',
                            shadowHorizontalOffset: '0dp',
                            shadowVerticalOffset: '1dp',
                            shadowRadius: '6dp',
                            maxLines: 1,
                            paddingTop: '12dp',
                            paddingLeft: TAG_ROW_OUTDENT + 'dp'
                        },
                        { type: 'ProgressRow', when: '${payload.htpc.showBar}' },
                        {
                            type: 'Text',
                            when: "${payload.htpc.mode == 'gfn'}",
                            text: '${payload.htpc.timeLeft}',
                            fontSize: '22dp',
                            color: '#8E949E',
                            shadowColor: '#000000C4',
                            shadowHorizontalOffset: '0dp',
                            shadowVerticalOffset: '1dp',
                            shadowRadius: '5dp',
                            paddingTop: '24dp',
                            paddingLeft: TAG_ROW_OUTDENT + 'dp'
                        }
                    ]
                }
            ]
        }]
    },
    layouts: {
        AppBadge: {
            parameters: [{ name: 'app', type: 'string' }],
            items: [{
                type: 'Frame',
                when: "${app != ''}",
                backgroundColor: '#FFFFFF26',
                borderRadius: '999dp',
                paddingLeft: '16dp',
                paddingRight: '16dp',
                paddingTop: '6dp',
                paddingBottom: '6dp',
                items: [{ type: 'Text', text: '${app}', fontSize: '20dp', color: '#EDEFF2' }]
            }]
        },
        Pill: {
            parameters: [
                { name: 'label', type: 'string' },
                { name: 'xoff', type: 'number', default: 0 },
                { name: 'yoff', type: 'number', default: 0 }
            ],
            items: [{
                // Same frosted-glass construction as the source pill: padding moved onto an
                // inner row so the wrapper is flush with the Frame and the borderRadius does
                // the clipping. Border matches the source pill: 2dp, colour derived from the
                // artwork luminance under the tag row by the same Get-PillBorderColor ramp.
                type: 'Frame',
                backgroundColor: "${payload.htpc.hasBlur && payload.htpc.wide ? '#00000000' : payload.htpc.scrimTag}",
                borderRadius: '999dp',
                borderWidth: '2dp',
                borderColor: '${payload.htpc.borderTag}',
                shadowColor: '#00000066',
                shadowHorizontalOffset: '0dp',
                shadowVerticalOffset: '3dp',
                shadowRadius: '10dp',
                items: [{
                    type: 'Container',
                    items: [
                        {
                            type: 'Image',
                            when: '${payload.htpc.hasBlur && payload.htpc.wide}',
                            position: 'absolute',
                            left: '${xoff}',
                            bottom: '${yoff}',
                            width: '100vw',
                            height: '100vh',
                            source: '${payload.htpc.artBlur}',
                            scale: 'fill',
                            align: 'center',
                            overlayColor: '${payload.htpc.scrimTag}'
                        },
                        {
                            type: 'Container',
                            paddingLeft: '24dp',
                            paddingRight: '24dp',
                            paddingTop: TAG_PAD_TOP + 'dp',
                            paddingBottom: TAG_PAD_BOTTOM + 'dp',
                            items: [tagLabel('${label}')]
                        }
                    ]
                }]
            }]
        },
        LivePill: {
            parameters: [
                { name: 'xoff', type: 'number', default: 0 },
                { name: 'yoff', type: 'number', default: 0 }
            ],
            items: [{
                type: 'Frame',
                backgroundColor: "${payload.htpc.hasBlur && payload.htpc.wide ? '#00000000' : payload.htpc.scrimTag}",
                borderRadius: '999dp',
                borderWidth: '2dp',
                borderColor: '${payload.htpc.borderTag}',
                shadowColor: '#00000066',
                shadowHorizontalOffset: '0dp',
                shadowVerticalOffset: '3dp',
                shadowRadius: '10dp',
                items: [{
                    type: 'Container',
                    items: [
                        {
                            type: 'Image',
                            when: '${payload.htpc.hasBlur && payload.htpc.wide}',
                            position: 'absolute',
                            left: '${xoff}',
                            bottom: '${yoff}',
                            width: '100vw',
                            height: '100vh',
                            source: '${payload.htpc.artBlur}',
                            scale: 'fill',
                            align: 'center',
                            overlayColor: '${payload.htpc.scrimTag}'
                        },
                        {
                            type: 'Container',
                            direction: 'row',
                            alignItems: 'center',
                            paddingLeft: '24dp',
                            paddingRight: '24dp',
                            paddingTop: TAG_PAD_TOP + 'dp',
                            paddingBottom: TAG_PAD_BOTTOM + 'dp',
                            items: [
                                {
                                    // Drawn as a real circle, not the emoji. An emoji's line
                                    // box is font-dependent and was taller than the 39dp text
                                    // row, which stretched the LivePill and left LIVE looking
                                    // off-centre and a different size from every other tag.
                                    // A Frame is exact: fixed 20dp, centred by the row.
                                    type: 'Frame',
                                    width: '20dp',
                                    height: '20dp',
                                    borderRadius: '10dp',
                                    backgroundColor: '#FF0000',
                                    shadowColor: TAG_HALO,
                                    shadowHorizontalOffset: '0dp',
                                    shadowVerticalOffset: '1dp',
                                    shadowRadius: TAG_HALO_RADIUS
                                },
                                { type: 'Frame', width: '10dp', height: '1dp' },
                                tagLabel('LIVE')
                            ]
                        }
                    ]
                }]
            }]
        },
        ProgressRow: {
            parameters: [],
            items: [{
                type: 'Container',
                paddingTop: '32dp',
                paddingLeft: TAG_ROW_OUTDENT + 'dp',
                direction: 'row',
                alignItems: 'start',
                items: [
                    {
                        type: 'Frame',
                        width: PBAR.icon + 'dp',
                        height: PBAR.icon + 'dp',
                        items: [{
                            type: 'Container',
                            width: PBAR.icon + 'dp',
                            height: PBAR.icon + 'dp',
                            items: [
                                { type: 'VectorGraphic', source: 'PlayG', position: 'absolute', width: PBAR.icon + 'dp', height: PBAR.icon + 'dp', opacity: '${PausedB ? 0 : 1}' },
                                { type: 'VectorGraphic', source: 'PauseG', position: 'absolute', width: PBAR.icon + 'dp', height: PBAR.icon + 'dp', opacity: '${PausedB ? 1 : 0}' }
                            ]
                        }]
                    },
                    { type: 'Frame', width: PBAR.gap + 'dp', height: '1dp' },
                    {
                        type: 'Container',
                        grow: 1,
                        shrink: 1,
                        items: [
                            {
                                type: 'Container',
                                height: PBAR.rowH + 'dp',
                                justifyContent: 'center',
                                items: [{
                                    type: 'Frame',
                                    width: '100%',
                                    height: PBAR.barH + 'dp',
                                    borderRadius: PBAR.barR + 'dp',
                                    backgroundColor: '#FFFFFF2E',
                                    items: [{
                                        type: 'Frame',
                                        id: 'progressFill',
                                        width: '${100 * Pos / payload.htpc.dur}%',
                                        height: PBAR.barH + 'dp',
                                        borderRadius: PBAR.barR + 'dp',
                                        backgroundColor: '${payload.htpc.barColor}'
                                    }]
                                }]
                            },
                            {
                                type: 'Container',
                                direction: 'row',
                                justifyContent: 'spaceBetween',
                                paddingTop: PBAR.labelPt + 'dp',
                                items: [
                                    { type: 'Text', id: 'tLeft', text: "${Math.floor(Pos / 3600) > 0 ? Math.floor(Pos / 3600) + ':' + (Math.floor(Pos % 3600 / 60) < 10 ? '0' : '') : ''}${Math.floor(Pos % 3600 / 60)}:${Pos % 60 < 10 ? '0' : ''}${Pos % 60}", fontSize: PBAR.labelFs + 'dp', color: '#8E949E', shadowColor: '#000000B3', shadowHorizontalOffset: '0dp', shadowVerticalOffset: '1dp', shadowRadius: '5dp' },
                                    { type: 'Text', id: 'tRight', text: '${payload.htpc.timeRight}', fontSize: PBAR.labelFs + 'dp', color: '#8E949E', shadowColor: '#000000B3', shadowHorizontalOffset: '0dp', shadowVerticalOffset: '1dp', shadowRadius: '5dp' }
                                ]
                            }
                        ]
                    }
                ]
            }]
        }
    }
};

const EXIT_DOC = {
    type: 'APL',
    version: '2023.3',
    mainTemplate: {
        parameters: ['payload'],
        items: [{
            type: 'Frame',
            width: '100vw',
            height: '100vh',
            backgroundColor: '#000000',
            onMount: [{ type: 'Finish' }]
        }]
    }
};

function contentToken(h) {
    const s = h.mode + '|' + h.title + '|' + h.line2 + '|' + h.art + '|' + h.hdr + '|' + h.rtx + '|' + h.reflex + '|' + h.res + '|' + h.atmos + '|' + h.artBlur + '|' + h.wide;
    let x = 5381;
    for (let i = 0; i < s.length; i++) { x = ((x * 33) ^ s.charCodeAt(i)) >>> 0; }
    return 'htpc-' + x.toString(36);
}

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        const t = Alexa.getRequestType(handlerInput.requestEnvelope);
        return t === 'LaunchRequest' || t === 'IntentRequest';
    },
    async handle(handlerInput) {
        const st = await fetchState();
        const ds = buildDatasource(st);
        const rb = handlerInput.responseBuilder;
        // never emit reprompt/help speech on launch - prevents Alexa reading the
        // 'to open the skill just say...' fallback when phrase matching is uncertain
        rb.withShouldEndSession(true);
        const supportsApl = Alexa.getSupportedInterfaces(handlerInput.requestEnvelope)['Alexa.Presentation.APL'];
        if (supportsApl) {
            const env = handlerInput.requestEnvelope;
            const aplCtx = env.context && env.context['Alexa.Presentation.APL'];
            const liveToken = (aplCtx && aplCtx.token) || '';
            const isIdle = ds.htpc.mode === 'idle';
            if (isIdle) {
                rb.addDirective({ type: 'AudioPlayer.Stop' });
                if (liveToken.indexOf('htpc-') === 0) {
                    rb.addDirective({
                        type: 'Alexa.Presentation.APL.ExecuteCommands',
                        token: liveToken,
                        commands: [{ type: 'Finish' }]
                    });
                }
                // nothing of ours on screen: reply silently
            } else {
                const tok = contentToken(ds.htpc);
                if (liveToken === tok && !(st && st.force)) {
                    // same content on screen: silent in-place playback-state sync, no redraw.
                    // st.force (set by the watcher during a reclaim window) skips this branch
                    // so a reclaim launch ALWAYS re-renders even when the backgrounded doc
                    // still owns the APL context token.
                    rb.addDirective({
                        type: 'Alexa.Presentation.APL.ExecuteCommands',
                        token: tok,
                        commands: [
                            { type: 'SetValue', componentId: 'root', property: 'Pos', value: ds.htpc.pos },
                            { type: 'SetValue', componentId: 'root', property: 'PausedB', value: ds.htpc.paused }
                        ]
                    });
                } else {
                    if (DISPLAY_MODE === 'apl') {
                        rb.addDirective({ type: 'AudioPlayer.Stop' });   // kill any lingering silence stream
                    }
                    if (DISPLAY_MODE === 'rich' || DISPLAY_MODE === 'apl') {
                        rb.addDirective({
                            type: 'Alexa.Presentation.APL.RenderDocument',
                            token: tok,
                            document: APL_DOC,
                            datasources: ds
                        });
                    }
                    if (DISPLAY_MODE === 'rich' || DISPLAY_MODE === 'audio') {
                        rb.addDirective(silencePlayDirective(ds.htpc, 'REPLACE_ALL', null));
                    }
                }
            }
        } else {
            rb.speak('This device has no screen.');
        }
        return rb.withShouldEndSession(true).getResponse();
    }
};

const PlaybackNearlyFinishedHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished';
    },
    async handle(handlerInput) {
        if (DISPLAY_MODE === 'apl') { return handlerInput.responseBuilder.getResponse(); }   // let stale streams die
        const st = await fetchState();
        const ds = buildDatasource(st);
        const rb = handlerInput.responseBuilder;
        if (ds.htpc.mode === 'idle') { return rb.getResponse(); }
        const prev = handlerInput.requestEnvelope.request.token;
        rb.addDirective(silencePlayDirective(ds.htpc, 'ENQUEUE', prev));
        return rb.getResponse();
    }
};

const AudioPlayerEventHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope).indexOf('AudioPlayer.') === 0;
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder.getResponse();
    }
};

const StopPauseHandler = {
    canHandle(handlerInput) {
        if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'IntentRequest') { return false; }
        const n = Alexa.getIntentName(handlerInput.requestEnvelope);
        return n === 'AMAZON.StopIntent' || n === 'AMAZON.CancelIntent' || n === 'AMAZON.PauseIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .addDirective({ type: 'AudioPlayer.Stop' })
            .withShouldEndSession(true)
            .getResponse();
    }
};

const AplUserEventHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'Alexa.Presentation.APL.UserEvent';
    },
    async handle(handlerInput) {
        const rb = handlerInput.responseBuilder;
        const liveToken = handlerInput.requestEnvelope.request.token || '';
        const st = await fetchState();
        const ds = buildDatasource(st);
        if (ds.htpc.mode === 'idle') {
            if (liveToken.indexOf('htpc-') === 0) {
                rb.addDirective({
                    type: 'Alexa.Presentation.APL.ExecuteCommands',
                    token: liveToken,
                    commands: [{ type: 'Finish' }]
                });
            }
            return rb.getResponse();
        }
        const tok = contentToken(ds.htpc);
        if (liveToken === tok) {
            // Steady-state heartbeat: the doc reported its own Pos/Paused in the event
            // arguments. If it is already in sync (within 2s drift, matching pause flag),
            // reply with NO directives at all - an empty response does not re-assert the
            // skill on the device, which keeps Alexa's transient panels dismissable.
            const ev = handlerInput.requestEnvelope.request.arguments || [];
            const docPos = Number(ev[1]);
            const docPaused = (ev[2] === true || ev[2] === 'true');
            const bgBeats = Number(ev[4]) || 0;
            if (bgBeats >= 2) {
                // the doc has been alive-but-invisible for >= ~12s: a takeover replaced the
                // screen without killing the doc. A fresh RenderDocument foregrounds it.
                telemetry('aplReclaim=' + bgBeats);
                rb.addDirective({
                    type: 'Alexa.Presentation.APL.RenderDocument',
                    token: tok,
                    document: APL_DOC,
                    datasources: ds
                });
                return rb.getResponse();
            }
            const inSync = isFinite(docPos) && Math.abs(docPos - ds.htpc.pos) <= 2 && docPaused === !!ds.htpc.paused;
            if (!inSync) {
                rb.addDirective({
                    type: 'Alexa.Presentation.APL.ExecuteCommands',
                    token: tok,
                    commands: [
                        { type: 'SetValue', componentId: 'root', property: 'Pos', value: ds.htpc.pos },
                        { type: 'SetValue', componentId: 'root', property: 'PausedB', value: ds.htpc.paused }
                    ]
                });
            }
        } else {
            rb.addDirective({
                type: 'Alexa.Presentation.APL.RenderDocument',
                token: tok,
                document: APL_DOC,
                datasources: ds
            });
        }
        return rb.getResponse();
    }
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        const req = handlerInput.requestEnvelope.request;
        let tag = 'ended=' + encodeURIComponent(req.reason || 'unknown');
        if (req.error) { tag += '&errType=' + encodeURIComponent(req.error.type || '') + '&errMsg=' + encodeURIComponent((req.error.message || '').slice(0, 120)); }
        telemetry(tag);
        return handlerInput.responseBuilder.getResponse();
    }
};

// Device-side APL failures arrive here (inflation, media, list, and link errors).
// Notification-only per the APL interface spec: no directive may be returned.
// Without this handler the request falls through to ErrorHandler, which
// misreports it as a handler fault and answers with shouldEndSession=true.
// telemetry() surfaces the detail in the watcher's [req] log as [rte].
const AplRuntimeErrorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'Alexa.Presentation.APL.RuntimeError';
    },
    handle(handlerInput) {
        const req = handlerInput.requestEnvelope.request;
        const errs = Array.isArray(req.errors) ? req.errors : [];
        const first = errs[0] || {};
        let tag = 'rte=' + encodeURIComponent(first.type || 'unknown')
                + '&rteReason=' + encodeURIComponent(first.reason || '')
                + '&rteCount=' + errs.length;
        const msg = (first.message || '').slice(0, 120);
        if (msg) { tag += '&rteMsg=' + encodeURIComponent(msg); }
        console.log('APL RuntimeError: ' + JSON.stringify(errs).slice(0, 500));
        telemetry(tag);
        return handlerInput.responseBuilder.getResponse();
    }
};

const ErrorHandler = {
    canHandle() { return true; },
    handle(handlerInput, error) {
        console.log('Error: ' + (error && error.message));
        telemetry('handlerError=' + encodeURIComponent(((error && error.message) || 'unknown').slice(0, 120)));
        return handlerInput.responseBuilder.withShouldEndSession(true).getResponse();
    }
};

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(StopPauseHandler, PlaybackNearlyFinishedHandler, AudioPlayerEventHandler, AplUserEventHandler, AplRuntimeErrorHandler, LaunchRequestHandler, SessionEndedRequestHandler)
    .addErrorHandlers(ErrorHandler)
    .lambda();

// --- additive exports for the EchoShot off-device renderer (harmless to the Alexa runtime) ---
module.exports.APL_DOC = APL_DOC;
module.exports.buildDatasource = buildDatasource;
