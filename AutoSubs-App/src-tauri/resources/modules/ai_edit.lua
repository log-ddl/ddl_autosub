---@diagnostic disable: undefined-global
--
-- Timeline endpoints for AI Edit: read the open timeline (clips and markers),
-- add markers, change a clip's transform or Text+ text, move or retime a
-- clip, split clips, cut time spans out, and delete clips.
--
-- Times cross the bridge as seconds from the start of the timeline, the same
-- domain BuildStoryboard uses. Clips are addressed by their TimelineItem
-- unique id, which GetTimelineSnapshot reports.
--
-- Every call reads the project and timeline fresh, so nothing here goes stale
-- when the user switches project.

local resolve_env = AutoSubs_require("resolve_env")

local M = {}

local TRACK_TYPES = { "video", "audio", "subtitle" }

local MARKER_COLORS = {
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
    "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
}

local function fail(short, detail)
    return { error = short, detail = detail and tostring(detail) or "" }
end

-- The open timeline and its frame grid, or nil plus an error response.
local function current_timeline()
    local resolve = resolve_env.get_resolve()
    local project = resolve and resolve:GetProjectManager():GetCurrentProject()
    if not project then
        return nil, fail("No project is open in Resolve.")
    end
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return nil, fail("No timeline is open.")
    end
    local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
    return { timeline = timeline, fps = fps, start = timeline:GetStartFrame(), project = project }
end

local function round(x)
    return math.floor(x + 0.5)
end

local function items_in(timeline, kind, index)
    local ok, items = pcall(timeline.GetItemListInTrack, timeline, kind, index)
    if ok and type(items) == "table" then
        return items
    end
    return {}
end

-- Visit every item on every track: fn(item, kind, trackIndex).
local function each_item(timeline, fn)
    for _, kind in ipairs(TRACK_TYPES) do
        local count = tonumber(timeline:GetTrackCount(kind)) or 0
        for index = 1, count do
            for _, item in ipairs(items_in(timeline, kind, index)) do
                if fn(item, kind, index) then
                    return
                end
            end
        end
    end
end

-- The item with this unique id, plus its track type and index.
local function find_item(timeline, id)
    local found, foundKind, foundIndex
    each_item(timeline, function(item, kind, index)
        local ok, itemId = pcall(item.GetUniqueId, item)
        if ok and itemId == id then
            found, foundKind, foundIndex = item, kind, index
            return true
        end
    end)
    return found, foundKind, foundIndex
end

-- id -> { item, kind, index } for every item, in one pass. Each GetUniqueId
-- is a round trip through Resolve's UI thread, so looking up several ids
-- with find_item (a full scan each) gets slow on a long timeline.
local function index_items(timeline)
    local byId = {}
    each_item(timeline, function(item, kind, index)
        local ok, id = pcall(item.GetUniqueId, item)
        if ok and id then
            byId[id] = { item = item, kind = kind, index = index }
        end
    end)
    return byId
end

-- The first Text+ tool in a Fusion title clip, or nil. Only for edits the
-- user asked for: checks GetFusionCompCount first like autosubs_core does,
-- so a plain clip never has a Fusion comp opened for it.
local function text_plus_tool(item)
    local okCount, count = pcall(item.GetFusionCompCount, item)
    if not okCount or not count or count < 1 then
        return nil
    end
    local ok, comp = pcall(item.GetFusionCompByIndex, item, 1)
    if not ok or not comp then
        return nil
    end
    local okList, tools = pcall(comp.GetToolList, comp, false, "TextPlus")
    if okList and type(tools) == "table" then
        for _, tool in pairs(tools) do
            return tool
        end
    end
    return nil
end

local function property(item, name)
    local ok, value = pcall(item.GetProperty, item, name)
    if ok then
        return tonumber(value)
    end
    return nil
end

