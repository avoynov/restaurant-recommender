// TikTok, Facebook and Google Maps through Apify, logged-out. Each provider takes parsed links
// (canonical.parseLink) and returns records in the same shape as Instagram posts, plus
// `platform` and, for Google Maps, a `place` block.
//
//   clockworks/tiktok-scraper                    videos, slideshows, comments     $0.0037 per video
//   apify/facebook-posts-scraper                 page posts and reels             $0.005 per post
//   apify/facebook-comments-scraper              comments, optional               $0.0025 per comment
//   maximedupre/google-maps-shared-list-scraper  shared lists, places, short links $0.0007 per place
//   compass/crawler-google-places                place fallback                   $0.004 per place
//
// fetchLinks(targets, opts, maxChargeUsd) -> { results: Map(target.url -> {posts, raw} | ProviderError), cost }

import { createHash } from "node:crypto";
import { API, ApifyProvider, itemError } from "./apify.js";
import { parseLink, recordKey } from "./canonical.js";
import { ProviderError, blocked, isoUtc, nonNeg, normalizeTag, permanent, round, toFloat, toInt, topComments } from "./util.js";

export const TIKTOK_ACTOR = "clockworks~tiktok-scraper";
export const FB_POSTS_ACTOR = "apify~facebook-posts-scraper";
export const FB_COMMENTS_ACTOR = "apify~facebook-comments-scraper";
export const GMAPS_LIST_ACTOR = "maximedupre~google-maps-shared-list-scraper";
export const GMAPS_PLACES_ACTOR = "compass~crawler-google-places";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PHOTOS_PER_PLACE = 4;

const media0 = (m) => ({ cover_url: null, width: null, height: null, duration_s: null, ...m, storage_key: null, cover_storage_key: null, mime: null, bytes: null });
const hashtagsIn = (text) => [...new Set((String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []))];
const mentionsIn = (text) => [...new Set((String(text || "").match(/@[A-Za-z0-9._]{2,}/g) || []))];
const sameUrl = (a, b) => Boolean(a && b) && strip(a) === strip(b);
function strip(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^(www|m|web)\./, "") + x.pathname.replace(/\/+$/, "") + (x.searchParams.get("v") || x.searchParams.get("story_fbid") || "")).toLowerCase();
  } catch {
    return String(u).toLowerCase();
  }
}

class LinkProvider extends ApifyProvider {
  constructor(token, opts = {}) {
    super(token, opts);
    this.resolveFetch = opts.resolveFn ?? opts.fetchFn ?? globalThis.fetch;
  }

  /** Follow a short link's redirects to a link we can parse; on any failure keep the short link. */
  async resolve(t) {
    if (t.value) return t;
    let url = t.url;
    try {
      for (let hop = 0; hop < 4; hop++) {
        const r = await this.resolveFetch(url, { redirect: "manual", headers: { "User-Agent": UA } });
        const loc = r.headers?.get?.("location");
        if (!loc) break;
        url = new URL(loc, url).href;
        try {
          const p = parseLink(url);
          if (p.platform === t.platform && (p.value || p.kind !== t.kind)) return { ...p, short: t.url };
        } catch {
          /* not parseable yet, keep following */
        }
      }
    } catch {
      /* network refused: the actor gets the short link */
    }
    return t;
  }

  /** Assign items to targets: by id, then by URL, then leftovers to short links in order. */
  match(targets, items, idsOf, urlsOf) {
    const out = new Map();
    const used = new Set();
    for (const t of targets) {
      const i = items.findIndex((it, k) => !used.has(k) && ((t.value && idsOf(it).includes(String(t.value))) || urlsOf(it).some((u) => sameUrl(u, t.url) || sameUrl(u, t.short))));
      if (i >= 0) { used.add(i); out.set(t, items[i]); }
    }
    const left = items.filter((_, k) => !used.has(k));
    for (const t of targets) if (!out.has(t) && !t.value && left.length) out.set(t, left.shift());
    return out;
  }

  async datasetUrlItems(url) {
    if (!url?.startsWith(API)) return [];
    return this.request("GET", url.slice(API.length));
  }
}

// ---- TikTok ---------------------------------------------------------------------------------

export class TikTokProvider extends LinkProvider {
  name = "tier2_apify_tiktok";
  platform = "tiktok";
  minChargeUsd = 0.5; // the actor refuses a smaller cap

  constructor(token, opts = {}) {
    super(token, { pricePerPost: 0.0037, pricePerComment: 0.00125, ...opts });
  }

