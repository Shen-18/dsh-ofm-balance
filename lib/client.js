window.__ModuleLoader__.load({
  id: "dsh-ofm-balance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const reactDomClient = require("react-dom/client");
    const createElement = react.createElement;
    const h = createElement;

    // =========================================================================
    // API — document-relative so a sub-path deployment resolves correctly
    // =========================================================================

    const FETCH_TIMEOUT_MS = 30000;
    const API_BASE = "api/dsh-ofm-balance";

    async function apiFetch(path, method, body) {
      const response = await fetch(path, {
        method: method || "GET",
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        // Surface the host's own message when it sends one; a bare status code
        // is useless in the settings panel.
        let detail = "HTTP " + response.status
        try {
          const parsed = await response.json()
          if (parsed && typeof parsed.error === "string") detail = parsed.error
        } catch {
          // Keep the status-code message.
        }
        throw new Error(detail)
      }
      return await response.json();
    }

    const api = {
      overview: () => apiFetch(API_BASE + "/overview", "GET"),
      refresh: () => apiFetch(API_BASE + "/refresh", "POST"),
      channels: () => apiFetch(API_BASE + "/channels", "GET"),
      /**
       * Persist the channel visibility overrides.
       *
       * The host owns the profile patch, so the browser cannot write the config
       * itself; it posts the two id lists and the host folds them in.
       */
      saveVisibility: (hidden, revealed) =>
        apiFetch(API_BASE + "/visibility", "POST", { hidden, revealed }),
    };

    // =========================================================================
    // Presentation helpers
    // =========================================================================

    /** Trim a float for display: integers stay clean, fractions keep 2 places. */
    function fmt(value) {
      if (value === undefined || value === null) return "—";
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      if (Number.isInteger(n)) return n.toLocaleString("en-US");
      if (Math.abs(n) >= 1000) return n.toFixed(0);
      return n.toFixed(2);
    }

    /** Percentage with one decimal, but no trailing ".0". */
    function fmtPct(value) {
      if (value === undefined || value === null) return "—";
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      const rounded = Math.round(n * 10) / 10;
      return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%";
    }

    /**
     * Remaining percentage → a continuous colour.
     *
     * IMPORTANT: the number is what is LEFT, not what was consumed. 100% means
     * a full allowance (healthy); 0% means it is gone. Getting this backwards
     * paints every fresh quota red.
     *
     * Continuous, not banded: the earlier seven-step version produced visible
     * jumps ("why did this flip from amber to orange?"), so the value is
     * interpolated.
     *
     * The first attempt swept hue linearly over the whole range, and that
     * failed in practice: with everything healthy the card showed five
     * indistinguishable greens, because 80%→100% only spanned 122°→145°.
     * The anchors below deliberately push the top of the scale into teal
     * (178°), so "full" reads clearly different from "fine", while the
     * crowded low end keeps its red-to-amber warning ramp.
     */
    const HUE_ANCHORS = [
      [0, 0],     // gone: red
      [20, 25],   // low: orange
      [40, 48],   // amber
      [60, 78],   // yellow
      [75, 110],  // yellow-green
      [90, 148],  // green
      [100, 178], // full: teal
    ];

    /** Interpolate the hue anchors at a percentage. */
    function hueFor(pct) {
      for (let i = 1; i < HUE_ANCHORS.length; i += 1) {
        const [hiPct, hiHue] = HUE_ANCHORS[i];
        if (pct <= hiPct) {
          const [loPct, loHue] = HUE_ANCHORS[i - 1];
          const span = hiPct - loPct;
          const t = span <= 0 ? 0 : (pct - loPct) / span;
          return loHue + (hiHue - loHue) * t;
        }
      }
      return HUE_ANCHORS[HUE_ANCHORS.length - 1][1];
    }

    /**
     * Colour for a remaining percentage. Saturation and lightness also move
     * with the value (dimmer and calmer as it empties the safe range, richer
     * and more saturated as it approaches the warning end), so the ramp reads
     * as one scale rather than a hue wheel.
     */
    function percentColor(remainingPercent) {
      if (remainingPercent === undefined || remainingPercent === null) return "#8b8d98";
      const pct = Math.max(0, Math.min(100, Number(remainingPercent)));
      const hue = hueFor(pct);
      const t = pct / 100;
      // 100% sits at a bright, slightly desaturated teal; the warning end is
      // deep and hot. Both stay legible on light and dark surfaces.
      const sat = 52 + (1 - t) * 32;
      const light = 52 - (1 - t) * 3;
      return `hsl(${hue.toFixed(1)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
    }

    /**
     * Words for the tooltip. These are coarse on purpose: a human reads
     * "余额偏低" faster than "18.4%", and the exact number is right beside it.
     */
    function percentLabel(remainingPercent) {
      if (remainingPercent === undefined || remainingPercent === null) return "";
      const pct = Number(remainingPercent);
      if (pct <= 5) return "即将耗尽";
      if (pct <= 20) return "余额偏低";
      if (pct <= 40) return "注意";
      if (pct <= 60) return "一般";
      if (pct <= 80) return "尚可";
      if (pct <= 95) return "充足";
      return "满额";
    }

    /**
     * Card title. The sidebar is narrow: the old name ("Our Free Model", 14
     * characters) truncated to "Our Free Mode…" at the default width, which is
     * what prompted this rename.
     *
     * "OFM 额度" keeps the gateway's own acronym — the provider id in the
     * profile is `ourfreemodel`, and the project calls itself OFM — while
     * fitting on one line with room left for the headline number beside it.
     */
    const CARD_TITLE = "OFM 额度";

    /**
     * Channel labels the host has told us about.
     *
     * The browser deliberately keeps no channel list of its own: the host
     * derives labels from the ids it discovers, so this plugin works on a
     * gateway serving vendors it was never written for. The map below is only a
     * rendering fallback for the very first paint, before `/channels` answers.
     */
    let hostLabels = {};

    /** Remember the labels a host response carried. */
    function adoptLabels(plan) {
      if (!Array.isArray(plan)) return;
      const next = {};
      for (const entry of plan) {
        if (entry && typeof entry.id === "string" && typeof entry.label === "string") {
          next[entry.id] = entry.label;
        }
      }
      if (Object.keys(next).length > 0) hostLabels = next;
    }

    /**
     * Display label for a channel id.
     *
     * Prefers what the host said, falls back to a title-cased id, and never
     * returns something empty — an unfamiliar channel must still be readable.
     */
    function channelLabel(id) {
      if (typeof id !== "string" || id === "") return "";
      const fromHost = hostLabels[id];
      if (typeof fromHost === "string" && fromHost !== "") return fromHost;
      return id.charAt(0).toUpperCase() + id.slice(1);
    }

    // =========================================================================
    // Icons — inline SVG at 14px, stroke-based so they inherit currentColor and
    // match the shipped sibling cards (a filled pictogram reads as a black blob
    // at this size).
    // =========================================================================

    /**
     * A wallet: the conventional "balance" glyph, and legible at 14px because
     * it is one rounded rectangle plus a clasp rather than an abstract shape.
     */
    function WalletIcon() {
      return react.createElement(
        "svg",
        {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          className: "ofm-icon",
        },
        react.createElement("path", { d: "M2 5.2a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6" }),
        react.createElement("rect", { x: 2, y: 5.2, width: 12, height: 7.2, rx: 1.6 }),
        react.createElement("path", { d: "M10.2 8.8h1.8" }),
      );
    }

    // =========================================================================
    // Styles — injected once, scoped under a data attribute
    // =========================================================================

    const STYLE_ID = "dsh-ofm-balance-style";
    const CSS = `
[data-ofm-balance-card] {
  box-sizing: border-box;
  width: 100%;
  margin: 2px 0 4px;
  border-radius: 8px;
  /* No border, no fill.
   *
   * The sidebar's own container is background: transparent — it is the page
   * behind it that you see. So any opaque or tinted card reads as a box bolted
   * onto the sidebar rather than part of it. Leaving the surface transparent and
   * relying on the card's own spacing is what makes it sit quiet next to the
   * shipped usage card.
   *
   * A faint hover tint is the only affordance that says "this is clickable". */
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  user-select: none;
  transition: background-color 120ms ease;
}
[data-ofm-balance-card]:hover {
  background: color-mix(in srgb, currentColor 4%, transparent);
}
/* The shell's 56px rail has no room for a card; the sibling usage card hides
   there too, and mismatched visibility looks like a rendering bug. */
[data-ofm-balance-card][data-collapsed-rail="true"] {
  display: none;
}
[data-ofm-balance-card] .ofm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px;
  cursor: pointer;
}
[data-ofm-balance-card] .ofm-icon {
  display: block;
  flex: none;
  opacity: 0.7;
}
[data-ofm-balance-card] .ofm-title {
  font-weight: 600;
  font-size: 12px;
  opacity: 0.75;
  flex: 1 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-card] .ofm-summary {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
  display: inline-flex;
  align-items: baseline;
  gap: 3px;
}
/* Channel name in the inherited colour; only the percentage carries health. */
[data-ofm-balance-card] .ofm-sum-name {
  opacity: 0.85;
}
[data-ofm-balance-card] .ofm-sum-dot {
  opacity: 0.35;
}
[data-ofm-balance-card] .ofm-sum-pct {
  font-weight: 700;
}
/* The channel is known but its number is still loading. */
[data-ofm-balance-card] .ofm-sum-pending {
  font-weight: 500;
  opacity: 0.55;
  font-style: italic;
}
[data-ofm-balance-card] .ofm-chevron {
  opacity: 0.5;
  font-size: 10px;
  transition: transform 0.15s ease;
}
[data-ofm-balance-card].ofm-open .ofm-chevron { transform: rotate(90deg); }
[data-ofm-balance-card] .ofm-body {
  padding: 0 9px 8px 9px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[data-ofm-balance-card] .ofm-row {
  display: grid;
  grid-template-columns: 62px 1fr auto;
  align-items: center;
  gap: 7px;
}
/* The channel the current conversation is routed through. A quiet inset
   marker, not a colour: the row colours already carry the health signal, so
   this only has to say "this one" without competing. */
[data-ofm-balance-card] .ofm-row-current {
  position: relative;
  margin-left: -4px;
  padding-left: 4px;
}
[data-ofm-balance-card] .ofm-row-current::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 11px;
  border-radius: 1px;
  background: currentColor;
  opacity: 0.45;
}
[data-ofm-balance-card] .ofm-row-current .ofm-name {
  opacity: 1;
  font-weight: 600;
}
/* A channel the user revealed but never configured: dashed left edge, so the
   row itself says "this one is not wired up" without an extra label line. */
[data-ofm-balance-card] .ofm-row-unconfigured .ofm-name {
  opacity: 0.55;
  font-style: italic;
}
[data-ofm-balance-card] .ofm-errtxt {
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-card] .ofm-name {
  opacity: 0.75;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-card] .ofm-bar {
  height: 4px;
  border-radius: 2px;
  background: rgba(128, 128, 128, 0.2);
  overflow: hidden;
}
/* A shimmer while the first probe is in flight, so "读取中…" reads as work in
   progress rather than a stalled row. */
[data-ofm-balance-card] .ofm-bar-pending {
  background: linear-gradient(90deg,
    rgba(128, 128, 128, 0.18) 0%,
    rgba(128, 128, 128, 0.34) 50%,
    rgba(128, 128, 128, 0.18) 100%);
  background-size: 200% 100%;
  animation: ofm-shimmer 1.4s ease-in-out infinite;
}
@keyframes ofm-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
[data-ofm-balance-card] .ofm-pending {
  font-weight: 400;
  opacity: 0.6;
  font-style: italic;
}
[data-ofm-balance-card] .ofm-bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  transition: width 0.25s ease;
}
[data-ofm-balance-card] .ofm-value {
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  text-align: right;
  white-space: nowrap;
}
[data-ofm-balance-card] .ofm-num {
  font-weight: 500;
}
[data-ofm-balance-card] .ofm-pct {
  margin-left: 5px;
  font-size: 10.5px;
  font-weight: 600;
  opacity: 0.95;
}
[data-ofm-balance-card] .ofm-unit {
  opacity: 0.5;
  font-size: 10px;
  margin-left: 2px;
}
[data-ofm-balance-card] .ofm-errtxt {
  font-size: 10.5px;
  opacity: 0.6;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-card] .ofm-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
  /* Softer than a real divider: with the card's own frame gone, a hard rule
     here would be the loudest line on the whole block. */
  border-top: 1px solid color-mix(in srgb, currentColor 7%, transparent);
  margin-top: 2px;
  font-size: 10px;
  opacity: 0.55;
}
[data-ofm-balance-card] .ofm-foot button {
  all: unset;
  cursor: pointer;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  opacity: 0.9;
}
[data-ofm-balance-card] .ofm-foot button:hover {
  background: rgba(128, 128, 128, 0.18);
}
[data-ofm-balance-card] .ofm-spin {
  animation: ofm-rot 0.9s linear infinite;
  display: inline-block;
}
@keyframes ofm-rot { to { transform: rotate(360deg); } }
[data-ofm-balance-card] .ofm-warn {
  font-size: 10px;
  opacity: 0.6;
  padding-top: 2px;
}

/* ---- settings panel ---- */
[data-ofm-balance-settings] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: inherit;
  /* Pull the block to the top of the plugin detail page.
   *
   * The contribution slot (plugins.detail.section) appends after the page's
   * own blocks — "来源信息" and "更新" are rendered by the official page, not by
   * the slot, so no order on the registration can move us above them.
   *
   * What we can use is the page's own layout: the detail body is a flex column,
   * so a negative order on our subtree lifts it above every sibling with the
   * default order of 0. This is CSS-level and needs no knowledge of the host's
   * internal sort, which makes it stable across versions that keep that layout.
   *
   * If the container is ever not a flex column, this is simply inert and the
   * block stays where the slot put it — the layout degrades, nothing breaks. */
  order: -1;
}
[data-ofm-balance-settings] .ofm-set-head {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-bottom: 2px;
}
[data-ofm-balance-settings] .ofm-set-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
[data-ofm-balance-settings] .ofm-set-hint {
  margin: 0;
  font-size: 12.5px;
  opacity: 0.55;
  line-height: 1.65;
  max-width: 62ch;
}
/* One group per meaning (configured vs the rest), each with its own heading.
   Thirteen rows in one undifferentiated list is what read as "cramped". */