-- Every clip and marker on the open timeline.
function M.get_timeline_snapshot()
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local timeline, fps, start = ctx.timeline, ctx.fps, ctx.start

    local tracks = {}
    for _, kind in ipairs(TRACK_TYPES) do
        local count = tonumber(timeline:GetTrackCount(kind)) or 0
        for index = 1, count do
            local clips = {}
            for _, item in ipairs(items_in(timeline, kind, index)) do
                local itemStart = item:GetStart()
                local clip = {
                    id = item:GetUniqueId(),
                    name = item:GetName() or "",
                    startSec = (itemStart - start) / fps,
                    durationSec = (item:GetEnd() - itemStart) / fps,
                }
                -- No Text+ text here: reading a Fusion input (GetInput) from
                -- the bridge loop deadlocks Resolve's main thread (Resolve
                -- 21.1, stack stuck in Fusion::Input::GetSourceTagList), and
                -- the app reads this snapshot before every AI Edit message.
                if kind == "video" then
                    -- GetProperty() with no key returns every property in
                    -- one call instead of one UI-thread round trip per key.
                    local okAll, props = pcall(item.GetProperty, item)
                    if okAll and type(props) == "table" then
                        clip.zoom = tonumber(props.ZoomX)
                        clip.panX = tonumber(props.Pan)
                        clip.panY = tonumber(props.Tilt)
                        clip.rotation = tonumber(props.RotationAngle)
                    else
                        clip.zoom = property(item, "ZoomX")
                        clip.panX = property(item, "Pan")
                        clip.panY = property(item, "Tilt")
                        clip.rotation = property(item, "RotationAngle")
                    end
                end
                table.insert(clips, clip)
            end
            table.insert(tracks, {
                trackType = kind,
                index = index,
                name = timeline:GetTrackName(kind, index) or "",
                clips = clips,
            })
        end
    end

    local markers = {}
    local okMarkers, raw = pcall(timeline.GetMarkers, timeline)
    if okMarkers and type(raw) == "table" then
        for frame, m in pairs(raw) do
            table.insert(markers, {
                atSec = tonumber(frame) / fps,
                color = m.color or "",
                name = m.name or "",
                note = m.note or "",
                durationSec = (tonumber(m.duration) or 1) / fps,
            })
        end
        table.sort(markers, function(a, b) return a.atSec < b.atSec end)
    end

    return {
        name = timeline:GetName(),
        timelineId = timeline:GetUniqueId(),
        fps = fps,
        durationSec = (timeline:GetEndFrame() - start) / fps,
        tracks = tracks,
        markers = markers,
    }
end

local function marker_color(name)
    local wanted = string.lower(tostring(name or ""))
    for _, color in ipairs(MARKER_COLORS) do
        if string.lower(color) == wanted then
            return color
        end
    end
    return "Blue"
end