  estimateLinks(targets, { comments = 0, media = "covers" } = {}) {
    return round(0.001 + targets.length * (this.pricePerPost + (media === "all" ? 0.0013 : 0) + comments * this.pricePerComment), 4);
  }

  async fetchLinks(targets, { comments = 0, media = "covers" } = {}, maxChargeUsd) {
    const resolved = await Promise.all(targets.map((t) => this.resolve(t)));
    const input = {
      postURLs: resolved.map((t) => t.url), resultsPerPage: 1, commentsPerPost: comments,
      shouldDownloadVideos: media === "all", shouldDownloadCovers: media !== "none", shouldDownloadSlideshowImages: media !== "none",
      shouldDownloadSubtitles: false, shouldDownloadAvatars: false, shouldDownloadMusicCovers: false,
    };
    const { items, cost } = await this.run(TIKTOK_ACTOR, input, maxChargeUsd);
    const ok = items.filter((i) => !i.error && i.id);
    const matched = this.match(resolved, ok, (i) => [String(i.id)], (i) => [i.submittedVideoUrl, i.webVideoUrl, i.input]);
    const results = new Map();
    for (const [k, t] of resolved.entries()) {
      const item = matched.get(t);
      if (!item) {
        const err = items.find((i) => i.error && [i.url, i.input, i.submittedVideoUrl].some((u) => sameUrl(u, t.url)));
        results.set(targets[k].url, err ? itemError(err) : permanent("video not returned (removed, private or not found)"));
        continue;
      }
      const post = this.normalize(item);
      if (comments > 0 && item.commentsDatasetUrl) {
        try {
          const cs = (await this.datasetUrlItems(item.commentsDatasetUrl)).filter((c) => !c.repliesToId && (c.text || "").trim());
          if (cs.length) post.comments = topComments(cs.map((c) => ({ text: c.text.trim(), like_count: toInt(c.diggCount), created_at: isoUtc(c.createTimeISO ?? c.createTime) })));
        } catch (e) {
          console.warn(`tiktok comments for ${item.id}: ${e.message}`);
        }
      }
      results.set(targets[k].url, { posts: [post], raw: [item] });
    }
    return { results, cost };
  }

  normalize(item) {
    const id = String(item.id);
    const a = item.authorMeta || {};
    const vm = item.videoMeta || {};
    const slides = (item.slideshowImageLinks || item.imagePost?.images || [])
      .map((s) => (typeof s === "string" ? s : s.downloadLink || s.tiktokLink || s.imageURL?.urlList?.[0]))
      .filter(Boolean);
    const media = item.isSlideshow && slides.length
      ? slides.map((u, idx) => media0({ idx, kind: "image", source_url: u }))
      : [media0({ idx: 0, kind: "video", source_url: item.mediaUrls?.[0] || vm.downloadAddr || null, cover_url: vm.coverUrl || vm.originalCoverUrl || null,
        width: toInt(vm.width), height: toInt(vm.height), duration_s: toFloat(vm.duration) })];
    const nComments = toInt(item.commentCount);
    return {
      platform: "tiktok",
      shortcode: recordKey("tiktok", id),
      platform_id: id,
      url: item.webVideoUrl || `https://www.tiktok.com/@${a.name || ""}/video/${id}`,
      type: item.isSlideshow ? "carousel" : "video",
      author: { username: a.name || null, full_name: a.nickName || null, is_business: a.commerceUserInfo?.commerceUser ?? null },
      posted_at: isoUtc(item.createTimeISO ?? item.createTime),
      caption: item.text ?? null,
      hashtags: (item.hashtags || []).map((h) => (typeof h === "string" ? h : h.name)).filter(Boolean).map((h) => normalizeTag(h, "#")),
      mentions: (item.mentions || []).filter(Boolean).map((m) => normalizeTag(m, "@")),
      location: item.poi?.name || item.locationMeta?.locationName
        ? { name: item.poi?.name || item.locationMeta.locationName, ig_location_id: null, lat: toFloat(item.poi?.lat), lng: toFloat(item.poi?.lng) }
        : null,
      region: item.locationCreated ?? null,
      comments: nComments === 0 ? [] : null,
      media,
      stats: { like_count: nonNeg(item.diggCount), comment_count: nComments, view_count: nonNeg(item.playCount), share_count: nonNeg(item.shareCount), save_count: nonNeg(item.collectCount) },
      is_pinned: item.isPinned ?? null,
      product_type: item.isSlideshow ? "slideshow" : "video",
    };
  }
}

// ---- Facebook -------------------------------------------------------------------------------

