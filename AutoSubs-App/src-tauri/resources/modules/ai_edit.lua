---@diagnostic disable: undefined-global
--
-- Timeline endpoints for AI Edit: read the open timeline (clips and markers),
-- add markers, change a clip's transform or Text+ text, and delete clips.
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

local function find_item(timeline, id)
    local found
    each_item(timeline, function(item)
        local ok, itemId = pcall(item.GetUniqueId, item)
        if ok and itemId == id then
            found = item
            return true
        end
    end)
    return found
end

-- The first Text+ tool in a Fusion title clip, or nil.
local function text_plus_tool(item)
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
                local clip = {
                    id = item:GetUniqueId(),
                    name = item:GetName() or "",
                    startSec = (item:GetStart() - start) / fps,
                    durationSec = (item:GetEnd() - item:GetStart()) / fps,
                }
                if kind == "video" then
                    clip.zoom = property(item, "ZoomX")
                    clip.panX = property(item, "Pan")
                    clip.panY = property(item, "Tilt")
                    clip.rotation = property(item, "RotationAngle")
                    local tool = text_plus_tool(item)
                    if tool then
                        local okText, text = pcall(tool.GetInput, tool, "StyledText")
                        if okText and type(text) == "string" then
                            clip.text = text
                        end
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
                table.insert(lines, string.format("Added %s marker \"%s\" at %.2fs.", color, name, atSec))
            else
                skipped = skipped + 1
                table.insert(lines, string.format(
                    "Could not add a marker at %.2fs (one may already be on that frame).", atSec))
            end
        end
    end
    return { added = added, skipped = skipped, lines = lines }
end

-- req: { id, zoom?, panX?, panY?, rotation?, opacity?, text? }
-- Resolve's scripting API cannot move or retime a clip, so only the transform,
-- opacity and Text+ text are editable here.
function M.update_clip(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local item = find_item(ctx.timeline, req and req.id)
    if not item then
        return fail("Clip not found", "No clip with id " .. tostring(req and req.id))
    end

    local changed = {}
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
    return { updated = changed }
end

-- req: { ids = { ... }, ripple? }  Ripple delete closes the gap left behind.
function M.delete_clips(req)
    local ctx, err = current_timeline()
    if not ctx then
        return err
    end
    local items, missing = {}, 0
    for _, id in ipairs((req and req.ids) or {}) do
        local item = find_item(ctx.timeline, id)
        if item then
            table.insert(items, item)
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