[data-ofm-balance-settings] .ofm-set-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 6px;
}
[data-ofm-balance-settings] .ofm-set-groupTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  opacity: 0.5;
  padding: 0 2px 6px;
}
[data-ofm-balance-settings] .ofm-set-count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 9%, transparent);
}
[data-ofm-balance-settings] .ofm-set-list {
  display: flex;
  flex-direction: column;
}
[data-ofm-balance-settings] .ofm-set-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  cursor: pointer;
  border-radius: 8px;
  transition: background-color 120ms ease;
}
[data-ofm-balance-settings] .ofm-set-row:hover {
  background: color-mix(in srgb, currentColor 4%, transparent);
}
/* A hairline between rows instead of a fill behind each: it separates without
   turning the list into a stack of boxes. */
[data-ofm-balance-settings] .ofm-set-row + .ofm-set-row {
  box-shadow: inset 0 1px 0 color-mix(in srgb, currentColor 7%, transparent);
}
[data-ofm-balance-settings] .ofm-set-row-dim .ofm-set-name {
  opacity: 0.8;
}
[data-ofm-balance-settings] .ofm-set-check {
  width: 15px;
  height: 15px;
  flex: none;
  cursor: pointer;
  accent-color: currentColor;
}
[data-ofm-balance-settings] .ofm-set-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 auto;
}
[data-ofm-balance-settings] .ofm-set-name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-settings] .ofm-set-desc {
  font-size: 11.5px;
  opacity: 0.45;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-ofm-balance-settings] .ofm-set-chip {
  flex: none;
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 10%, transparent);
  opacity: 0.7;
  white-space: nowrap;
}
[data-ofm-balance-settings] .ofm-set-chip-ok {
  background: color-mix(in srgb, #30a46c 16%, transparent);
  opacity: 0.85;
}
[data-ofm-balance-settings] .ofm-set-ok {
  font-size: 12px;
  color: #30a46c;
  padding-top: 4px;
}
[data-ofm-balance-settings] .ofm-set-error {
  font-size: 12px;
  color: #e5484d;
  padding-top: 4px;
}
`;

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // =========================================================================
    // Card component
    // =========================================================================

    function BalanceCard() {
      const [state, setState] = react.useState({ status: "loading", snapshot: null, error: null });
      const [open, setOpen] = react.useState(false);
      const [busy, setBusy] = react.useState(false);

      // Load channel labels once, so a gateway serving vendors this plugin has
      // never heard of still renders readable names.
      react.useEffect(function () {
        let alive = true;
        void api
          .channels()
          .then(function (doc) {
            if (alive) adoptLabels(doc && doc.plan);
          })
          .catch(function () {
            // Labels are cosmetic; the title-cased fallback covers this.
          });
        return function () {
          alive = false;
        };
      }, []);

      const load = react.useCallback(async function () {
        try {
          const doc = await api.overview();
          setState({ status: doc.warming ? "warming" : "ready", snapshot: doc.snapshot, error: null });
          return doc.warming === true;
        } catch (error) {
          setState({ status: "error", snapshot: null, error: error.message || String(error) });
          return false;
        }
      }, []);

      const doRefresh = react.useCallback(async function () {
        setBusy(true);
        try {
          const doc = await api.refresh();
          setState({ status: "ready", snapshot: doc.snapshot, error: null });
        } catch (error) {
          setState((prev) => ({ ...prev, status: "error", error: error.message || String(error) }));
        } finally {
          setBusy(false);
        }
      }, []);

      // Poll only while the tab is visible; a background tab costs nothing.
      //
      // The cadence follows "do I have anything worth showing", not just the
      // host's warming flag. Two situations used to land in the slow path and
      // looked like a broken plugin:
      //   - the host is still warming (its cold probe takes ~10s);
      //   - the host answered with a snapshot that has no readable channel,
      //     which is what happens when the first probe failed or the gateway
      //     is not up yet.
      // Both now retry at the fast cadence until something usable arrives.
      react.useEffect(function () {
        let timer = null;
        let alive = true;
        let haveData = false;

        function schedule(ms) {
          if (timer !== null) clearInterval(timer);
          timer = setInterval(function () {
            if (!alive) return;
            if (document.visibilityState === "visible") void tick();
          }, ms);
        }

        /** True when the snapshot carries at least one readable channel. */
        function usable(doc) {
          const channels = doc && doc.snapshot && Array.isArray(doc.snapshot.channels)
            ? doc.snapshot.channels
            : [];
          return channels.some(function (c) {
            return c.state === "ok";
          });
        }

        async function tick() {
          if (!alive) return;
          let doc = null;
          try {
            doc = await api.overview();
            setState({ status: doc.warming ? "warming" : "ready", snapshot: doc.snapshot, error: null });
          } catch (error) {
            setState({ status: "error", snapshot: null, error: error.message || String(error) });
          }
          haveData = doc !== null && doc.warming !== true && usable(doc);
          // 1.5s until something is on screen (the host probe usually lands
          // within ~11s), 30s once there is data worth looking at.
          schedule(haveData ? 30000 : 1500);
        }

        void tick();
        schedule(1500);

        function onVisible() {
          if (document.visibilityState === "visible") void tick();
        }
        document.addEventListener("visibilitychange", onVisible);
        return function () {
          alive = false;
          if (timer !== null) clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisible);
        };
      }, [load]);

      const snapshot = state.snapshot;
      const channels = (snapshot && Array.isArray(snapshot.channels)) ? snapshot.channels : [];

      // Headline: the channel closest to running out is the one worth
      // surfacing, because it is the one the user may need to act on. The
      // percentage is REMAINING, so the smallest number is the urgent one.
      let headline = null;
      for (const ch of channels) {
        if (ch.state !== "ok") continue;
        const pct = ch.percent;
        if (pct === undefined) continue;
        if (headline === null || pct < headline.percent) headline = { channel: ch, percent: pct };
      }

      // Collapsed headline, in the order of usefulness:
      //   1. the channel the CURRENT conversation routes through, so the strip
      //      answers "what am I spending right now";
      //   2. otherwise the channel closest to running out, which is the one the
      //      user may need to act on.
      //
      // The figure is REMAINING, so the smallest number is the urgent one.
      const currentChannelId = snapshot && typeof snapshot.currentChannel === "string"
        ? snapshot.currentChannel
        : null;
      const currentRow = currentChannelId === null
        ? null
        : channels.find(function (c) { return c.channel === currentChannelId; }) || null;

      /**
       * Build the summary as two spans: the channel name in the inherited text
       * colour, then the percentage tinted by health. The name stays plain on
       * purpose — colouring both would make the name read as a status and
       * compete with the number, which is the part that carries the signal.
       */
      let summaryNode;
      if (state.status === "loading") summaryNode = "读取中…";
      else if (state.status === "error") summaryNode = "读取失败";
      else {
        const focus = currentRow !== null && currentRow.state === "ok"
          ? { channel: currentRow.channel, percent: currentRow.percent, pending: false }
          : headline !== null
            ? { channel: headline.channel.channel, percent: headline.percent, pending: false }
            : null;
        if (focus !== null && focus.percent !== undefined) {
          summaryNode = [
            h("span", { className: "ofm-sum-name", key: "n" }, channelLabel(focus.channel)),
            h("span", { className: "ofm-sum-dot", key: "d" }, "·"),
            h(
              "span",
              { className: "ofm-sum-pct", key: "p", style: { color: percentColor(focus.percent) } },
              fmtPct(focus.percent),
            ),
          ];
        } else if (currentRow !== null) {
          // The route is known but its number is not in yet: name the channel
          // and say so, rather than showing a generic "warming" label that
          // hides which channel the conversation is on.
          summaryNode = [
            h("span", { className: "ofm-sum-name", key: "n" }, channelLabel(currentRow.channel)),
            h("span", { className: "ofm-sum-dot", key: "d" }, "·"),
            h("span", { className: "ofm-sum-pending", key: "p" }, "读取中"),
          ];
        } else if (channels.length > 0) {
          summaryNode = channels.some(function (c) { return c.state === "pending"; })
            ? "读取中…"
            : "无可用数据";
        } else {
          summaryNode = "—";
        }
      }

      const headChildren = [
        h(WalletIcon, { key: "i" }),
        h("span", { className: "ofm-title", key: "t" }, CARD_TITLE),
        h("span", { className: "ofm-summary", key: "s" }, summaryNode),
        h("span", { className: "ofm-chevron", key: "c" }, open ? "▾" : "▸"),
      ];

      const rows = channels.map(function (ch) {
        const label = channelLabel(ch.channel);
        const isCurrent = currentChannelId !== null && ch.channel === currentChannelId;
        // A channel the user revealed but never configured: shown, but marked
        // so the number is not mistaken for spendable balance.
        const unconfigured = ch.configured === false;
        const rowClass = "ofm-row"
          + (isCurrent ? " ofm-row-current" : "")
          + (unconfigured ? " ofm-row-unconfigured" : "");
        // Pending: the probe has not answered yet. Distinct from an error —
        // the row is on screen precisely so the card has content while the
        // numbers are still loading, and it must not read as "broken".
        if (ch.state === "pending") {
          return h(
            "div",
            { className: rowClass, key: ch.channel, title: ch.warning || "读取中" },
            h("span", { className: "ofm-name" }, label),
            h("span", { className: "ofm-bar ofm-bar-pending" }),
            h(
              "span",
              { className: "ofm-value" },
              h("span", { className: "ofm-pending" }, "读取中…"),
            ),
          );
        }
        if (ch.state !== "ok") {
          // `empty` means "the gateway has no account bound to this channel" —
          // the normal state for a vendor not logged into yet. Say that, rather
          // than reusing the error branch's bare dash, so a channel the plugin
          // now lists by default does not look broken.
          const isUnbound = ch.state === "empty";
          const valueText = isUnbound ? (ch.note || "未登录") : ch.error ? ch.error : "—";
          return h(
            "div",
            {
              className: rowClass,
              key: ch.channel,
              title: [ch.error || "", ch.note || "", ch.warning || ""].filter(Boolean).join("\n"),
            },
            h("span", { className: "ofm-name" }, label),
            h("span", { className: "ofm-errtxt", title: ch.error || ch.note || "" }, valueText),
            h("span", { className: "ofm-value", style: { opacity: 0.4 } }, "—"),
          );
        }
        const pct = ch.percent;
        const colour = percentColor(pct);
        const barWidth = pct === undefined ? 0 : Math.max(0, Math.min(100, pct));
        const tip = [
          isCurrent ? "当前对话使用中" : "",
          ch.warning || "",
          ch.nicknames.length > 0 ? "账号：" + ch.nicknames.join(", ") : "",
          ch.total !== undefined
            ? "剩余 " + fmt(ch.remaining) + " / 共 " + fmt(ch.total) + (ch.unit ? " " + ch.unit : "")
            : "剩余 " + fmt(ch.remaining) + (ch.unit ? " " + ch.unit : ""),
          pct !== undefined ? percentLabel(pct) : "",
          ch.packageCount > 0 ? ch.packageCount + " 个积分包" : "",
        ].filter(Boolean).join("\n");

        // Credit channels show the number; quota channels (no total) show the
        // percentage. gemini currently lands in the error branch upstream, but
        // when it recovers it will report a percentage, which this renders.
        const primary = ch.total === undefined
          ? fmtPct(pct)
          : fmt(ch.remaining);

        return h(
          "div",
          {
            className: rowClass,
            key: ch.channel,
            title: tip,
          },
          h("span", { className: "ofm-name" }, label),
          pct === undefined
            ? h("span", { className: "ofm-bar" })
            : h(
                "span",
                { className: "ofm-bar" },
                h("i", {
                  // A hairline gradient across the fill makes the continuous
                  // scale visible even on a short bar, instead of a flat block
                  // that reads as "some green" no matter the value.
                  style: {
                    width: barWidth + "%",
                    background: `linear-gradient(90deg, ${percentColor(Math.max(0, pct - 12))}, ${colour})`,
                  },
                }),
              ),
          h(
            "span",
            { className: "ofm-value" },
            h("span", { className: "ofm-num" }, primary),
            ch.total !== undefined && ch.unit
              ? h("span", { className: "ofm-unit" }, ch.unit)
              : null,
            pct !== undefined && ch.total !== undefined
              ? h("span", { className: "ofm-pct", style: { color: colour } }, fmtPct(pct))
              : null,
          ),
        );
      });

      const warnings = (snapshot && Array.isArray(snapshot.warnings)) ? snapshot.warnings : [];
      const foot = h(
        "div",
        { className: "ofm-foot", key: "f" },
        h(
          "button",
          {
            onClick: function (e) {
              e.stopPropagation();
              void doRefresh();
            },
            title: "立即刷新",
          },
          busy ? h("span", { className: "ofm-spin" }, "⟳") : "⟳ 刷新",
        ),
        h("span", null, snapshot && snapshot.updatedAt
          ? "更新于 " + new Date(snapshot.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
          : ""),
      );

      const body = open
        ? h(
            "div",
            { className: "ofm-body" },
            rows.length > 0 ? rows : h("div", { className: "ofm-warn" }, "暂无数据"),
            warnings.length > 0
              ? h("div", { className: "ofm-warn" }, warnings.join("；"))
              : null,
            foot,
          )
        : null;

      return h(
        "div",
        {
          "data-ofm-balance-card": "",
          className: open ? "ofm-open" : "",
        },
        h(
          "div",
          {
            className: "ofm-head",
            onClick: function () {
              setOpen(!open);
            },
            role: "button",
            tabIndex: 0,
            onKeyDown: function (e) {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpen(!open);
              }
            },
          },
          headChildren,
        ),
        body,
      );
    }

    // =========================================================================
    // Settings panel — per-channel visibility
    // =========================================================================

    /**
     * Channel visibility editor.
     *
     * The card shows channels that are *configured* in DSH by default and hides
     * the gateway's other inventory. This panel is where a user overrides that:
     * hide a configured channel they do not care about, or reveal a channel the
     * gateway offers but they never wired up.
     *
     * A revealed channel that is not configured carries a confirmation, because
     * its balance is real but not spendable from this harness — showing it
     * without saying so would be misleading.
     */
    function SettingsPanel() {
      const [state, setState] = react.useState({ status: "loading", plan: [], error: null });
      const [saving, setSaving] = react.useState(false);
      const [message, setMessage] = react.useState(null);

      const load = react.useCallback(async function () {
        try {
          const doc = await api.channels();
          setState({ status: "ready", plan: Array.isArray(doc.plan) ? doc.plan : [], error: null });
        } catch (error) {
          setState({ status: "error", plan: [], error: error.message || String(error) });
        }
      }, []);

      react.useEffect(function () {
        void load();
      }, [load]);

      /** Persist one channel's new visibility. */
      const apply = react.useCallback(
        async function (channelId, nextVisible, channel) {
          // Revealing an unconfigured channel is the one action worth a prompt.
          if (nextVisible && channel && channel.configured === false) {
            const ok = window.confirm(
              "「" + (channel.label || channelId) + "」尚未在 DSH 中配置模型，" +
              "显示它的余额只能查看，无法通过本 Harness 使用。\n\n仍要显示吗？",
            );
            if (!ok) return;
          }
          const hidden = [];
          const revealed = [];
          for (const entry of state.plan) {
            const visible = entry.id === channelId ? nextVisible : entry.visible;
            if (!visible && entry.configured) hidden.push(entry.id);
            if (visible && !entry.configured) revealed.push(entry.id);
          }
          setSaving(true);
          setMessage(null);
          try {
            const doc = await api.saveVisibility(hidden, revealed);
            setState({
              status: "ready",
              plan: Array.isArray(doc.plan) ? doc.plan : state.plan,
              error: null,
            });
            setMessage({ tone: "ok", text: "已保存" });
          } catch (error) {
            setMessage({ tone: "error", text: "保存失败：" + (error.message || String(error)) });
          } finally {
            setSaving(false);
          }
        },
        [state.plan],
      );

      /**
       * One channel row.
       *
       * Layout: a checkbox, the vendor name, a short status line under it, and
       * the state chip pushed to the right. Two lines per row rather than one
       * crammed line — with thirteen vendors the single-line version read as a
       * dense wall, and the status had nowhere to go but a truncated tag.
       */
      const renderRow = function (entry) {
        const label = channelLabel(entry.id);
        const unconfigured = entry.configured === false;
        const detail = unconfigured
          ? "未在 DSH 中配置模型，仅可查看余额"
          : entry.discovered === false
            ? "已配置，但网关当前未提供该渠道"
            : "已配置，可在对话中使用";
        return h(
          "label",
          { className: "ofm-set-row" + (unconfigured ? " ofm-set-row-dim" : ""), key: entry.id },
          h("input", {
            type: "checkbox",
            className: "ofm-set-check",
            checked: entry.visible === true,
            disabled: saving,
            onChange: function (e) {
              void apply(entry.id, e.target.checked, { label, configured: entry.configured });
            },
          }),
          h(
            "span",
            { className: "ofm-set-text" },
            h("span", { className: "ofm-set-name" }, label),
            h("span", { className: "ofm-set-desc" }, detail),
          ),
          h(
            "span",
            { className: "ofm-set-chip" + (unconfigured ? "" : " ofm-set-chip-ok") },
            unconfigured ? "未配置" : "已配置",
          ),
        );
      };

      // Two groups, because the two cases behave differently and mixing them
      // makes the list hard to scan: the channels this profile routes, then the
      // rest of the gateway's catalogue.
      const configuredRows = state.plan.filter(function (e) { return e.configured; }).map(renderRow);
      const otherRows = state.plan.filter(function (e) { return !e.configured; }).map(renderRow);

      return h(
        "div",
        { className: "ofm-set" },
        h(
          "div",
          { className: "ofm-set-head" },
          h("div", { className: "ofm-set-title" }, "渠道显示"),
          h(
            "p",
            { className: "ofm-set-hint" },
            "已配置的渠道默认显示。下面列出网关支持的全部渠道；勾选未配置的渠道会先确认——它们的余额只能查看，无法通过本 Harness 使用。",
          ),
        ),
        state.status === "loading"
          ? h("div", { className: "ofm-set-hint" }, "读取中…")
          : state.status === "error"
            ? h("div", { className: "ofm-set-error" }, "读取失败：" + state.error)
            : state.plan.length === 0
              ? h("div", { className: "ofm-set-hint" }, "暂无渠道数据")
              : [
                  configuredRows.length > 0
                    ? h(
                        "div",
                        { className: "ofm-set-group", key: "g-cfg" },
                        h("div", { className: "ofm-set-groupTitle" }, "已配置", h("span", { className: "ofm-set-count" }, String(configuredRows.length))),
                        h("div", { className: "ofm-set-list" }, configuredRows),
                      )
                    : null,
                  otherRows.length > 0
                    ? h(
                        "div",
                        { className: "ofm-set-group", key: "g-oth" },
                        h("div", { className: "ofm-set-groupTitle" }, "网关支持的其他渠道", h("span", { className: "ofm-set-count" }, String(otherRows.length))),
                        h("div", { className: "ofm-set-list" }, otherRows),
                      )
                    : null,
                ],
        message !== null
          ? h(
              "div",
              { className: message.tone === "ok" ? "ofm-set-ok" : "ofm-set-error" },
              message.text,
            )
          : null,
      );
    }

    // =========================================================================
    // Mount — seat the card above the sidebar's Settings row
    // =========================================================================

    const CARD_SELECTOR = "[data-ofm-balance-card]";
    let root = null;
    let container = null;
    let observer = null;
    let scheduled = false;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let retryTimer = null;
    /** Consecutive frames where no seat was found; used to stop retrying. */
    let missedSeats = 0;

    /**
     * The sidebar foot area (footer actions + the Settings row), when mounted.
     *
     * The shell owns this element and mounts it asynchronously, so a miss here
     * is expected during startup — it is not an error, it is "not yet".
     * `[data-pane="sidebar"]` is the current shell's hook; `[class*="sidebarCol"]`
     * covers older/newer class-hash builds; the bare `[class*="footArea"]`
     * fallback catches a shell that renders the foot without either wrapper.
     */
    function footArea() {
      const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
      if (column !== null) {
        const area = column.querySelector('[class*="footArea"]');
        if (area !== null) return area;
      }
      // Last resort: a foot area that exists without its expected ancestors.
      const loose = document.querySelector('[class*="footArea"]');
      return loose === null ? undefined : loose;
    }

    /** Seat the container, creating its React root on first use. */
    function seat() {
      const area = footArea();
      if (area === undefined) {
        missedSeats += 1;
        return false;
      }
      missedSeats = 0;
      if (container !== null && area.contains(container)) return true;

      if (container === null) {
        container = document.createElement("div");
        container.setAttribute("data-ofm-balance-slot", "");
        root = reactDomClient.createRoot(container);
        root.render(h(BalanceCard));
      }
      // The 56px rail has no room for a card, and the sibling usage card hides
      // there too. Mirror that by flagging the frame, which the CSS keys off.
      const frame = document.querySelector("[data-dsh-frame]");
      const collapsed = frame !== null && frame.hasAttribute("data-sidebar-collapsed");
      container.setAttribute("data-collapsed-rail", collapsed ? "true" : "false");
      // Above the Settings seat; a plain div so the shell's own reconciliation
      // is never disturbed.
      area.insertBefore(container, area.firstChild);
      return true;
    }

    /**
     * Re-seat after a shell re-render. The shell owns the foot area and may
     * rebuild it; a mutation-driven scheduler keeps the card present without
     * polling the DOM on a timer.
     */
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(function () {
        scheduled = false;
        try {
          seat();
        } catch {
          // A shell rebuild mid-frame is not an error worth surfacing.
        }
      });
    }

    /**
     * Keep trying to seat until the shell has mounted the sidebar.
     *
     * This is the fix for "the card does not appear until I click something".
     * The browser half is evaluated while the shell is still building its
     * sidebar, so the first `seat()` almost always misses, and a
     * MutationObserver alone is not enough: the shell renders the foot area
     * inside its own React commit, and a plugin that subscribes from outside
     * that tree can miss the one mutation that mattered. A short bounded poll
     * covers the gap without becoming a permanent timer.
     *
     * It stops as soon as a seat succeeds, and gives up after ~30s so a shell
     * that genuinely never mounts a sidebar does not leave a running interval
     * behind. Any later shell rebuild is still handled by the observer.
     */
    function startSeatRetry() {
      if (retryTimer !== null) return;
      let attempts = 0;
      const MAX_ATTEMPTS = 60
      retryTimer = setInterval(function () {
        attempts += 1
        if (container !== null && container.isConnected) {
          clearInterval(retryTimer);
          retryTimer = null;
          return;
        }
        schedule();
        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 500)
      if (typeof retryTimer?.unref === "function") retryTimer.unref();
    }

    /**
     * Lift the settings block above the page's own sections.
     *
     * The contribution slot appends after the official blocks, so relying on the
     * registration's `order` cannot move us above "来源信息". CSS `order: -1`
     * does the visual work (the detail body is a flex column); this callback is
     * the belt-and-braces version for a host whose container is not flex.
     *
     * It is deliberately conservative: it only re-parents within the same
     * container, never restructures the page, and silently does nothing when the
     * expected shape is absent.
     *
     * @param {HTMLElement | null} node Our rendered root, supplied by React.
     */
    function hoistToTop(node) {
      if (!node || !node.parentNode) return
      try {
        const parent = node.parentNode
        // Only act when the parent is a flex column — that is the layout this
        // reordering is meaningful in. Anything else keeps the slot's position.
        const style = window.getComputedStyle(parent)
        if (style.display !== "flex" || style.flexDirection !== "column") return
        if (parent.firstElementChild !== node) {
          parent.insertBefore(node, parent.firstElementChild)
        }
      } catch {
        // A host mid-render is not an error worth surfacing.
      }
    }

    /**
     * Register the channel settings block on this plugin's detail page.
     *
     * The seat is `plugins.detail.section` — the slot the official Plugins page
     * declares for contributed sections, rendered on every bundle / row /
     * official-plugin page with that page's `subject`.
     *
     * Two API details matter and both were wrong in the first attempt:
     *   - `settings.section` is not this seat. The shell registers sections via
     *     `slots.inject(name, () => slots.register(...))`, not a bare
     *     `register`, because the slot may not exist yet when the plugin
     *     activates; `inject` defers the registration until it does.
     *   - The component receives the page's `subject` as a prop, which is how a
     *     section knows which plugin page it is on. We only render for our own
     *     row and return null elsewhere, so the block never appears on a
     *     different plugin's page.
     *
     * Every step degrades quietly: a host without the slot simply has no
     * settings block, and the card keeps working.
     *
     * @param {object} ctx The client context.
     * @returns {(() => void) | undefined} A disposer when the registration took.
     */
    function registerSettingsSection(ctx) {
      const slots = ctx && ctx.slots
      if (slots === undefined || typeof slots.inject !== "function") return undefined
      try {
        return slots.inject("plugins.detail.section", function () {
          try {
            function Section(props) {
              // Only render on our own plugin's page. The shell hands the page's
              // subject to every contributor: a bundle page carries
              // `{ kind: 'bundle', pkg: { name } }`, a row page carries the row
              // or plugin id. Anything we cannot identify renders nothing rather
              // than crashing, and anything that is clearly another plugin's
              // page renders nothing so our block never appears there.
              const subject = props && props.subject
              let id = ""
              if (subject && typeof subject === "object") {
                if (typeof subject.id === "string") id = subject.id
                else if (typeof subject.name === "string") id = subject.name
                else if (subject.pkg && typeof subject.pkg.name === "string") id = subject.pkg.name
              }
              const ours = id === "" || id === "dsh-ofm-balance" || id === "ofm-balance"
              if (!ours) return null
              return h("div", { "data-ofm-balance-settings": "", ref: hoistToTop }, h(SettingsPanel))
            }
            return slots.register(
              {
                name: "plugins.detail.section",
                id: "ofm-balance-channels",
                // Sorted ahead of the plugin-management sections, which use
                // 30 and 40. This block is the plugin's own primary setting, so
                // it belongs near the top of the detail page rather than at the
                // bottom beneath "来源信息" and "更新".
                order: 1,
                label: function () {
                  return "OFM 额度"
                },
                inject: function () {
                  return {}
                },
              },
              Section,
            )
          } catch {
            return function () {}
          }
        })
      } catch {
        return undefined
      }
    }

    /** Browser half entry point. */
    function apply(ctx) {
      ensureStyles();
      schedule();
      startSeatRetry();

      // Settings section: where the channel toggles live.
      //
      // Registered through the shell's slot registry rather than relying on the
      // Host's generated config form, because that form only renders scalar
      // fields — an array of channel ids is unusable there, and the reveal step
      // needs a confirmation the generic form cannot express.
      const unregisterSettings = registerSettingsSection(ctx);

      // Watch for shell rebuilds that displace the container, and for the
      // sidebar collapsing/expanding (an attribute flip on the frame, not a
      // child rebuild, so childList alone would miss it).
      observer = new MutationObserver(function (records) {
        const attributeOnly =
          records.length > 0 &&
          records.every(function (r) {
            return r.type === "attributes";
          });
        if (attributeOnly) {
          schedule();
          return;
        }
        if (container !== null && document.body.contains(container)) {
          // Still seated; nothing to do until the shell replaces its parent.
          const area = footArea();
          if (area !== undefined && area.contains(container)) return;
        }
        schedule();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-sidebar-collapsed", "class"],
      });

      ctx.effect(
        function () {
          return function () {
            if (observer !== null) {
              observer.disconnect();
              observer = null;
            }
            if (retryTimer !== null) {
              clearInterval(retryTimer);
              retryTimer = null;
            }
            try {
              unregisterSettings?.()
            } catch {
              // The slot was already torn down with the shell.
            }
            if (root !== null) {
              try {
                root.unmount();
              } catch {
                // Already gone.
              }
              root = null;
            }
            if (container !== null && container.parentNode !== null) {
              container.parentNode.removeChild(container);
            }
            container = null;
          };
        },
        "dsh-ofm-balance: sidebar card",
      );
    }

    exports.apply = apply;
    exports.inject = ["slots", "connection"];
    exports.name = "dsh-ofm-balance";

    return module.exports;
  },
});