/** First value found under any of these keys, depth-first. */
function deep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  for (const k of keys) if (typeof obj[k] === "string" && obj[k]) return obj[k];
  for (const v of Object.values(obj)) {
    const hit = deep(v, keys, depth + 1);
    if (hit) return hit;
  }
  return null;
}
const VIDEO_KEYS = ["browser_native_hd_url", "browser_native_sd_url", "playable_url_quality_hd", "playable_url", "hd_url", "sd_url", "videoUrl"];
const IMAGE_KEYS = ["uri", "photo_image", "thumbnail", "first_frame_thumbnail"];

export class FacebookProvider extends LinkProvider {
  name = "tier2_apify_facebook";
  platform = "facebook";

  constructor(token, opts = {}) {
    super(token, { pricePerPost: 0.005, pricePerComment: 0.0025, ...opts });
  }

  estimateLinks(targets, { comments = 0 } = {}) {
    return round(0.001 + targets.length * (this.pricePerPost + comments * this.pricePerComment), 4);
  }

  async fetchLinks(targets, { comments = 0 } = {}, maxChargeUsd) {
    const resolved = await Promise.all(targets.map((t) => this.resolve(t)));
    const { items, cost } = await this.run(FB_POSTS_ACTOR, { startUrls: resolved.map((t) => ({ url: t.url })), resultsLimit: 1 }, maxChargeUsd);
    const ok = items.filter((i) => !i.error);
    const matched = this.match(resolved, ok, (i) => [i.postId, i.post_id, i.facebookId, i.short_form_video_context?.video?.id].filter(Boolean).map(String),
      (i) => [i.facebookUrl, i.url, i.inputUrl, i.short_form_video_context?.shareable_url]);
    const results = new Map();
    let spent = cost;
    for (const [k, t] of resolved.entries()) {
      const item = matched.get(t);
      if (!item) {
        const err = items.find((i) => i.error && [i.url, i.facebookUrl, i.inputUrl].some((u) => sameUrl(u, t.url)));
        results.set(targets[k].url, err ? itemError(err) : permanent("post not returned (removed, not public, or needs a login)"));
        continue;
      }
      results.set(targets[k].url, { posts: [this.normalize(item)], raw: [item] });
    }
    const want = [...results.values()].filter((r) => !(r instanceof ProviderError)).map((r) => r.posts[0])
      .filter((p) => comments > 0 && (p.stats.comment_count ?? 1) > 0);
    if (want.length) {
      const cap = Math.max(0.01, maxChargeUsd - spent);
      try {
        const got = await this.run(FB_COMMENTS_ACTOR, { startUrls: want.map((p) => ({ url: p.url })), resultsLimit: comments, includeNestedComments: false }, cap, this.pricePerComment);
        spent += got.cost;
        for (const p of want) {
          const mine = got.items.filter((c) => !c.error && (want.length === 1 || [c.facebookUrl, c.postUrl, c.inputUrl].some((u) => sameUrl(u, p.url))));
          const cs = mine.filter((c) => (c.text || "").trim()).map((c) => ({ text: c.text.trim(), like_count: toInt(c.likesCount), created_at: isoUtc(c.date ?? c.created_time) }));
          if (cs.length) p.comments = topComments(cs);
        }
      } catch (e) {
        console.warn(`facebook comments: ${e.message}`);
      }
    }
    return { results, cost: round(spent) };
  }