-- req.markers: { { atSec, color?, name?, note?, durationSec? }, ... }
-- A marker Resolve refuses (one is already on that frame) is counted as
-- skipped instead of failing the rest.
function M.add_markers(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local added, skipped, lines = 0, 0, {}
    for _, m in ipairs((req and req.markers) or {}) do
        local atSec = tonumber(m.atSec)
        if not atSec or atSec < 0 then
            skipped = skipped + 1
            table.insert(lines, "Skipped a marker with an invalid time.")
        else
            -- AddMarker takes a frame offset from the timeline start.
            local frame = round(atSec * ctx.fps)
            local duration = math.max(1, round((tonumber(m.durationSec) or 0) * ctx.fps))
            local color = marker_color(m.color)
            local name = (type(m.name) == "string" and m.name ~= "") and m.name or "AI marker"
            local ok, placed = pcall(ctx.timeline.AddMarker, ctx.timeline, frame, color, name,
                tostring(m.note or ""), duration, "")
            if ok and placed then
                added = added + 1
            else
                skipped = skipped + 1
                table.insert(lines, string.format(
                    "Could not add a marker at %.2fs (one may already be on that frame).", atSec))
            end
        end
    end
    return { added = added, skipped = skipped, lines = lines }
end

-- req: { atSec = { ... } }  Delete the markers at these times (the app picks
-- them from the snapshot, so they sit exactly on a marker's frame).
function M.delete_markers(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local deleted, lines = 0, {}
    for _, at in ipairs((req and req.atSec) or {}) do
        local atSec = tonumber(at)
        if atSec then
            local frame = round(atSec * ctx.fps)
            local ok, done = pcall(ctx.timeline.DeleteMarkerAtFrame, ctx.timeline, frame)
            if ok and done then
                deleted = deleted + 1
            else
                table.insert(lines, string.format("Could not delete the marker at %.2fs.", atSec))
            end
        end
    end
    return { deleted = deleted, lines = lines }
end

-- ---------------------------------------------------------------------------
-- Rebuilding clips (split, cut, move, retime)
--
-- Resolve's scripting API has no razor, move or trim. A clip is changed by
-- deleting it and appending the pieces wanted back from its media pool item
-- with AppendToTimeline, the same way autosubs_core's storyboard replace and
-- insert modes slice tracks. The clip's transform, crop, composite, opacity,
-- clip color and enabled state are copied over; its grade, Fusion effects
-- and keyframes are not, which the tool descriptions tell the agent.
-- ---------------------------------------------------------------------------

local KEEP_PROPS = {
    "Pan", "Tilt", "ZoomX", "ZoomY", "ZoomGang", "RotationAngle", "AnchorPointX", "AnchorPointY",
    "Pitch", "Yaw", "FlipX", "FlipY", "CropLeft", "CropRight", "CropTop", "CropBottom",
    "CropSoftness", "CropRetain", "DynamicZoomEase", "CompositeMode", "Opacity", "Distortion",
    "RetimeProcess", "MotionEstimation", "Scaling", "ResizeFilter",
}

local function capture(item)
    local props = {}
    for _, key in ipairs(KEEP_PROPS) do
        local ok, value = pcall(item.GetProperty, item, key)
        if ok and value ~= nil then
            props[key] = value
        end
    end
    local okColor, color = pcall(item.GetClipColor, item)
    if okColor and type(color) == "string" and color ~= "" then
        props.__color = color
    end
    local okEnabled, enabled = pcall(item.GetClipEnabled, item)
    if okEnabled and enabled == false then
        props.__disabled = true
    end
    return props
end

local function restore(item, props)
    for key, value in pairs(props) do
        if key == "__color" then
            pcall(item.SetClipColor, item, value)
        elseif key == "__disabled" then
            pcall(item.SetClipEnabled, item, false)
        else
            pcall(item.SetProperty, item, key, value)
        end
    end
end

local function track_label(kind, index)
    return (kind == "video" and "V" or kind == "audio" and "A" or "S") .. tostring(index)
end

-- Everything needed to put part of `item` back, or nil plus why it cannot be.
local function source_of(ctx, item, kind, index)
    local name = item:GetName() or ""
    if kind == "subtitle" then
        return nil, "subtitle clips cannot be cut by script"
    end
    local okMp, mp = pcall(item.GetMediaPoolItem, item)
    if not okMp or not mp then
        return nil, "it is not a media clip (title, generator or Fusion clip)"
    end
    local okIn, srcIn = pcall(item.GetSourceStartFrame, item)
    local okOut, srcOut = pcall(item.GetSourceEndFrame, item)
    srcIn = okIn and tonumber(srcIn) or nil
    srcOut = okOut and tonumber(srcOut) or nil
    if not srcIn or not srcOut or srcOut <= srcIn then
        return nil, "Resolve did not report its source range"
    end
    local recIn = item:GetStart() - ctx.start
    local recOut = item:GetEnd() - ctx.start
    local ratio = (srcOut - srcIn) / math.max(1, recOut - recIn)
    -- AppendToTimeline always plays at 100%, so a clip with a speed change
    -- would come back at a different length.
    local okFps, srcFps = pcall(mp.GetClipProperty, mp, "FPS")
    srcFps = okFps and tonumber(srcFps) or nil
    if kind == "video" and srcFps and srcFps > 0 then
        local expected = srcFps / ctx.fps
        if math.abs(ratio - expected) > 0.02 * expected then
            return nil, "it has a speed change"
        end
    end
    local okFrames, frames = pcall(mp.GetClipProperty, mp, "Frames")
    return {
        item = item, kind = kind, track = index, mp = mp, name = name,
        srcIn = srcIn, recIn = recIn, recOut = recOut, ratio = ratio,
        srcFrames = okFrames and tonumber(frames) or nil,
    }
end

-- A Resolve API object, as opposed to the numbers and strings its tables
-- also carry.
local function is_item(x)
    local t = type(x)
    return t == "userdata" or (t == "table" and x.GetUniqueId ~= nil)
end

-- Clips linked to `item` (its audio, for a video clip), as items.
-- GetLinkedItems does not always answer in the same shape: usually a list
-- of items, but sometimes the items are the keys and the values are numbers,
-- so both sides of each pair are checked.
local function linked_items(item)
    local ok, list = pcall(item.GetLinkedItems, item)
    local out = {}
    if ok and type(list) == "table" then
        for k, v in pairs(list) do
            if is_item(v) then
                out[#out + 1] = v
            elseif is_item(k) then
                out[#out + 1] = k
            end
        end
    end
    return out
end

-- A clip a cut could not rebuild (a title, generator, Fusion clip), for the
-- app to handle: it re-creates titles AI Edit placed, whose text it knows.
local function left_entry(ctx, item, kind, index, why)
    local okId, id = pcall(item.GetUniqueId, item)
    return {
        id = okId and id or "",
        name = item:GetName() or "",
        kind = kind,
        track = index,
        startSec = (item:GetStart() - ctx.start) / ctx.fps,
        endSec = (item:GetEnd() - ctx.start) / ctx.fps,
        reason = why,
    }
end

-- One key shared by a clip and the clips linked to it, so the pieces that
-- land on the same frame can be linked again.
local function link_group(item)
    local ok, key = pcall(item.GetUniqueId, item)
    key = ok and key or tostring(item)
    for _, linked in ipairs(linked_items(item)) do
        local okId, id = pcall(linked.GetUniqueId, linked)
        if okId and id < key then
            key = id
        end
    end
    return key
end

local function source_range(src, piece)
    local sIn = src.srcIn + round((piece.from - src.recIn) * src.ratio)
    local sOut = sIn + math.max(1, round(piece.len * src.ratio))
    return sIn, sOut
end

-- Replace each job's clip by its pieces. job = { src, group, pieces = {
-- { from, len, dest } } } in frames from the timeline start: the piece of
-- the original starting at `from`, `len` long, placed at `dest`. Fills
-- job.placed[k] with the new item for piece k. Returns lines describing
-- anything that went wrong, or nil plus an error when nothing was touched.
local function rebuild(ctx, jobs)
    -- Refuse up front rather than delete a clip that cannot come back.
    for _, job in ipairs(jobs) do
        for _, piece in ipairs(job.pieces) do
            local sIn, sOut = source_range(job.src, piece)
            -- "Frames" is only trusted for video; audio reports other units.
            local frames = job.src.kind == "video" and job.src.srcFrames or nil
            if sIn < 0 or (frames and sOut > frames + 1) then
                return nil, string.format("\"%s\" has no source media for that range (it would need frames %d-%d)",
                    job.src.name, sIn, sOut)
            end
        end
    end

    local originals = {}
    for _, job in ipairs(jobs) do
        job.props = capture(job.src.item)
        originals[#originals + 1] = job.src.item
    end
    if #originals == 0 then
        return {}
    end
    local okDel, deleted = pcall(ctx.timeline.DeleteClips, ctx.timeline, originals, false)
    if not okDel or not deleted then
        return nil, "Resolve refused to remove the clips to rebuild them"
    end

    local mediaPool = ctx.project:GetMediaPool()
    local lines, toLink = {}, {}
    for _, job in ipairs(jobs) do
        local src = job.src
        job.placed = {}
        for k, piece in ipairs(job.pieces) do
            local sIn, sOut = source_range(src, piece)
            local ok, items = pcall(mediaPool.AppendToTimeline, mediaPool, { {
                mediaPoolItem = src.mp,
                startFrame = sIn,
                endFrame = sOut,
                trackIndex = src.track,
                recordFrame = ctx.start + piece.dest,
                mediaType = src.kind == "video" and 1 or 2,
            } })
            local placed = ok and type(items) == "table" and items[1] or nil
            if placed then
                restore(placed, job.props)
                job.placed[k] = placed
                local key = job.group .. ":" .. tostring(piece.dest)
                toLink[key] = toLink[key] or {}
                table.insert(toLink[key], placed)
            else
                table.insert(lines, string.format(
                    "Resolve did not put back part of \"%s\" at %.2fs on %s; use Edit > Undo in Resolve to restore it.",
                    src.name, piece.dest / ctx.fps, track_label(src.kind, src.track)))
            end
        end
    end
    for _, items in pairs(toLink) do
        if #items > 1 then
            pcall(ctx.timeline.SetClipsLinked, ctx.timeline, items, true)
        end
    end
    return lines
end

local function append_all(dst, src)
    for _, v in ipairs(src) do
        dst[#dst + 1] = v
    end
end

-- req: { atSec, ids? }  Split the listed clips (and the clips linked to
-- them), or every clip under atSec, in two at atSec.
function M.split_clips(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local frame = round((tonumber(req and req.atSec) or 0) * ctx.fps)
    local wanted
    if req and type(req.ids) == "table" and #req.ids > 0 then
        wanted = {}
        local byId = index_items(ctx.timeline)
        for _, id in ipairs(req.ids) do
            wanted[id] = true
            local item = byId[id] and byId[id].item
            for _, linked in ipairs(item and linked_items(item) or {}) do
                local ok, linkedId = pcall(linked.GetUniqueId, linked)
                if ok then
                    wanted[linkedId] = true
                end
            end
        end
    end

    local jobs, lines, left = {}, {}, {}
    each_item(ctx.timeline, function(item, kind, index)
        local okId, id = pcall(item.GetUniqueId, item)
        if wanted and not (okId and wanted[id]) then
            return
        end
        local recIn = item:GetStart() - ctx.start
        local recOut = item:GetEnd() - ctx.start
        if recIn < frame and frame < recOut then
            local src, why = source_of(ctx, item, kind, index)
            if src then
                table.insert(jobs, { src = src, group = link_group(item), pieces = {
                    { from = recIn, len = frame - recIn, dest = recIn },
                    { from = frame, len = recOut - frame, dest = frame },
                } })
            else
                table.insert(left, left_entry(ctx, item, kind, index, why))
            end
        end
    end)
    if #jobs == 0 then
        if #left > 0 then
            return { split = 0, lines = lines, left = left }
        end
        return fail("Nothing was split", string.format("No clip spans %.2fs.", frame / ctx.fps))
    end
    local problems, rebuildErr = rebuild(ctx, jobs)
    if not problems then
        return fail("Could not split the clips", rebuildErr)
    end
    append_all(lines, problems)
    -- The pieces' new ids, so the agent can edit one without re-reading the
    -- timeline (a rebuilt clip never keeps its old id).
    local pieces = {}
    for _, job in ipairs(jobs) do
        for k, piece in ipairs(job.pieces) do
            local placed = job.placed and job.placed[k]
            if placed then
                local okId, id = pcall(placed.GetUniqueId, placed)
                if okId and id then
                    pieces[#pieces + 1] = {
                        id = id,
                        track = track_label(job.src.kind, job.src.track),
                        startSec = piece.dest / ctx.fps,
                        endSec = (piece.dest + piece.len) / ctx.fps,
                    }
                end
            end
        end
    end
    return { split = #jobs, lines = lines, left = left, pieces = pieces }
end

-- req: { ranges = { { start, end }, ... } (seconds, sorted, disjoint), ripple? }
-- Cut the spans out of every track. Clips crossing a span edge are rebuilt in
-- pieces; the pieces inside, and clips wholly inside, are deleted in one
-- DeleteClips call (ripple closes the gaps). Resolve only closes a gap on a
-- track that had a clip in it, so with ripple every clip that should have
-- moved is checked afterwards and the ones that did not are reported.
function M.remove_ranges(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local ripple = not (req and req.ripple == false)
    local ranges = {}
    for _, r in ipairs((req and req.ranges) or {}) do
        local a = round((tonumber(r.start) or 0) * ctx.fps)
        local b = round((tonumber(r["end"]) or 0) * ctx.fps)
        if b > a then
            ranges[#ranges + 1] = { a = a, b = b }
        end
    end
    if #ranges == 0 then
        return fail("No time span to remove", "Every range was shorter than a frame.")
    end
    local function removed_before(t)
        local total = 0
        for _, r in ipairs(ranges) do
            total = total + math.max(0, math.min(r.b, t) - r.a)
        end
        return total
    end

    -- tracks: only these ("V1", "A1", as get_timeline labels them); clips
    -- on the other tracks are not cut and not moved.
    local only
    if req and type(req.tracks) == "table" and #req.tracks > 0 then
        only = {}
        for _, t in ipairs(req.tracks) do
            only[string.upper(tostring(t))] = true
        end
    end

    local jobs, inside, lines, expected, left = {}, {}, {}, {}, {}
    local removedWhole = 0
    each_item(ctx.timeline, function(item, kind, index)
        if only and not only[track_label(kind, index)] then
            return
        end
        local recIn = item:GetStart() - ctx.start
        local recOut = item:GetEnd() - ctx.start
        local pieces, cursor, cuts = {}, recIn, 0
        for _, r in ipairs(ranges) do
            if r.b > cursor and r.a < recOut then
                if r.a > cursor then
                    pieces[#pieces + 1] = { from = cursor, len = r.a - cursor, dest = cursor }
                end
                local ca, cb = math.max(r.a, cursor), math.min(r.b, recOut)
                pieces[#pieces + 1] = { from = ca, len = cb - ca, dest = ca, cut = true }
                cuts = cuts + 1
                cursor = math.max(cursor, r.b)
            end
        end
        local okId, id = pcall(item.GetUniqueId, item)
        if cuts == 0 then
            local shift = removed_before(recIn)
            if ripple and shift > 0 and okId then
                table.insert(expected, { id = id, want = recIn - shift, kind = kind, index = index })
            end
            return
        end
        if cursor < recOut then
            pieces[#pieces + 1] = { from = cursor, len = recOut - cursor, dest = cursor }
        end
        if #pieces == cuts then
            -- Wholly inside the spans: delete it as it is.
            table.insert(inside, item)
            removedWhole = removedWhole + 1
            return
        end
        local src, why = source_of(ctx, item, kind, index)
        if not src then
            table.insert(left, left_entry(ctx, item, kind, index, why))
            return
        end
        table.insert(jobs, { src = src, group = link_group(item), pieces = pieces })
    end)

    local problems, rebuildErr = rebuild(ctx, jobs)
    if not problems then
        return fail("Could not cut the clips", rebuildErr)
    end
    append_all(lines, problems)
    for _, job in ipairs(jobs) do
        for k, piece in ipairs(job.pieces) do
            local placed = job.placed[k]
            if placed and piece.cut then
                table.insert(inside, placed)
            elseif placed and ripple and removed_before(piece.dest) > 0 then
                local ok, id = pcall(placed.GetUniqueId, placed)
                if ok then
                    table.insert(expected, { id = id, want = piece.dest - removed_before(piece.dest),
                        kind = job.src.kind, index = job.src.track })
                end
            end
        end
    end

    if #inside > 0 then
        local okDel, done = pcall(ctx.timeline.DeleteClips, ctx.timeline, inside, ripple)
        if not okDel or not done then
            return fail("Resolve refused to delete the cut parts", okDel and "" or done)
        end
    end

    local stuck = {}
    local byId = #expected > 0 and index_items(ctx.timeline) or {}
    for _, e in ipairs(expected) do
        local item = byId[e.id] and byId[e.id].item
        if item and math.abs((item:GetStart() - ctx.start) - e.want) > 1 then
            stuck[track_label(e.kind, e.index)] = (stuck[track_label(e.kind, e.index)] or 0) + 1
        end
    end
    for label, count in pairs(stuck) do
        table.insert(lines, string.format(
            "%d clip(s) on %s did not move left: Resolve only closes a gap on a track that had a clip inside the span.",
            count, label))
    end
    return { cut = #jobs, deleted = #inside, removedWhole = removedWhole, lines = lines, left = left }
end

-- Move `item` to `startFrame` and/or give it `lenFrames`, with the clips
-- linked to it. Returns the new item, or nil plus an error.
local function move_clip(ctx, item, kind, index, startFrame, lenFrames)
    local recIn = item:GetStart() - ctx.start
    local recOut = item:GetEnd() - ctx.start
    local delta = (startFrame or recIn) - recIn
    local len = lenFrames or (recOut - recIn)
    if len < 1 then
        return nil, "durationSec must be at least one frame"
    end

    local members = { { item = item, kind = kind, index = index } }
    local linkedItems = linked_items(item)
    local byId = #linkedItems > 0 and index_items(ctx.timeline) or {}
    for _, linked in ipairs(linkedItems) do
        local okId, id = pcall(linked.GetUniqueId, linked)
        if okId and byId[id] then
            members[#members + 1] = byId[id]
        end
    end
    local moving = {}
    for _, m in ipairs(members) do
        local okId, id = pcall(m.item.GetUniqueId, m.item)
        if okId then
            moving[id] = true
        end
    end

    local jobs = {}
    for _, m in ipairs(members) do
        local src, why = source_of(ctx, m.item, m.kind, m.index)
        if not src then
            return nil, string.format("\"%s\" on %s cannot be moved: %s", m.item:GetName() or "",
                track_label(m.kind, m.index), why)
        end
        -- A linked clip keeps its own length unless it matched this one.
        local ownLen = src.recOut - src.recIn
        local pieceLen = (ownLen == recOut - recIn) and len or ownLen
        local dest = src.recIn + delta
        if dest < 0 then
            return nil, "the clip would start before the timeline does"
        end
        -- Never land on another clip: AppendToTimeline does not overwrite.
        for _, other in ipairs(items_in(ctx.timeline, m.kind, m.index)) do
            local okId, id = pcall(other.GetUniqueId, other)
            if not (okId and moving[id]) then
                local s = other:GetStart() - ctx.start
                local e = other:GetEnd() - ctx.start
                if s < dest + pieceLen and e > dest then
                    return nil, string.format(
                        "it would overlap \"%s\" on %s (%.2fs-%.2fs); free that spot first (remove_ranges or delete_clips)",
                        other:GetName() or "", track_label(m.kind, m.index), s / ctx.fps, e / ctx.fps)
                end
            end
        end
        table.insert(jobs, { src = src, group = link_group(item),
            pieces = { { from = src.recIn, len = pieceLen, dest = dest } } })
    end

    local problems, rebuildErr = rebuild(ctx, jobs)
    if not problems then
        return nil, rebuildErr
    end
    local placed = jobs[1].placed[1]
    if not placed then
        return nil, table.concat(problems, " ")
    end
    return placed
end

-- req: { id, startSec?, durationSec?, zoom?, panX?, panY?, rotation?, opacity?, text? }
-- Moving or retiming rebuilds the clip (see move_clip), which gives it a new
-- id; the reply carries it.
function M.update_clip(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local item, kind, index = find_item(ctx.timeline, req and req.id)
    if not item then
        return fail("Clip not found", "No clip with id " .. tostring(req and req.id))
    end

    local changed = {}
    local startSec, durationSec = tonumber(req.startSec), tonumber(req.durationSec)
    if startSec or durationSec then
        local moved, moveErr = move_clip(ctx, item, kind, index,
            startSec and round(startSec * ctx.fps) or nil,
            durationSec and round(durationSec * ctx.fps) or nil)
        if not moved then
            return fail("Could not move the clip", moveErr)
        end
        item = moved
        if startSec then table.insert(changed, "start") end
        if durationSec then table.insert(changed, "duration") end
    end
    local function set(name, value)
        if value == nil then
            return
        end
        local ok, done = pcall(item.SetProperty, item, name, value)
        if ok and done then
            table.insert(changed, name)
        end
    end
    local zoom = tonumber(req.zoom)
    if zoom then
        set("ZoomGang", true)
        set("ZoomX", zoom)
        set("ZoomY", zoom)
    end
    set("Pan", tonumber(req.panX))
    set("Tilt", tonumber(req.panY))
    set("RotationAngle", tonumber(req.rotation))
    set("Opacity", tonumber(req.opacity))

    if type(req.text) == "string" then
        local tool = text_plus_tool(item)
        if not tool then
            return fail("Clip has no Text+ to edit", item:GetName())
        end
        local ok = pcall(tool.SetInput, tool, "StyledText", req.text)
        if ok then
            table.insert(changed, "StyledText")
        end
    end

    if #changed == 0 then
        return fail("Nothing was changed", "Resolve accepted none of the requested properties.")
    end
    local okId, newId = pcall(item.GetUniqueId, item)
    return { updated = changed, id = okId and newId or nil }
end

-- req: { ids = { ... }, ripple? }  Ripple delete closes the gap left behind.
function M.delete_clips(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local items, missing = {}, 0
    local byId = index_items(ctx.timeline)
    for _, id in ipairs((req and req.ids) or {}) do
        local found = byId[id]
        if found then
            table.insert(items, found.item)
        else
            missing = missing + 1
        end
    end
    if #items == 0 then
        return fail("Clip not found", "None of the requested clip ids are on the open timeline.")
    end
    local ok, done = pcall(ctx.timeline.DeleteClips, ctx.timeline, items, req.ripple == true)
    if not ok or not done then
        return fail("Resolve refused to delete the clips", ok and "" or done)
    end
    return { deleted = #items, missing = missing }
end

return M