  normalize(item) {
    const sf = item.short_form_video_context;
    let nodes = [...(item.media || []), ...(item.sharedPost?.media || [])];
    if (!nodes.length && sf) nodes = [{ __typename: "Video", ...(sf.video || {}), ...(sf.playback_video || {}) }];
    if (!nodes.length) nodes = (item.attachments || []).map((a) => a.media).filter((m) => m && (m.__typename === "Photo" || m.photo_image || m.image));
    const media = [];
    for (const n of nodes) {
      const isVideo = n.__typename === "Video" || n.playable_duration_in_ms != null || deep(n, VIDEO_KEYS);
      const cover = n.thumbnailImage?.uri || n.preferred_thumbnail?.image?.uri || n.image?.uri || n.photo_image?.uri || n.thumbnail || n.first_frame_thumbnail || null;
      const w = toInt(n.width ?? n.original_width), h = toInt(n.height ?? n.original_height);
      if (isVideo) {
        const ms = toFloat(n.playable_duration_in_ms);
        media.push(media0({ idx: media.length, kind: "video", source_url: deep(n, VIDEO_KEYS), cover_url: cover, width: w, height: h,
          duration_s: ms != null ? round(ms / 1000, 2) : toFloat(n.length_in_second) }));
      } else {
        const src = n.photo_image?.uri || n.image?.uri || cover || deep(n, IMAGE_KEYS);
        if (src) media.push(media0({ idx: media.length, kind: "image", source_url: src, width: w, height: h }));
      }
    }
    const text = [item.text ?? item.message?.text, item.sharedPost?.text].filter(Boolean).join("\n\n") || sf?.video?.seo_llm_content?.title || null;
    const id = String(item.postId || item.post_id || sf?.video?.id || item.facebookId || createHash("sha1").update(String(item.url || item.facebookUrl)).digest("hex").slice(0, 16));
    const nComments = toInt(item.comments ?? item.total_comment_count);
    const page = typeof item.pageName === "string" ? item.pageName : item.pageName?.name;
    return {
      platform: "facebook",
      shortcode: recordKey("facebook", id),
      platform_id: id,
      url: item.url || sf?.shareable_url || item.facebookUrl || null,
      type: media.some((m) => m.kind === "video") ? "video" : media.length > 1 ? "carousel" : media.length ? "image" : "text",
      author: { username: page || item.user?.name || null, full_name: item.user?.name || page || null, is_business: null },
      posted_at: isoUtc(item.time ?? item.timestamp ?? item.creation_time ?? item.publish_time),
      caption: text,
      hashtags: hashtagsIn(text),
      mentions: mentionsIn(text),
      location: null,
      link: item.link || item.sharedPost?.link || null,
      comments: nComments === 0 ? [] : null,
      media,
      stats: { like_count: toInt(item.likes ?? item.likers?.count ?? item.reactionCount), comment_count: nComments, view_count: toInt(item.viewsCount ?? item.video_view_count),
        share_count: toInt(item.shares ?? item.share_count_reduced) },
      is_pinned: null,
      product_type: sf ? "reel" : item.isVideo ? "video" : "post",
    };
  }
}

// ---- Google Maps ----------------------------------------------------------------------------

/** Place record from either Maps actor's output shape. */
export function normalizePlace(item) {
  const chij = [item.placeIdChIJ, item.placeId].find((x) => String(x || "").startsWith("ChIJ"));
  const id = String(chij || item.cid || item.placeId || item.fid);
  if (!id || id === "undefined") throw new Error("place has no id");
  const name = item.name ?? item.title ?? null;
  const lat = toFloat(item.latitude ?? item.location?.lat), lng = toFloat(item.longitude ?? item.location?.lng);
  const photos = [...(item.photos || item.imageUrls || []), ...(item.imageUrl && !item.imageUrls?.length ? [item.imageUrl] : [])]
    .map((p) => (typeof p === "string" ? p : p?.url || p?.imageUrl)).filter(Boolean).slice(0, PHOTOS_PER_PLACE);
  const reviews = Array.isArray(item.reviews)
    ? topComments(item.reviews.map((r) => ({ text: String(r.text || r.originalText || r.textTranslated || "").trim(), like_count: toInt(r.likesCount),
      created_at: isoUtc(r.publishedAt ?? r.publishedAtDate), rating: toFloat(r.rating ?? r.stars) })).filter((r) => r.text))
    : null;
  const categories = item.categories?.length ? item.categories : [item.categoryName].filter(Boolean);
  const url = item.googleMapsUrl || (item.cid ? `https://www.google.com/maps?cid=${item.cid}` : chij ? `https://www.google.com/maps/place/?q=place_id:${chij}` : item.url ?? null);
  return {
    platform: "google_maps",
    shortcode: recordKey("google_maps", id),
    platform_id: id,
    url,
    type: "place",
    author: null,
    posted_at: null,
    caption: item.description ?? item.ownerDescription ?? null,
    hashtags: [],
    mentions: [],
    location: { name, ig_location_id: null, lat, lng, address: item.address ?? null },
    place: {
      name, address: item.address ?? null, city: item.city ?? null, postal_code: item.postalCode ?? null, country_code: item.countryCode ?? null,
      lat, lng, categories, rating: toFloat(item.rating ?? item.totalScore), review_count: toInt(item.reviewCount ?? item.reviewsCount),
      price_level: item.priceLevel ?? item.price ?? null, phone: item.phone ?? null, website: item.website ?? null,
      hours: item.businessHours ?? item.openingHours ?? null, timezone: item.timezone ?? null, plus_code: item.plusCode ?? null,
      permanently_closed: item.isPermanentlyClosed ?? item.permanentlyClosed ?? null, temporarily_closed: item.temporarilyClosed ?? null,
      menu_url: item.menu ?? null, reserve_url: item.reserveTableUrl ?? null, social_links: item.socialLinks ?? null,
      place_id: chij ?? null, cid: item.cid ? String(item.cid) : null, google_id: item.placeId && !String(item.placeId).startsWith("ChIJ") ? item.placeId : item.kgmid ?? null,
    },
    comments: reviews,
    media: photos.map((u, idx) => media0({ idx, kind: "image", source_url: u })),
    stats: { like_count: null, comment_count: toInt(item.reviewCount ?? item.reviewsCount), view_count: null },
    is_pinned: null,
    product_type: "place",
  };
}

export class GoogleMapsProvider extends LinkProvider {
  name = "tier2_apify_gmaps";
  platform = "google_maps";

  constructor(token, opts = {}) {
    super(token, { pricePerPost: 0.0007, pricePerComment: 0.0002, ...opts });
  }

  estimateLinks(targets, { comments = 0, media = "covers", listLimit = 100 } = {}) {
    const places = targets.reduce((n, t) => n + (t.kind === "list" ? listLimit : 1), 0);
    return round(places * (this.pricePerPost + comments * this.pricePerComment + (media === "none" ? 0 : PHOTOS_PER_PLACE * 0.00005)), 4);
  }

  /** One run per link, so every place returned belongs to that link (a list has many). */
  async fetchLinks(targets, { comments = 0, media = "covers", listLimit = 100 } = {}, maxChargeUsd) {
    const results = new Map();
    let spent = 0;
    for (const t of targets) {
      const input = { listUrls: [t.url], maxPlacesPerList: listLimit, includeReviews: comments > 0, maxReviewsPerPlace: comments,
        includePhotos: media !== "none", maxPhotosPerPlace: media === "none" ? 0 : PHOTOS_PER_PLACE };
      try {
        const { items, cost } = await this.run(GMAPS_LIST_ACTOR, input, Math.max(0.01, maxChargeUsd - spent));
        spent += cost;
        const posts = [], raw = [];
        for (const i of items.filter((x) => !x.error)) {
          try { posts.push(normalizePlace(i)); raw.push(i); } catch (e) { console.warn(`maps item: ${e.message}`); }
        }
        const err = items.find((x) => x.error);
        results.set(t.url, posts.length ? { posts, raw } : err ? itemError(err)
          : permanent(t.kind === "list" ? "no places returned (is the list shared publicly?)" : "place not found"));
      } catch (e) {
        results.set(t.url, e instanceof ProviderError ? e : blocked(e.message));
      }
    }
    return { results, cost: round(spent) };
  }
}

/** Fallback for single places: Compass's Google Maps scraper (larger, pricier, no lists). */
export class GooglePlacesProvider extends LinkProvider {
  name = "tier2_apify_gplaces";
  platform = "google_maps";
  minChargeUsd = 0.5;

  constructor(token, opts = {}) {
    super(token, { pricePerPost: 0.006, pricePerComment: 0.0005, ...opts });
  }

  estimateLinks(targets, { comments = 0, media = "covers" } = {}) {
    return round(targets.length * (this.pricePerPost + comments * this.pricePerComment + (media === "none" ? 0 : PHOTOS_PER_PLACE * 0.0005)), 4);
  }

  async fetchLinks(targets, { comments = 0, media = "covers" } = {}, maxChargeUsd) {
    const results = new Map();
    const places = targets.filter((t) => t.kind === "place");
    for (const t of targets) if (t.kind !== "place") results.set(t.url, blocked("lists need the shared-list scraper"));
    if (!places.length) return { results, cost: 0 };
    const input = { startUrls: places.map((t) => ({ url: t.url })), maxCrawledPlacesPerSearch: 1, maxReviews: comments,
      maxImages: media === "none" ? 0 : PHOTOS_PER_PLACE, scrapeReviewsPersonalData: false, language: "en" };
    const { items, cost } = await this.run(GMAPS_PLACES_ACTOR, input, maxChargeUsd);
    const ok = items.filter((i) => !i.error && (i.placeId || i.cid));
    const matched = this.match(places, ok, (i) => [], (i) => [i.url, i.searchPageUrl, i.inputUrl, i.searchString]);
    for (const t of places) {
      const item = matched.get(t) || (places.length === 1 ? ok[0] : null);
      results.set(t.url, item ? { posts: [normalizePlace(item)], raw: [item] } : permanent("place not found"));
    }
    return { results, cost };
  }
}

/** All link providers, in fallback order per platform. */
export function linkProviders(token, opts = {}) {
  return [new TikTokProvider(token, opts), new FacebookProvider(token, opts), new GoogleMapsProvider(token, opts), new GooglePlacesProvider(token, opts)];
}
