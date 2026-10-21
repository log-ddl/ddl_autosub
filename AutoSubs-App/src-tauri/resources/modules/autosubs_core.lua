---These are global variables given to us by the Resolve embedded LuaJIT environment
---I disable the undefined global warnings for them to stop my editor from complaining
---@diagnostic disable: undefined-global, deprecated
--
-- Resolve 21.1 sandboxes the Lua state that runs Workspace > Scripts scripts:
-- io, ffi, package, require, os.execute and bmd.readdir are all nil here.
-- Modules are loaded via AutoSubs_require (see bootstrap.lua) and the bridge
-- to the desktop app is a file mailbox (request.lua read via loadfile;
-- responses written to Fusion.prefs via SetPrefs/SavePrefs).

-- Shared access to the Resolve / Fusion scripting environment (see resolve_env.lua).
local resolve_env = AutoSubs_require("resolve_env")

-- resolve is provided implicitly by the Resolve environment - no need to call Resolve() unless running in terminal
local resolve = resolve_env.get_resolve()
local fusion = resolve_env.get_fusion()

local DEV_MODE = false

-- App version reported by the GetVersion endpoint; used to detect stale servers.
local VERSION = AutoSubs_require("version")

local function join_path(dir, filename)
    local sep = AUTOSUBS_SEP or "/"
    -- Remove trailing separator from dir, if any
    if dir:sub(-1) == sep then
        return dir .. filename
    else
        return dir .. sep .. filename
    end
end

-- Load external libraries. These are required lazily in Init(), so the language
-- server would otherwise infer them as `nil` here and flag every later use.
---@type any
local json = nil
---@type any
local timecode = nil
---@type any
local font_fallback = nil

-- OS SPECIFIC CONFIGURATION
local resources_path
local main_app
-- Full path to the mailbox request file the desktop app writes (set in Init).
local REQUEST_FILE

-- Load Resolve objects
local projectManager = resolve:GetProjectManager()
local project = projectManager:GetCurrentProject()
local mediaPool = project:GetMediaPool()

local CAPTION_TEMPLATE_VERSION = AutoSubs_require("caption_template_version")
local caption_style = AutoSubs_require("caption_style")
-- AI Edit timeline endpoints (snapshot, markers, clip edits).
local ai_edit = AutoSubs_require("ai_edit")
local ANIMATED_CAPTION_DISPLAY_NAME = caption_style.DISPLAY_NAME
local ANIMATED_CAPTION = caption_style.versioned_name(CAPTION_TEMPLATE_VERSION)
local AUTOSUBS_BIN = caption_style.BIN_NAME
local MEDIA_POOL_UNAVAILABLE = "Resolve media pool is not available"
local defaultTemplateImportAttempted = false
local lastProjectId = project:GetUniqueId()
-- Result of the last full media pool template scan (see get_templates):
-- valid only while the pool fingerprint below still matches.
local templatesCache = { fingerprint = nil, list = nil }

-- Refresh the cached project / mediaPool references and detect project
-- switches. When the user opens a different Resolve project the old
-- mediaPool no longer contains the AutoSubs Caption template, so we
-- must reset the one-shot import guard so get_templates() will try
-- the import again. The template list cache is per project too.
local function refresh_project()
    project = projectManager:GetCurrentProject()
    mediaPool = project:GetMediaPool()
    local currentId = project:GetUniqueId()
    if currentId ~= lastProjectId then
        defaultTemplateImportAttempted = false
        templatesCache.fingerprint = nil
        templatesCache.list = nil
        lastProjectId = currentId
    end
end


-- Global state for an active caption-preset edit session.
-- Populated by OpenPresetEdit, consumed/cleared by SavePresetEdit or
-- CancelPresetEdit. Holds just enough Resolve handles to read the tool's input
-- values and tear the temporary clip down again.
local presetEditSession = nil

-- Global state for export operations
local currentExportJob = {
    active = false,
    pid = nil,
    progress = 0,
    cancelled = false,
    startTime = nil,
    audioInfo = {
        path = "",
        markIn = 0,  -- mark in (frames) - may display in UI as timecode
        markOut = 0, -- mark out (frames) - may display in UI as timecode
        offset = 0   -- offset on timeline in seconds (regardless of timeline start)
    },
    trackStates = nil,
    clipBoundaries = nil,
    -- Captured before ExportAudio, restored by restore_user_state() in AddSubtitles.
    savedMarks = nil, -- raw GetMarkInOut() dict (relative frame values)
    -- Render config captured before ExportAudio pushes audio-only settings,
    -- restored by cleanup_render_job() on every export exit path.
    renderSnapshot = nil,
    -- One-shot flag: a job that never left the queue gets a single restart.
    restartAttempted = false
}

-- Helper that wraps a Resolve-facing operation in pcall and returns a
-- structured `{ error = <short reason>, detail = <underlying error> }` on
-- failure, or the function's result on success. Used so the frontend error
-- dialog can surface the actual error from Resolve instead of a generic
-- "something went wrong".
local function make_error(short, detail, code)
    -- `code` lets the frontend localize this failure (it maps the code to a
    -- translation key); `error`/`detail` stay as the raw technical fallback.
    return { error = short, detail = tostring(detail or ""), code = code }
end

-- Convert seconds to frames based on the timeline frame rate
local function to_frames(seconds, frameRate)
    return seconds * frameRate
end

-- input of time in seconds
function JumpToTime(seconds)
    local timeline = project:GetCurrentTimeline()
    local frameRate = tonumber(timeline:GetSetting("timelineFrameRate"))
    local frames = to_frames(seconds, frameRate) + timeline:GetStartFrame() + 1
    local tc = timecode.timecode_from_frame_auto(frames, frameRate,
        timeline:GetSetting("timelineDropFrameTimecode"))
    timeline:SetCurrentTimecode(tc)
end

-- List of title strings to search for
local titleStrings = {
    "Título – Fusion", -- Spanish
    "Título Fusion", -- Portuguese
    "Generator", -- English (older versions)
    "Fusion Title", -- English
    "Titre Fusion", -- French
    "Титры на стр. Fusion", -- Russian
    "Fusion Titel", -- German
    "Titolo Fusion", -- Italian
    "Fusionタイトル", -- Japanese
    "Fusion标题", -- Chinese
    "퓨전 타이틀", -- Korean (some Resolve versions)
    "Fusion 타이틀", -- Korean (Resolve 21)
    "Tiêu đề Fusion", -- Vietnamese
    "Fusion Titles" -- Thai
}

-- Helper function to check if a string is in the titleStrings list
-- Build quick lookup set for titleStrings for O(1) membership checks
local titleSet = {}
for _, t in ipairs(titleStrings) do
    titleSet[t] = true
end

local function is_matching_title(title)
    return titleSet[title] == true
end

-- Resolve exposes media pool folders / clips as either tables or userdata
-- depending on the host version, so never test for "table" alone.
local function is_api_object(obj)
    local t = type(obj)
    return t == "table" or t == "userdata"
end

-- Resolve can return nil instead of an empty list from GetSubFolderList /
-- GetClipList (e.g. while a project is still loading), which crashes ipairs().
local function safe_list(list)
    if type(list) == "table" then
        return list
    end
    return {}
end

local function call_api(obj, method, ...)
    if not is_api_object(obj) then
        return nil
    end
    local ok, fn = pcall(function() return obj[method] end)
    if not ok or type(fn) ~= "function" then
        return nil
    end
    local callOk, result = pcall(fn, obj, ...)
    if not callOk then
        return nil
    end
    return result
end

-- GetClipProperty(key) can fail on clips that Resolve has not fully resolved
-- yet. Always query a single key: the no-argument form builds a full property
-- dict per clip, which is what made media pool scans expensive.
local function clip_property(clip, key)
    return call_api(clip, "GetClipProperty", key)
end

local function walk_media_pool(folder, onClip)
    if not is_api_object(folder) then
        return
    end

    -- Recurse into subfolders first
    for _, subfolder in ipairs(safe_list(call_api(folder, "GetSubFolderList"))) do
        local stop = walk_media_pool(subfolder, onClip)
        if stop then return true end
    end

    -- Visit all clips in this folder
    for _, clip in ipairs(safe_list(call_api(folder, "GetClipList"))) do
        local stop = onClip(clip, folder)
        if stop then return true end
    end
end

local get_templates
local get_template_item
local get_video_tracks
local get_audio_tracks
local get_subtitle_tracks

local function resolve_template_name(templateName)
    if templateName == ANIMATED_CAPTION_DISPLAY_NAME then
        return ANIMATED_CAPTION
    end
    return templateName
end

local function get_root_subfolder(rootFolder, folderName)
    for _, subfolder in ipairs(safe_list(call_api(rootFolder, "GetSubFolderList"))) do
        if call_api(subfolder, "GetName") == folderName then
            return subfolder
        end
    end
    return nil
end

local function find_template_item(folder, templateName)
    local template, sourceBin
    templateName = resolve_template_name(templateName)
    -- The bundled animated template is versioned ("AutoSubs Caption <date>"),
    -- so an older caption-bin.drb or a version skew between builds must still
    -- match. Any other name is compared exactly.
    local wantsAnimated = caption_style.is_autosubs_template(templateName)
    walk_media_pool(folder, function(clip, clipFolder)
        local clipName = clip_property(clip, "Clip Name")
        if clipName == templateName or (wantsAnimated and caption_style.is_autosubs_template(clipName)) then
            template = clip
            sourceBin = clipFolder
            return true
        end
    end)
    return template, sourceBin
end

local function delete_obsolete_caption_templates(autosubsFolder, currentTemplate)
    local obsoleteTemplates = {}
    local currentTemplateId = call_api(currentTemplate, "GetUniqueId")
    if currentTemplateId == nil then
        -- Without a reliable id for the template we just imported, a cleanup
        -- pass could delete that very clip. Leave the bin untouched instead.
        print("Skipping obsolete caption template cleanup: current template has no unique id")
        return
    end
    for _, clip in ipairs(safe_list(call_api(autosubsFolder, "GetClipList"))) do
        local clipName = clip_property(clip, "Clip Name")
        if call_api(clip, "GetUniqueId") ~= currentTemplateId and caption_style.is_autosubs_template(clipName) then
            table.insert(obsoleteTemplates, clip)
        end
    end
    if #obsoleteTemplates == 0 then
        return
    end

    local deleted, deleteResult = pcall(function()
        return mediaPool:DeleteClips(obsoleteTemplates)
    end)
    if not deleted or not deleteResult then
        print("Failed to delete obsolete AutoSubs caption templates")
    end
end

-- Add default template to mediapool if not available (get version with resolve:GetVersion()[1])
local function ensure_default_template(rootFolder)
    local template = find_template_item(rootFolder, ANIMATED_CAPTION)
    if template then
        return template
    end
    if defaultTemplateImportAttempted then
        return nil
    end

    local targetBin = get_root_subfolder(rootFolder, AUTOSUBS_BIN)
    print("Default template not found. Importing default template...")
    defaultTemplateImportAttempted = true
    local previousFolder = nil
    pcall(function()
        previousFolder = mediaPool:GetCurrentFolder()
        mediaPool:SetCurrentFolder(rootFolder)
    end)
    local imported, importResult = pcall(function()
        return mediaPool:ImportFolderFromFile(join_path(resources_path, "caption-bin.drb"))
    end)
    if previousFolder then
        pcall(function()
            mediaPool:SetCurrentFolder(previousFolder)
        end)
    end
    if not imported or not importResult then
        print("Failed to import default template")
        return nil
    end

    local sourceBin
    template, sourceBin = find_template_item(rootFolder, ANIMATED_CAPTION)
    if not template or not sourceBin then
        print("Imported caption bin did not contain '" .. ANIMATED_CAPTION .. "'")
        return nil
    end
    if not targetBin then
        return template
    end

    local moved, moveResult = pcall(function()
        return mediaPool:MoveClips({ template }, targetBin)
    end)
    if not moved or not moveResult then
        print("Failed to move imported caption template into AutoSubs media pool folder")
        return nil
    end

    delete_obsolete_caption_templates(targetBin, template)
    local remainingClips = safe_list(call_api(sourceBin, "GetClipList"))
    if #remainingClips > 0 then
        mediaPool:DeleteClips(remainingClips)
    end
    mediaPool:DeleteFolders({ sourceBin })
    return template
end

-- Cheap structural fingerprint of the media pool: one API call per folder
-- (subfolder list + clip list) rather than one per clip. Used to skip the
-- expensive template scan when nothing moved. It can't see same-count
-- edits (a renamed or swapped title), which is why callers may force a
-- rescan.
local function media_pool_fingerprint(rootFolder)
    local parts = {}
    local function visit(folder)
        for _, subfolder in ipairs(safe_list(call_api(folder, "GetSubFolderList"))) do
            visit(subfolder)
        end
        parts[#parts + 1] = tostring(call_api(folder, "GetName"))
            .. "#" .. tostring(#safe_list(call_api(folder, "GetClipList")))
    end
    if is_api_object(rootFolder) then
        visit(rootFolder)
    end
    return table.concat(parts, "|")
end

-- Get a list of all Text+ templates in the media pool. The scan costs one
-- marshaled Resolve API call per media pool clip, which stalls the mailbox
-- loop for a long time on large pools (the app's template dropdown used to
-- time out waiting for it), so the result is cached per project and only
-- re-scanned when the fingerprint above changes or `force` is set.
get_templates = function(force)
    local rootFolder = call_api(mediaPool, "GetRootFolder")
    if not force and templatesCache.list ~= nil
        and media_pool_fingerprint(rootFolder) == templatesCache.fingerprint then
        return templatesCache.list
    end

    local t = {}
    local hasAnimated = ensure_default_template(rootFolder) ~= nil

    walk_media_pool(rootFolder, function(clip)
        -- Filter on Type first: a single-key lookup per clip instead of a
        -- full GetClipProperty() dict for every clip in the pool.
        if not is_matching_title(clip_property(clip, "Type")) then
            return
        end
        local clipName = clip_property(clip, "Clip Name")
        if clipName == nil then
            return
        end
        -- Any versioned "AutoSubs Caption <version>" clip (and legacy
        -- unversioned copies) collapse into a single user-facing entry.
        if caption_style.is_autosubs_template(clipName) then
            hasAnimated = true
        else
            table.insert(t, { label = clipName, value = clipName })
        end
    end)

    if hasAnimated then
        table.insert(t, 1, { label = ANIMATED_CAPTION_DISPLAY_NAME, value = ANIMATED_CAPTION_DISPLAY_NAME })
    end

    -- Fingerprint after the scan: ensure_default_template may have imported,
    -- moved or deleted clips, so the stored value reflects the final state.
    templatesCache.fingerprint = media_pool_fingerprint(rootFolder)
    templatesCache.list = t
    return t
end

-- Find the template item with the specified name using media pool traversal
get_template_item = find_template_item

function GetTimelineInfo()
    -- Get project and media pool (resets template-import flag on project switch)
    refresh_project()

    -- Get timeline info
    local timelineInfo = {}
    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        timelineInfo = {
            name = timeline:GetName(),
            timelineId = timeline:GetUniqueId(),
            timelineStart = timeline:GetStartFrame() / timeline:GetSetting("timelineFrameRate"),
            projectName = project:GetName(),
            -- Two projects can share a name, so anything caching per project
            -- needs the id. Older Resolve builds have no GetUniqueId on
            -- Project, hence the pcall and the empty-string fallback.
            projectId = (function()
                local ok, id = pcall(project.GetUniqueId, project)
                return (ok and type(id) == "string") and id or ""
            end)(),
        }
    end)
    if not success then
        print("Error retrieving timeline info:", err)
        timelineInfo = {
            timelineId = "",
            name = "No timeline selected"
        }
    else
        timelineInfo["outputTracks"] = get_video_tracks()
        timelineInfo["inputTracks"] = get_audio_tracks()
        timelineInfo["subtitleTracks"] = get_subtitle_tracks()
    end
    return timelineInfo
end

function GetTemplates(force)
    refresh_project()
    return get_templates(force)
end

function GetVersion()
    return { version = VERSION, captionTemplateVersion = CAPTION_TEMPLATE_VERSION }
end

-- ===================== AutoEdit =====================
-- AutoEdit actions run through this Lua server because the free edition of
-- Resolve rejects external scripting connections (scriptapp returns nil for
-- any out-of-process caller; only Studio allows it). Everything below executes
-- inside Resolve where the API is always available.

-- The built-in AutoEdit actions below are plain Lua, so they need no Python
-- at all — they work even before the app has downloaded its Python runtime.

function GetResolveInfo()
    refresh_project()
    local lines = {}
    local ok, err = pcall(function()
        lines[#lines + 1] = "Resolve version: " .. resolve:GetVersionString()
        lines[#lines + 1] = "Project:         " .. project:GetName()
        lines[#lines + 1] = "Timelines:       " .. tostring(project:GetTimelineCount())

        local timeline = project:GetCurrentTimeline()
        if not timeline then
            lines[#lines + 1] = "(no timeline currently open)"
            return
        end

        lines[#lines + 1] = ""
        lines[#lines + 1] = "Current timeline: " .. timeline:GetName()
        lines[#lines + 1] = "  Frame rate:     " .. tostring(timeline:GetSetting("timelineFrameRate"))
        lines[#lines + 1] = "  Resolution:     " .. tostring(timeline:GetSetting("timelineResolutionWidth")) ..
            "x" .. tostring(timeline:GetSetting("timelineResolutionHeight"))
        lines[#lines + 1] = "  Start TC:       " .. tostring(timeline:GetStartTimecode())

        local videoTracks = timeline:GetTrackCount("video")
        local audioTracks = timeline:GetTrackCount("audio")
        lines[#lines + 1] = "  Video tracks:   " .. tostring(videoTracks)
        lines[#lines + 1] = "  Audio tracks:   " .. tostring(audioTracks)

        local totalClips = 0
        for i = 1, videoTracks do
            local clips = timeline:GetItemListInTrack("video", i) or {}
            totalClips = totalClips + #clips
        end
        lines[#lines + 1] = "  Video clips:    " .. tostring(totalClips)
    end)
    if not ok then
        return make_error("Could not read project info", err)
    end
    return { lines = lines }
end

function AddMarkerAtPlayhead()
    refresh_project()
    local resultLines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end

        -- The playhead reports a timecode string; convert it to a frame
        -- relative to the timeline start, which is what AddMarker expects.
        local tc = timeline:GetCurrentTimecode()
        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local clean = tc:gsub(";", ":")
        local hh, mm, ss, ff = clean:match("^(%d+):(%d+):(%d+):(%d+)$")
        if not hh then
            error("Unrecognised timecode: " .. tostring(tc), 0)
        end

        local currentFrame = math.floor((hh * 3600 + mm * 60 + ss) * fps + ff + 0.5)
        local frameId = currentFrame - timeline:GetStartFrame()
        if frameId < 0 then
            error("Playhead " .. tc .. " is before the timeline start; nothing to do.", 0)
        end

        local added = timeline:AddMarker(frameId, "Blue", "AutoEdit marker",
            "Added by AutoSubs AutoEdit", 1, "")
        if not added then
            error("AddMarker failed. A marker may already exist at this frame.", 0)
        end
        resultLines = { "Added blue marker at " .. tc .. " (frame " .. frameId .. ")." }
    end)
    if not ok then
        return make_error("Could not add marker", err)
    end
    return { lines = resultLines }
end

-- Format a frame offset from the timeline start as a YouTube chapter stamp.
-- YouTube wants H:MM:SS once past an hour and M:SS below it, and the first
-- chapter must be exactly 0:00 or it rejects the whole list.
local function youtube_stamp(frames, fps)
    local total = math.floor(frames / fps)
    local h = math.floor(total / 3600)
    local m = math.floor((total % 3600) / 60)
    local s = total % 60
    if h > 0 then
        return string.format("%d:%02d:%02d", h, m, s)
    end
    return string.format("%d:%02d", m, s)
end

-- Markers sorted by position, as { frame = <relative frame>, name, color }.
local function sorted_markers(timeline)
    local markers = timeline:GetMarkers()
    local list = {}
    if type(markers) == "table" then
        for frame, info in pairs(markers) do
            list[#list + 1] = {
                frame = tonumber(frame) or 0,
                name = (type(info) == "table" and info.name) or "",
                color = (type(info) == "table" and info.color) or "",
            }
        end
    end
    table.sort(list, function(a, b) return a.frame < b.frame end)
    return list
end

-- Turn timeline markers into a YouTube chapter list ready to paste into a
-- video description.
function GetYoutubeChapters()
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local markers = sorted_markers(timeline)
        if #markers == 0 then
            error("This timeline has no markers yet. Add markers where each " ..
                "chapter starts, then run this again.", 0)
        end

        lines = {}
        -- GetMarkers() reports frames relative to the timeline start already,
        -- so a marker at the very beginning is frame 0.
        if markers[1].frame > 0 then
            lines[#lines + 1] = "0:00 Intro"
        end
        for _, marker in ipairs(markers) do
            local title = marker.name
            if title == nil or title == "" then
                title = "Chapter " .. (#lines + 1)
            end
            lines[#lines + 1] = youtube_stamp(marker.frame, fps) .. " " .. title
        end

        if #lines < 3 then
            lines[#lines + 1] = ""
            lines[#lines + 1] = "(YouTube needs at least 3 chapters, the first at 0:00.)"
        end
    end)
    if not ok then
        return make_error("Could not build the chapter list", err)
    end
    return { lines = lines }
end

-- Drop a marker on every clip boundary of a video track, so a review pass can
-- jump cut to cut with the up/down arrows.
function MarkClipCuts(trackIndex)
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end

        local track = tonumber(trackIndex) or 1
        local trackCount = timeline:GetTrackCount("video")
        if track < 1 or track > trackCount then
            error("Video track " .. track .. " does not exist (timeline has " ..
                trackCount .. ").", 0)
        end

        local clips = timeline:GetItemListInTrack("video", track) or {}
        if #clips == 0 then
            error("Video track " .. track .. " is empty.", 0)
        end

        local timelineStart = timeline:GetStartFrame()
        local added, skipped = 0, 0
        for index, clip in ipairs(clips) do
            -- GetStart() is absolute; AddMarker wants an offset from the start.
            local frameId = clip:GetStart() - timelineStart
            if frameId >= 0 then
                local name = clip:GetName() or ("Clip " .. index)
                -- Fails when a marker already sits on this frame, which is
                -- expected on a re-run; count those instead of aborting.
                if timeline:AddMarker(frameId, "Cyan", name, "Clip boundary", 1, "") then
                    added = added + 1
                else
                    skipped = skipped + 1
                end
            end
        end

        lines = {
            "Marked " .. added .. " clip boundaries on video track " .. track .. ".",
        }
        if skipped > 0 then
            lines[#lines + 1] = skipped .. " already had a marker and were left alone."
        end
        lines[#lines + 1] = "Use 'Clear markers' to remove them again."
    end)
    if not ok then
        return make_error("Could not mark clip cuts", err)
    end
    return { lines = lines }
end

-- Remove markers from the timeline, optionally only those of one colour.
function ClearTimelineMarkers(color)
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end

        local target = (type(color) == "string" and color ~= "") and color or "All"
        local before = #sorted_markers(timeline)
        if before == 0 then
            lines = { "This timeline has no markers." }
            return
        end

        timeline:DeleteMarkersByColor(target)
        local removed = before - #sorted_markers(timeline)
        lines = {
            "Removed " .. removed .. " of " .. before .. " markers" ..
            (target == "All" and "." or (" (colour: " .. target .. ")." )),
        }
    end)
    if not ok then
        return make_error("Could not clear markers", err)
    end
    return { lines = lines }
end

-- Clips on a track, ordered along the timeline and carrying frames measured
-- from the timeline start (which is what AddMarker expects).
local function track_items(timeline, trackType, trackIndex)
    local timelineStart = timeline:GetStartFrame()
    local items = {}
    for _, clip in ipairs(timeline:GetItemListInTrack(trackType, trackIndex) or {}) do
        items[#items + 1] = {
            clip = clip,
            first = clip:GetStart() - timelineStart,
            last = clip:GetEnd() - timelineStart,
        }
    end
    table.sort(items, function(a, b) return a.first < b.first end)
    return items
end

-- Marker names have to stay readable in Resolve's marker list.
local function shorten(text, limit)
    text = tostring(text or ""):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
    if #text > limit then
        return text:sub(1, limit - 1) .. "\u{2026}"
    end
    return text
end

local function require_subtitle_track(timeline, trackIndex)
    local count = timeline:GetTrackCount("subtitle")
    if count == 0 then
        error("This timeline has no subtitle track. Generate subtitles with " ..
            "AutoSubs first, then run this again.", 0)
    end
    local track = tonumber(trackIndex) or 1
    if track < 1 or track > count then
        error("Subtitle track " .. track .. " does not exist (timeline has " ..
            count .. ").", 0)
    end
    return track
end

-- Turn every subtitle into a marker carrying its text, so the marker list
-- doubles as a clickable transcript index.
function MarkersFromSubtitles(trackIndex)
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        local track = require_subtitle_track(timeline, trackIndex)

        local items = track_items(timeline, "subtitle", track)
        if #items == 0 then
            error("Subtitle track " .. track .. " is empty.", 0)
        end

        local added, skipped = 0, 0
        for _, item in ipairs(items) do
            if item.first >= 0 then
                local text = shorten(item.clip:GetName(), 60)
                if timeline:AddMarker(item.first, "Sand", text, "From subtitles", 1, "") then
                    added = added + 1
                else
                    skipped = skipped + 1
                end
            end
        end

        lines = { "Added " .. added .. " markers from " .. #items .. " subtitles." }
        if skipped > 0 then
            lines[#lines + 1] = skipped .. " frames already had a marker and were left alone."
        end
    end)
    if not ok then
        return make_error("Could not create markers from subtitles", err)
    end
    return { lines = lines }
end

-- Find the silences between subtitles: the pauses worth tightening, and the
-- natural places a new section (and so a chapter) begins.
function MarkSpeechGaps(minSeconds, trackIndex)
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        local track = require_subtitle_track(timeline, trackIndex)

        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local threshold = tonumber(minSeconds) or 2
        if threshold <= 0 then threshold = 2 end
        local minFrames = threshold * fps

        local items = track_items(timeline, "subtitle", track)
        if #items < 2 then
            error("Need at least two subtitles to measure the pauses between them.", 0)
        end

        local added, longest = 0, 0
        for i = 1, #items - 1 do
            local gap = items[i + 1].first - items[i].last
            if gap >= minFrames then
                local seconds = gap / fps
                if seconds > longest then longest = seconds end
                local label = string.format("Pause %.1fs", seconds)
                if timeline:AddMarker(items[i].last, "Lemon", label, "Silence between subtitles", 1, "") then
                    added = added + 1
                end
            end
        end

        if added == 0 then
            lines = {
                string.format("No pauses of %.1fs or longer between subtitles.", threshold),
                "The edit is already tight, or try a smaller threshold.",
            }
            return
        end

        lines = {
            string.format("Marked %d pauses of %.1fs or longer.", added, threshold),
            string.format("Longest pause: %.1fs.", longest),
            "Jump between them with the up/down arrows in Resolve.",
        }
    end)
    if not ok then
        return make_error("Could not find speech gaps", err)
    end
    return { lines = lines }
end

-- Report holes in a video track. A gap plays as black, so an unintended one
-- is worth catching before the export rather than after upload.
function FindTimelineGaps(trackIndex)
    refresh_project()
    local lines
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end

        local track = tonumber(trackIndex) or 1
        local trackCount = timeline:GetTrackCount("video")
        if track < 1 or track > trackCount then
            error("Video track " .. track .. " does not exist (timeline has " ..
                trackCount .. ").", 0)
        end

        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local items = track_items(timeline, "video", track)
        if #items == 0 then
            error("Video track " .. track .. " is empty.", 0)
        end

        lines = {}
        local gaps = 0

        -- A track that doesn't start at zero opens on black.
        if items[1].first > 0 then
            gaps = gaps + 1
            lines[#lines + 1] = string.format("  %s  gap of %.2fs before the first clip",
                youtube_stamp(0, fps), items[1].first / fps)
            timeline:AddMarker(0, "Red", "Gap", "Empty space on the video track", 1, "")
        end

        for i = 1, #items - 1 do
            local gapFrames = items[i + 1].first - items[i].last
            if gapFrames > 0 then
                gaps = gaps + 1
                lines[#lines + 1] = string.format("  %s  gap of %.2fs after '%s'",
                    youtube_stamp(items[i].last, fps), gapFrames / fps,
                    shorten(items[i].clip:GetName(), 40))
                timeline:AddMarker(items[i].last, "Red", "Gap", "Empty space on the video track", 1, "")
            end
        end

        if gaps == 0 then
            lines = { "No gaps on video track " .. track .. " - " .. #items ..
                " clips run back to back." }
            return
        end

        table.insert(lines, 1, "Found " .. gaps .. " gap(s) on video track " ..
            track .. ", marked in red:")
    end)
    if not ok then
        return make_error("Could not check for gaps", err)
    end
    return { lines = lines }
end

-- Registry of Resolve API objects handed out to the Python bridge. The
-- external script only ever holds integer ids; every method call comes back
-- here to be executed against the real object.
--
-- Ids are never reused and the table is only cleared between runs, so a script
-- that walks a large timeline will accumulate entries for the duration of that
-- run. That is bounded by the script itself and freed by ResetResolveRpc.
local rpcObjects = {}
local rpcNextId = 0

local function rpc_register(obj)
    rpcNextId = rpcNextId + 1
    rpcObjects[rpcNextId] = obj
    return rpcNextId
end

-- Resolve API objects are userdata in most builds, but appear as tables with a
-- metatable in others. Plain data returned by the API (GetClipProperty, track
-- lists, ...) is always a bare table with no metatable, which is what lets us
-- tell the two apart.
local function is_rpc_api_object(v)
    local t = type(v)
    if t == "userdata" then
        return true
    end
    if t ~= "table" then
        return false
    end
    return getmetatable(v) ~= nil
end

local rpc_encode_data

-- Convert a plain data table for JSON, turning any API objects nested inside
-- it (e.g. the clip list from GetItemListInTrack) into object handles.
rpc_encode_data = function(v, depth)
    if is_rpc_api_object(v) then
        return { __resolve_obj = rpc_register(v) }
    end
    if type(v) ~= "table" then
        return v
    end
    if depth > 8 then
        return tostring(v)
    end
    local out = {}
    for k, item in pairs(v) do
        out[k] = rpc_encode_data(item, depth + 1)
    end
    return out
end

local function rpc_encode(v)
    if v == nil then
        return { kind = "nil" }
    end
    local t = type(v)
    if t == "boolean" or t == "number" or t == "string" then
        return { kind = "value", value = v }
    end
    if is_rpc_api_object(v) then
        return { kind = "object", id = rpc_register(v) }
    end
    if t == "table" then
        return { kind = "data", value = rpc_encode_data(v, 0) }
    end
    return { kind = "value", value = tostring(v) }
end

-- Turn an argument sent by the Python side back into a Lua value, swapping
-- object handles for the objects they refer to.
local function rpc_decode(v)
    if type(v) ~= "table" then
        return v
    end
    if v.__resolve_obj then
        return rpcObjects[v.__resolve_obj]
    end
    local out = {}
    for k, item in pairs(v) do
        out[k] = rpc_decode(item)
    end
    return out
end

-- Drop every object handle from the previous script run. Called by the app
-- before it launches a new one so long sessions don't leak.
function ResetResolveRpc()
    rpcObjects = {}
    rpcNextId = 0
    return { ok = true }
end

-- Execute one method call on behalf of the external Python script.
-- objectId 0 is the root `resolve` object.
function ResolveRpc(objectId, method, args, argCount)
    if type(method) ~= "string" or method == "" then
        return make_error("No method name provided", "")
    end

    local target
    if objectId == 0 or objectId == nil then
        target = resolve
    else
        target = rpcObjects[objectId]
    end
    if target == nil then
        return make_error("Unknown Resolve object",
            "Object " .. tostring(objectId) .. " is no longer available. It may " ..
            "belong to an earlier script run.")
    end

    local decoded = {}
    local count = tonumber(argCount) or 0
    if type(args) == "table" then
        for i = 1, count do
            decoded[i] = rpc_decode(args[i])
        end
    end

    local fn = target[method]
    if fn == nil then
        return make_error("Unknown method",
            tostring(method) .. " is not available on this Resolve object.")
    end

    local ok, result = pcall(fn, target, unpack(decoded, 1, count))
    if not ok then
        return make_error("Resolve rejected " .. method .. "()", result)
    end

    local encoded
    local encodeOk, encodeErr = pcall(function()
        encoded = rpc_encode(result)
    end)
    if not encodeOk then
        return make_error("Could not return the result of " .. method .. "()", encodeErr)
    end
    return { result = encoded }
end

-- ===================== AutoEdit: timeline selection =====================
-- Read-only snapshot of clips on the current timeline (optionally restricted to
-- the user's In/Out range and to specific video/audio track indices). Every
-- clip carries an object handle to its MediaPoolItem via `media_pool_ref`,
-- which ApplyKeepSegments can decode back to the real Resolve object when
-- rebuilding the timeline on a new track.
--
-- `spec` shape (all fields optional):
--   {
--     video_tracks = { 1, 2 },   -- video tracks to include; empty => none
--     audio_tracks = { 1 },      -- audio tracks to include; empty => none
--     use_in_out   = true,       -- clip to the timeline's In/Out marks
--   }
function GetTimelineSelection(spec)
    refresh_project()
    local out
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end

        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local timelineStart = timeline:GetStartFrame()

        -- Marks are always reported, even when we are not filtering by them:
        -- an in-place cut needs every clip on the track *and* the mark range,
        -- so it can keep the material outside In/Out and ripple it left.
        local markIn, markOut = nil, nil
        if timeline.GetMarkInOut then
            local ok2, marks = pcall(timeline.GetMarkInOut, timeline)
            if ok2 and type(marks) == "table" and marks.video then
                markIn = tonumber(marks.video["in"])
                markOut = tonumber(marks.video["out"])
            end
        end

        -- `use_in_out` only controls which clips come back, never whether the
        -- marks themselves are reported.
        local filterToMarks = spec and spec.use_in_out
        local function overlaps(recIn, recOut)
            if not filterToMarks then return true end
            if not markIn or not markOut then return true end
            return recOut > markIn and recIn < markOut
        end

        local function collect_track(trackType, index)
            local trackCount = timeline:GetTrackCount(trackType)
            if index < 1 or index > trackCount then
                return {}
            end
            local clips = timeline:GetItemListInTrack(trackType, index) or {}
            local entries = {}
            for _, clip in ipairs(clips) do
                local recIn = clip:GetStart() - timelineStart
                local recOut = clip:GetEnd() - timelineStart
                if overlaps(recIn, recOut) then
                    local mpItem = nil
                    local ok3, item = pcall(clip.GetMediaPoolItem, clip)
                    if ok3 then mpItem = item end

                    local entry = {
                        track = index,
                        track_type = trackType,
                        name = clip:GetName(),
                        record_in_frame = recIn,
                        record_out_frame = recOut,
                        source_start_frame = clip:GetSourceStartFrame(),
                        source_end_frame = clip:GetSourceEndFrame(),
                        left_offset = clip:GetLeftOffset(),
                    }
                    if mpItem then
                        entry.media_pool_ref = { __resolve_obj = rpc_register(mpItem) }
                        local ok4, path = pcall(mpItem.GetClipProperty, mpItem, "File Path")
                        if ok4 and type(path) == "string" then entry.media_path = path end
                        local ok5, uid = pcall(mpItem.GetUniqueId, mpItem)
                        if ok5 and type(uid) == "string" then entry.media_pool_unique_id = uid end
                    end
                    entries[#entries + 1] = entry
                end
            end
            return entries
        end

        out = {
            fps = fps,
            timeline_name = timeline:GetName(),
            timeline_start_frame = timelineStart,
            mark_in_frame = markIn,
            mark_out_frame = markOut,
            has_in_out = markIn ~= nil and markOut ~= nil,
            video_clips = {},
            audio_clips = {},
        }

        local videoTargets = (spec and spec.video_tracks) or {}
        for _, i in ipairs(videoTargets) do
            local idx = tonumber(i)
            if idx then
                for _, e in ipairs(collect_track("video", idx)) do
                    out.video_clips[#out.video_clips + 1] = e
                end
            end
        end

        local audioTargets = (spec and spec.audio_tracks) or {}
        for _, i in ipairs(audioTargets) do
            local idx = tonumber(i)
            if idx then
                for _, e in ipairs(collect_track("audio", idx)) do
                    out.audio_clips[#out.audio_clips + 1] = e
                end
            end
        end
    end)
    if not ok then
        return make_error("Could not read timeline selection", err)
    end
    return out
end

-- Non-destructive apply: rebuilds the requested keep-segments on the target
-- video/audio track indices (creating tracks if needed). The original tracks
-- are left untouched so the user can toggle between the two.
--
-- `spec` shape:
--   {
--     target_video_track = 2,          -- index >=1 to insert video clips; 0 to skip
--     target_audio_track = 2,          -- index >=1 to insert audio clips; 0 to skip
--     segments = {                     -- ordered list, one entry per keep-range
--       {
--         track_type = "video"|"audio",
--         media_pool_ref = { __resolve_obj = <id> },
--         source_in_frame  = 1234,     -- absolute source-frame in the media
--         source_out_frame = 5678,     -- exclusive
--         record_in_frame  = 4200,     -- offset from timeline start
--       },
--       ...
--     }
--   }
function ApplyKeepSegments(spec)
    refresh_project()
    local result
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        if type(spec) ~= "table" then
            error("spec must be a table", 0)
        end

        local segments = spec.segments or {}
        if #segments == 0 then
            result = {
                lines = { "No segments to insert." },
                appended = 0,
            }
            return
        end

        local videoTarget = tonumber(spec.target_video_track) or 0
        local audioTarget = tonumber(spec.target_audio_track) or 0

        -- Ensure the target track index exists; AddTrack appends a new track
        -- at the next index, so loop until we have enough.
        local function ensure_track(kind, targetIndex)
            if targetIndex <= 0 then return end
            local existing = timeline:GetTrackCount(kind)
            while existing < targetIndex do
                if not timeline:AddTrack(kind) then
                    error("Could not add " .. kind .. " track " .. (existing + 1), 0)
                end
                existing = existing + 1
            end
        end
        ensure_track("video", videoTarget)
        ensure_track("audio", audioTarget)

        local timelineStart = timeline:GetStartFrame()
        local clipList = {}
        for _, seg in ipairs(segments) do
            local mpRef = seg.media_pool_ref
            local mpItem = nil
            if type(mpRef) == "table" and mpRef.__resolve_obj then
                mpItem = rpcObjects[tonumber(mpRef.__resolve_obj)]
            end
            if not mpItem then
                error("Segment is missing a valid media_pool_ref (object handle expired?).", 0)
            end

            -- A segment goes back to the track it came from when it says so.
            -- Cutting several tracks at once depends on this: without it every
            -- video segment would pile onto one track, collapsing V1..V3 into
            -- a single track and losing the layering.
            local kind = seg.track_type
            local ownTrack = tonumber(seg.track_index)
            local trackIndex, mediaType
            if kind == "video" and (ownTrack or videoTarget > 0) then
                trackIndex = ownTrack or videoTarget
                mediaType = 1
            elseif kind == "audio" and (ownTrack or audioTarget > 0) then
                trackIndex = ownTrack or audioTarget
                mediaType = 2
            end
            if trackIndex then
                ensure_track(kind, trackIndex)
            end
            if trackIndex then
                clipList[#clipList + 1] = {
                    mediaPoolItem = mpItem,
                    startFrame = tonumber(seg.source_in_frame),
                    endFrame = tonumber(seg.source_out_frame),
                    trackIndex = trackIndex,
                    recordFrame = timelineStart + tonumber(seg.record_in_frame),
                    mediaType = mediaType,
                }
            end
        end

        if #clipList == 0 then
            result = {
                lines = { "No segments matched the requested target tracks." },
                appended = 0,
            }
            return
        end

        local appended = mediaPool:AppendToTimeline(clipList)
        local appendedCount = 0
        if type(appended) == "table" then appendedCount = #appended end

        local lines = {
            string.format("Rebuilt %d segment(s) onto the timeline.", appendedCount),
        }
        if appendedCount < #clipList then
            lines[#lines + 1] = string.format(
                "Warning: Resolve accepted %d of %d requested inserts.",
                appendedCount, #clipList)
        end
        result = {
            lines = lines,
            appended = appendedCount,
            requested = #clipList,
        }
    end)
    if not ok then
        return make_error("Could not apply keep segments", err)
    end
    return result
end

-- Applies each clip's static transform. `effects[i]` is the effect table for
-- `appended[i]` (may be nil). Only fields that are present get set, so effect
-- presets stay additive and forgiving. This is the single place slideshow
-- effects land: a new scriptable field is one more branch here, and a future
-- Fusion-macro effect would import its macro here too.
local function apply_storyboard_effects(appended, effects)
    if type(appended) ~= "table" then return end
    for i, tItem in ipairs(appended) do
        local fx = effects[i]
        if tItem and type(fx) == "table" then
            pcall(function()
                local zoom = tonumber(fx.zoom)
                if zoom and zoom ~= 1 then
                    tItem:SetProperty("ZoomGang", true)
                    tItem:SetProperty("ZoomX", zoom)
                    tItem:SetProperty("ZoomY", zoom)
                end
                local panX = tonumber(fx.pan_x)
                if panX and panX ~= 0 then tItem:SetProperty("Pan", panX) end
                local panY = tonumber(fx.pan_y)
                if panY and panY ~= 0 then tItem:SetProperty("Tilt", panY) end
                local rot = tonumber(fx.rotation)
                if rot and rot ~= 0 then tItem:SetProperty("RotationAngle", rot) end
            end)
        end
    end
end

-- Comparable form of a media path: Resolve reports "File Path" with the host's
-- separators and Windows paths are case-insensitive, so neither can be trusted
-- for a raw string compare.
local function media_path_key(path)
    if type(path) ~= "string" or #path == 0 then return nil end
    return (path:gsub("\\", "/"):lower())
end

-- Index every clip already in the media pool by file path. Built once per
-- storyboard so a repeat "add to timeline" reuses what the project has instead
-- of importing a second copy of the same file (Resolve's ImportMedia happily
-- creates duplicate entries for a path it already holds). Premiere's side does
-- the same thing in ppro.ts's importOne.
local function build_media_index()
    local index = {}
    local root = mediaPool:GetRootFolder()
    if not root then return index end
    pcall(walk_media_pool, root, function(clip)
        local ok, p = pcall(clip.GetClipProperty, clip, "File Path")
        if ok then
            local key = media_path_key(p)
            -- First one wins: if the project already holds duplicates, reusing
            -- the same one every time keeps this run's placements consistent.
            if key and not index[key] then index[key] = clip end
        end
    end)
    return index
end

-- The media pool item for `path`, imported only if the project doesn't already
-- have it. Newly imported items go into the index so repeats within one
-- storyboard (the same clip used for two sentences) also reuse a single item.
local function import_media_once(index, path)
    local key = media_path_key(path)
    if not key then return nil end
    if index[key] then return index[key] end
    local imp = mediaPool:ImportMedia({ path })
    local item = (type(imp) == "table") and imp[1] or nil
    if item then index[key] = item end
    return item
end

-- Build a "slideshow" onto the timeline: import each supplied media file and
-- drop it at the exact record time of the sentence it belongs to, so the visual
-- changes track the voice-over. Stills are shown for their sentence's whole
-- span; videos are placed in FULL with their audio (never trimmed), and clips
-- are laid back-to-back so a full-length video doesn't cover the clips after
-- it. An optional static punch-in zoom adds life without any keyframing
-- (Resolve scripting cannot keyframe or add transitions — those stay a
-- Fusion-template concern).
--
-- `spec`:
--   {
--     target_video_track = 1,     -- >=1, created if it doesn't exist yet
--     default_still_secs = 3,     -- fallback duration for a 0/absent span
--     items = {                   -- in order (may be empty for audio-only)
--       { path=..., start=<sec>, ["end"]=<sec>,
--         effect = { zoom=1.08, pan_x=0, pan_y=0, rotation=0 } },  -- all optional
--       ...
--     },
--     audio_path = "...",         -- optional voice-over placed on a new A track
--   }
--
-- `effect` holds only the static transforms Resolve scripting can set. There is
-- no keyframing or transition support in the API, so these are fixed values.
--
-- Files are imported one at a time so the returned MediaPoolItems map 1:1 to the
-- items (ImportMedia may drop unreadable files or merge image sequences, which
-- would desync a bulk import from the sentence list), and each one goes through
-- import_media_once so a file the project already holds is reused instead of
-- landing in the media pool a second time.
-- Helper: slice existing clips on (kind, trackIdx) to clear out `windows`
-- (`{ { wIn = <frame>, wOut = <frame> }, ... }` relative to `timelineStart`)
-- so `replace` mode can overwrite exact time ranges in-place.
local function slice_track_for_replace(timeline, timelineStart, kind, trackIdx, windows)
    if not windows or #windows == 0 then return end
    local okCount, count = pcall(timeline.GetTrackCount, timeline, kind)
    if not okCount or type(count) ~= "number" or trackIdx < 1 or trackIdx > count then
        return
    end
    local okList, existingItems = pcall(timeline.GetItemListInTrack, timeline, kind, trackIdx)
    if not okList or type(existingItems) ~= "table" or #existingItems == 0 then
        return
    end

    local toDelete = {}
    local rebuilds = {}
    local mediaType = (kind == "video") and 1 or 2

    for _, c in ipairs(existingItems) do
        local okS, sFrame = pcall(c.GetStart, c)
        local okE, eFrame = pcall(c.GetEnd, c)
        local recIn = okS and ((tonumber(sFrame) or 0) - timelineStart) or 0
        local recOut = okE and ((tonumber(eFrame) or 0) - timelineStart) or 0

        local hits = false
        for _, w in ipairs(windows) do
            if recOut > w.wIn and recIn < w.wOut then
                hits = true
                break
            end
        end

        if hits and recOut > recIn then
            toDelete[#toDelete + 1] = c
            local okMp, mpItem = pcall(c.GetMediaPoolItem, c)
            local okSi, srcIn = pcall(c.GetSourceStartFrame, c)
            local okSo, srcOut = pcall(c.GetSourceEndFrame, c)
            srcIn = okSi and tonumber(srcIn) or nil
            srcOut = okSo and tonumber(srcOut) or nil

            if okMp and mpItem and srcIn and srcOut and srcOut > srcIn then
                local ratio = (srcOut - srcIn) / math.max(1, recOut - recIn)
                local pieces = {
                    {
                        recIn = recIn,
                        recOut = recOut,
                        origRecIn = recIn,
                        origSrcIn = srcIn,
                        ratio = ratio,
                    },
                }
                for _, w in ipairs(windows) do
                    local nextPieces = {}
                    for _, p in ipairs(pieces) do
                        if p.recOut <= w.wIn or p.recIn >= w.wOut then
                            nextPieces[#nextPieces + 1] = p
                        elseif p.recIn >= w.wIn and p.recOut <= w.wOut then
                            -- completely overwritten
                        elseif p.recIn < w.wIn and p.recOut > w.wOut then
                            nextPieces[#nextPieces + 1] = {
                                recIn = p.recIn,
                                recOut = w.wIn,
                                origRecIn = p.origRecIn,
                                origSrcIn = p.origSrcIn,
                                ratio = p.ratio,
                            }
                            nextPieces[#nextPieces + 1] = {
                                recIn = w.wOut,
                                recOut = p.recOut,
                                origRecIn = p.origRecIn,
                                origSrcIn = p.origSrcIn,
                                ratio = p.ratio,
                            }
                        elseif p.recIn < w.wIn then
                            nextPieces[#nextPieces + 1] = {
                                recIn = p.recIn,
                                recOut = w.wIn,
                                origRecIn = p.origRecIn,
                                origSrcIn = p.origSrcIn,
                                ratio = p.ratio,
                            }
                        else
                            nextPieces[#nextPieces + 1] = {
                                recIn = w.wOut,
                                recOut = p.recOut,
                                origRecIn = p.origRecIn,
                                origSrcIn = p.origSrcIn,
                                ratio = p.ratio,
                            }
                        end
                    end
                    pieces = nextPieces
                end

                for _, p in ipairs(pieces) do
                    if p.recOut > p.recIn then
                        local sIn = p.origSrcIn + math.floor((p.recIn - p.origRecIn) * p.ratio + 0.5)
                        local sOut = p.origSrcIn + math.floor((p.recOut - p.origRecIn) * p.ratio + 0.5)
                        if sOut <= sIn then sOut = sIn + 1 end
                        rebuilds[#rebuilds + 1] = {
                            mediaPoolItem = mpItem,
                            startFrame = sIn,
                            endFrame = sOut,
                            recordFrame = timelineStart + p.recIn,
                            trackIndex = trackIdx,
                            mediaType = mediaType,
                        }
                    end
                end
            end
        end
    end

    if #toDelete > 0 then
        pcall(timeline.DeleteClips, timeline, toDelete, false)
        if #rebuilds > 0 then
            pcall(mediaPool.AppendToTimeline, mediaPool, rebuilds)
        end
    end
end

-- Helper: split at `cutFrame` and shift all clips after `cutFrame` right by
-- `insertFrames` on (kind, trackIdx) for `insert` (ripple) mode.
local function slice_track_for_insert(timeline, timelineStart, kind, trackIdx, cutFrame, insertFrames)
    if insertFrames <= 0 then return end
    local okCount, count = pcall(timeline.GetTrackCount, timeline, kind)
    if not okCount or type(count) ~= "number" or trackIdx < 1 or trackIdx > count then
        return
    end
    local okList, existingItems = pcall(timeline.GetItemListInTrack, timeline, kind, trackIdx)
    if not okList or type(existingItems) ~= "table" or #existingItems == 0 then
        return
    end

    local toDelete = {}
    local rebuilds = {}
    local mediaType = (kind == "video") and 1 or 2

    for _, c in ipairs(existingItems) do
        local okS, sFrame = pcall(c.GetStart, c)
        local okE, eFrame = pcall(c.GetEnd, c)
        local recIn = okS and ((tonumber(sFrame) or 0) - timelineStart) or 0
        local recOut = okE and ((tonumber(eFrame) or 0) - timelineStart) or 0

        if recOut > cutFrame and recOut > recIn then
            toDelete[#toDelete + 1] = c
            local okMp, mpItem = pcall(c.GetMediaPoolItem, c)
            local okSi, srcIn = pcall(c.GetSourceStartFrame, c)
            local okSo, srcOut = pcall(c.GetSourceEndFrame, c)
            srcIn = okSi and tonumber(srcIn) or nil
            srcOut = okSo and tonumber(srcOut) or nil

            if okMp and mpItem and srcIn and srcOut and srcOut > srcIn then
                local ratio = (srcOut - srcIn) / math.max(1, recOut - recIn)
                if recIn < cutFrame then
                    local sMid = srcIn + math.floor((cutFrame - recIn) * ratio + 0.5)
                    if sMid > srcIn then
                        rebuilds[#rebuilds + 1] = {
                            mediaPoolItem = mpItem,
                            startFrame = srcIn,
                            endFrame = sMid,
                            recordFrame = timelineStart + recIn,
                            trackIndex = trackIdx,
                            mediaType = mediaType,
                        }
                    end
                    local sRightIn = math.max(srcIn, math.min(srcOut - 1, sMid))
                    rebuilds[#rebuilds + 1] = {
                        mediaPoolItem = mpItem,
                        startFrame = sRightIn,
                        endFrame = srcOut,
                        recordFrame = timelineStart + cutFrame + insertFrames,
                        trackIndex = trackIdx,
                        mediaType = mediaType,
                    }
                else
                    rebuilds[#rebuilds + 1] = {
                        mediaPoolItem = mpItem,
                        startFrame = srcIn,
                        endFrame = srcOut,
                        recordFrame = timelineStart + recIn + insertFrames,
                        trackIndex = trackIdx,
                        mediaType = mediaType,
                    }
                end
            end
        end
    end

    if #toDelete > 0 then
        pcall(timeline.DeleteClips, timeline, toDelete, false)
        if #rebuilds > 0 then
            pcall(mediaPool.AppendToTimeline, mediaPool, rebuilds)
        end
    end
end

-- Find a video track >= minTrack that has no clip overlapping [absIn, absOut),
-- creating a new video track if all existing tracks >= minTrack are occupied.
-- Audio tracks are added as stereo; older Resolve builds take no subtype.
local function add_track(timeline, kind)
    if kind == "audio" then
        local ok, added = pcall(timeline.AddTrack, timeline, "audio", "stereo")
        if ok and added then return true end
    end
    return timeline:AddTrack(kind) and true or false
end

-- First `kind` track at or above minTrack with nothing over [absIn, absOut),
-- adding one when every track is taken.
local function find_free_track(timeline, kind, minTrack, absIn, absOut)
    local existing = timeline:GetTrackCount(kind)
    while existing < minTrack do
        if not add_track(timeline, kind) then
            return existing
        end
        existing = existing + 1
    end
    for t = minTrack, existing do
        local okList, list = pcall(timeline.GetItemListInTrack, timeline, kind, t)
        local occupied = false
        if okList and type(list) == "table" then
            for _, itm in ipairs(list) do
                local okS, s = pcall(itm.GetStart, itm)
                local okE, e = pcall(itm.GetEnd, itm)
                if okS and okE and (tonumber(e) or 0) > absIn and (tonumber(s) or 0) < absOut then
                    occupied = true
                    break
                end
            end
        end
        if not occupied then
            return t
        end
    end
    if add_track(timeline, kind) then
        return timeline:GetTrackCount(kind)
    end
    return existing
end

local function find_free_video_track(timeline, minTrack, absIn, absOut)
    return find_free_track(timeline, "video", minTrack, absIn, absOut)
end

local AUDIO_EXTS = {
    wav = true, mp3 = true, m4a = true, aac = true, flac = true, ogg = true,
    aif = true, aiff = true, opus = true, wma = true,
}

local function is_audio_path(path)
    local ext = tostring(path or ""):match("%.([%w]+)$")
    return ext ~= nil and AUDIO_EXTS[ext:lower()] == true
end

-- Length of a media pool item in its own frames, or nil.
local function media_frames(mpItem, fps)
    local okFrames, framesProp = pcall(mpItem.GetClipProperty, mpItem, "Frames")
    local frames = okFrames and tonumber(framesProp) or nil
    if frames then return frames end
    local okDur, durProp = pcall(mpItem.GetClipProperty, mpItem, "Duration")
    if okDur and type(durProp) == "string" then
        local hh, mm, ss, ff = durProp:match("^(%d+):(%d+):(%d+)[:;](%d+)$")
        if hh then
            return (tonumber(hh) * 3600 + tonumber(mm) * 60 + tonumber(ss)) * fps + tonumber(ff)
        end
    end
    return nil
end

-- Place audio-only items (sound effects, music) exactly at their start, each
-- on the first audio track free over its span from A2 up, adding tracks as
-- needed, so nothing lands on another clip. One append per item, so the next
-- item's free-track check sees it. Returns how many landed.
local function place_audio_items(timeline, mediaIndex, items, fps, timelineStart, lines)
    local placed = 0
    for _, it in ipairs(items) do
        local name = tostring(it.path):match("[^/\\]+$") or "audio"
        local mpItem = import_media_once(mediaIndex, it.path)
        if not mpItem then
            lines[#lines + 1] = "Skipped (could not import): " .. name
        else
            local okFps, fpsProp = pcall(mpItem.GetClipProperty, mpItem, "FPS")
            local srcFps = (okFps and tonumber(fpsProp)) or fps
            local total = media_frames(mpItem, srcFps)
            local startSec = math.max(0, tonumber(it.start) or 0)
            local srcIn = math.max(0, tonumber(it.src_in) or 0)
            local srcOut = tonumber(it.src_out)
            local endSec = tonumber(it["end"])
            local inF = math.floor(srcIn * srcFps + 0.5)
            local outF
            if srcOut and srcOut > srcIn then
                outF = math.floor(srcOut * srcFps + 0.5)
            elseif endSec and endSec > startSec then
                outF = inF + math.floor((endSec - startSec) * srcFps + 0.5)
            else
                outF = total and math.floor(total) or (inF + math.floor(3 * srcFps + 0.5))
            end
            if total and outF > total then outF = math.floor(total) end
            if outF <= inF then outF = inF + 1 end
            local recIn = timelineStart + math.floor(startSec * fps + 0.5)
            local recOut = recIn + math.max(1, math.floor((outF - inF) / srcFps * fps + 0.5))
            local track = find_free_track(timeline, "audio", 2, recIn, recOut)
            local appended = mediaPool:AppendToTimeline({ {
                mediaPoolItem = mpItem,
                startFrame = inF,
                endFrame = outF,
                recordFrame = recIn,
                trackIndex = track,
                mediaType = 2,
            } })
            if type(appended) == "table" and appended[1] then
                placed = placed + 1
            else
                lines[#lines + 1] = "Could not place audio: " .. name
            end
        end
    end
    return placed
end

function BuildStoryboard(spec)
    refresh_project()
    local result
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        if type(spec) ~= "table" then
            error("spec must be a table", 0)
        end

        -- Audio-only items (sound effects, music) go to free audio tracks at
        -- their own start and never move the video cursor; the rest is the
        -- picture placement below.
        local items, audioItems = {}, {}
        for _, it in ipairs(spec.items or {}) do
            if type(it) == "table" and is_audio_path(it.path) then
                audioItems[#audioItems + 1] = it
            else
                items[#items + 1] = it
            end
        end
        local audioPath = spec.audio_path
        local hasAudio = type(audioPath) == "string" and #audioPath > 0
        if #items == 0 and #audioItems == 0 and not hasAudio then
            result = { lines = { "Nothing to place." }, appended = 0, requested = 0 }
            return
        end

        local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 24
        local timelineStart = timeline:GetStartFrame()
        local target = tonumber(spec.target_video_track) or 1
        if target < 1 then target = 1 end
        local defaultStill = tonumber(spec.default_still_secs) or 3
        local rawMode = (type(spec.mode) == "string") and spec.mode:lower() or ""

        -- Ensure the target video track exists (only needed when placing media).
        if #items > 0 then
            local existing = timeline:GetTrackCount("video")
            while existing < target do
                if not timeline:AddTrack("video") then
                    error("Could not add video track " .. (existing + 1), 0)
                end
                existing = existing + 1
            end
        end

        -- Where the target track's existing content ends, in timeline frames/seconds.
        local trackEndFrames = 0
        if #items > 0 then
            local okList, existingItems = pcall(
                timeline.GetItemListInTrack, timeline, "video", target)
            if okList and type(existingItems) == "table" then
                for _, itm in ipairs(existingItems) do
                    local okEnd, endFrame = pcall(itm.GetEnd, itm)
                    local e = okEnd and ((tonumber(endFrame) or 0) - timelineStart) or 0
                    if e > trackEndFrames then trackEndFrames = e end
                end
            end
        end
        local trackEndSec = trackEndFrames / fps

        local mediaIndex = build_media_index()

        local lines = {}
        local resolved = {}
        local requested = 0

        for _, it in ipairs(items) do
            local path = it.path
            local mpItem = import_media_once(mediaIndex, path)
            if not mpItem then
                lines[#lines + 1] = "Skipped (could not import): " .. tostring(path)
            else
                requested = requested + 1
                local startSec = tonumber(it.start) or 0
                local endSec = tonumber(it["end"])
                local spanSec = (endSec and endSec > startSec)
                    and (endSec - startSec) or defaultStill

                local clipType = ""
                if mpItem.GetClipProperty then
                    local okType, ct = pcall(mpItem.GetClipProperty, mpItem, "Type")
                    if okType and type(ct) == "string" then clipType = ct:lower() end
                end
                local isStill = clipType == "still" or clipType:find("image") ~= nil

                local srcIn = tonumber(it.src_in)
                local srcOut = tonumber(it.src_out)
                if srcIn and srcIn < 0 then srcIn = nil end
                if srcOut and srcIn and srcOut <= srcIn then srcOut = nil end
                local hasRange = (srcIn ~= nil) or (srcOut ~= nil)

                local srcFps = fps
                local srcDur = nil
                if not isStill then
                    local okFps, fpsProp = pcall(mpItem.GetClipProperty, mpItem, "FPS")
                    if okFps then srcFps = tonumber(fpsProp) or fps end

                    local okFrames, framesProp = pcall(mpItem.GetClipProperty, mpItem, "Frames")
                    if okFrames then srcDur = tonumber(framesProp) end
                    if not srcDur then
                        local okDur, durProp = pcall(mpItem.GetClipProperty, mpItem, "Duration")
                        if okDur and type(durProp) == "string" then
                            local hh, mm, ss, ff = durProp:match("^(%d+):(%d+):(%d+)[:;](%d+)$")
                            if hh then
                                srcDur = ((tonumber(hh) * 3600 + tonumber(mm) * 60 + tonumber(ss))
                                    * srcFps) + tonumber(ff)
                            else
                                srcDur = tonumber(durProp)
                            end
                        end
                    end
                end

                local endFrame
                local placedSec
                local startFrame = 0
                if hasRange and not isStill then
                    startFrame = math.max(0, math.floor((srcIn or 0) * srcFps + 0.5))
                    if srcOut then
                        endFrame = math.floor(srcOut * srcFps + 0.5)
                    else
                        endFrame = srcDur and math.floor(srcDur) or
                            (startFrame + math.floor(spanSec * srcFps + 0.5))
                    end
                    if srcDur and srcDur > 1 and endFrame > srcDur then
                        endFrame = math.floor(srcDur)
                    end
                    if endFrame <= startFrame then endFrame = startFrame + 1 end
                    placedSec = (endFrame - startFrame) / srcFps
                elseif isStill then
                    endFrame = math.max(1, math.floor(spanSec * srcFps + 0.5))
                    placedSec = spanSec
                elseif (endSec and endSec > startSec) and srcDur and srcDur > 1 then
                    -- User explicitly gave start..end span on timeline (e.g. replace 15s at minute 2)
                    local maxFrames = math.floor(srcDur)
                    local wantFrames = math.max(1, math.floor(spanSec * srcFps + 0.5))
                    endFrame = math.min(maxFrames, wantFrames)
                    placedSec = endFrame / srcFps
                elseif srcDur and srcDur > 1 then
                    endFrame = math.floor(srcDur)
                    placedSec = endFrame / srcFps
                else
                    endFrame = math.max(1, math.floor(spanSec * srcFps + 0.5))
                    placedSec = spanSec
                end

                local placedFrames = math.max(1, math.floor(placedSec * fps + 0.5))
                local reqStartFrames = math.max(0, math.floor(startSec * fps + 0.5))

                lines[#lines + 1] = string.format(
                    "%s: type=%s fps=%s src=%d-%d -> %.1fs",
                    tostring(path):match("[^/\\]+$") or "clip",
                    clipType ~= "" and clipType or "?",
                    tostring(srcFps), startFrame, endFrame, placedSec)

                resolved[#resolved + 1] = {
                    mpItem = mpItem,
                    isStill = isStill,
                    startFrame = startFrame,
                    endFrame = endFrame,
                    placedSec = placedSec,
                    placedFrames = placedFrames,
                    reqStartSec = startSec,
                    reqStartFrames = reqStartFrames,
                    effect = (type(it.effect) == "table") and it.effect or nil,
                }
            end
        end

        -- Determine effective placement mode: "replace" | "insert" | "overlay" | "append"
        local effectiveMode = "append"
        if rawMode == "replace" or rawMode == "overwrite" then
            effectiveMode = "replace"
        elseif rawMode == "insert" or rawMode == "ripple" then
            effectiveMode = "insert"
        elseif rawMode == "overlay" or rawMode == "broll" then
            effectiveMode = "overlay"
        elseif rawMode == "append" then
            effectiveMode = "append"
        else
            if target >= 2 then
                effectiveMode = "overlay"
            elseif trackEndFrames > 0 and #resolved > 0
                and resolved[1].reqStartFrames > 0
                and resolved[1].reqStartFrames < trackEndFrames then
                effectiveMode = "replace"
            else
                effectiveMode = "append"
            end
        end

        local clipList = {}
        local audioClipList = {}
        local effects = {}

        if #resolved > 0 then
            if effectiveMode == "overlay" then
                local minOverlayTrack = math.max(2, target)
                local cursorFrames = 0
                local seeded = false
                for _, r in ipairs(resolved) do
                    if not seeded then
                        cursorFrames = r.reqStartFrames
                        seeded = true
                    end
                    local recIn = math.max(cursorFrames, r.reqStartFrames)
                    local recOut = recIn + r.placedFrames
                    cursorFrames = recOut
                    local absIn = timelineStart + recIn
                    local absOut = timelineStart + recOut
                    local trackIdx = find_free_video_track(timeline, minOverlayTrack, absIn, absOut)

                    clipList[#clipList + 1] = {
                        mediaPoolItem = r.mpItem,
                        startFrame = r.startFrame,
                        endFrame = r.endFrame,
                        recordFrame = absIn,
                        trackIndex = trackIdx,
                        mediaType = 1,
                    }
                    effects[#clipList] = r.effect
                end
            elseif effectiveMode == "replace" then
                local cursorFrames = 0
                local seeded = false
                local windows = {}
                for _, r in ipairs(resolved) do
                    if not seeded then
                        cursorFrames = r.reqStartFrames
                        seeded = true
                    end
                    local recIn = math.max(cursorFrames, r.reqStartFrames)
                    local recOut = recIn + r.placedFrames
                    cursorFrames = recOut
                    r.recIn = recIn
                    r.recOut = recOut
                    windows[#windows + 1] = { wIn = recIn, wOut = recOut }
                end

                slice_track_for_replace(timeline, timelineStart, "video", target, windows)
                slice_track_for_replace(timeline, timelineStart, "audio", target, windows)

                -- Ensure audio track `target` exists if any non-still clip is placed
                local existingA = timeline:GetTrackCount("audio")
                while existingA < target do
                    if not timeline:AddTrack("audio") then break end
                    existingA = existingA + 1
                end

                for _, r in ipairs(resolved) do
                    local absIn = timelineStart + r.recIn
                    clipList[#clipList + 1] = {
                        mediaPoolItem = r.mpItem,
                        startFrame = r.startFrame,
                        endFrame = r.endFrame,
                        recordFrame = absIn,
                        trackIndex = target,
                        mediaType = 1,
                    }
                    effects[#clipList] = r.effect
                    if not r.isStill then
                        audioClipList[#audioClipList + 1] = {
                            mediaPoolItem = r.mpItem,
                            startFrame = r.startFrame,
                            endFrame = r.endFrame,
                            recordFrame = absIn,
                            trackIndex = target,
                            mediaType = 2,
                        }
                    end
                end
            elseif effectiveMode == "insert" then
                local cutFrame = resolved[1].reqStartFrames
                local totalInsertFrames = 0
                for _, r in ipairs(resolved) do
                    r.recIn = cutFrame + totalInsertFrames
                    totalInsertFrames = totalInsertFrames + r.placedFrames
                    r.recOut = cutFrame + totalInsertFrames
                end

                slice_track_for_insert(timeline, timelineStart, "video", target, cutFrame, totalInsertFrames)
                slice_track_for_insert(timeline, timelineStart, "audio", target, cutFrame, totalInsertFrames)

                local existingA = timeline:GetTrackCount("audio")
                while existingA < target do
                    if not timeline:AddTrack("audio") then break end
                    existingA = existingA + 1
                end

                for _, r in ipairs(resolved) do
                    local absIn = timelineStart + r.recIn
                    clipList[#clipList + 1] = {
                        mediaPoolItem = r.mpItem,
                        startFrame = r.startFrame,
                        endFrame = r.endFrame,
                        recordFrame = absIn,
                        trackIndex = target,
                        mediaType = 1,
                    }
                    effects[#clipList] = r.effect
                    if not r.isStill then
                        audioClipList[#audioClipList + 1] = {
                            mediaPoolItem = r.mpItem,
                            startFrame = r.startFrame,
                            endFrame = r.endFrame,
                            recordFrame = absIn,
                            trackIndex = target,
                            mediaType = 2,
                        }
                    end
                end
            else
                -- "append" mode
                local recordCursor = 0
                local cursorSeeded = false
                for _, r in ipairs(resolved) do
                    if not cursorSeeded then
                        recordCursor = math.max(0, r.reqStartSec, trackEndSec)
                        cursorSeeded = true
                    end
                    local placedStart = math.max(recordCursor, r.reqStartSec)
                    local recordFrame = timelineStart + math.floor(placedStart * fps + 0.5)
                    recordCursor = placedStart + r.placedSec

                    clipList[#clipList + 1] = {
                        mediaPoolItem = r.mpItem,
                        startFrame = r.startFrame,
                        endFrame = r.endFrame,
                        recordFrame = recordFrame,
                        trackIndex = target,
                    }
                    if r.isStill then
                        clipList[#clipList].mediaType = 1
                    end
                    effects[#clipList] = r.effect
                end
            end
        end

        local appendedCount = 0
        if #clipList > 0 then
            local appended = mediaPool:AppendToTimeline(clipList)
            appendedCount = (type(appended) == "table") and #appended or 0

            if #audioClipList > 0 then
                pcall(mediaPool.AppendToTimeline, mediaPool, audioClipList)
            end

            -- Apply each clip's static transform. SetProperty sets a constant
            -- value (no keyframes), so these are fixed framings, not moves.
            apply_storyboard_effects(appended, effects)

            lines[#lines + 1] = string.format(
                "Placed %d of %d media onto V%d (mode=%s).",
                appendedCount, #clipList, target, effectiveMode)
            if appendedCount < #clipList then
                lines[#lines + 1] = string.format(
                    "Warning: Resolve accepted %d of %d requested inserts (overlaps?).",
                    appendedCount, #clipList)
            end
        end

        -- Optional voice-over: drop the audio file onto a fresh audio track at
        -- the timeline start so the narration plays under the slideshow.
        if hasAudio then
            local mpItem = import_media_once(mediaIndex, audioPath)
            if not mpItem then
                lines[#lines + 1] = "Skipped voice-over (could not import): " .. tostring(audioPath)
            elseif not timeline:AddTrack("audio") then
                lines[#lines + 1] = "Warning: could not add an audio track for the voice-over."
            else
                local aTarget = timeline:GetTrackCount("audio")
                local appendedA = mediaPool:AppendToTimeline({ {
                    mediaPoolItem = mpItem,
                    recordFrame = timelineStart,
                    trackIndex = aTarget,
                    mediaType = 2,
                } })
                if type(appendedA) == "table" and appendedA[1] then
                    lines[#lines + 1] = string.format("Added voice-over to A%d.", aTarget)
                else
                    lines[#lines + 1] = "Warning: could not place the voice-over audio."
                end
            end
        end

        local audioPlaced = 0
        if #audioItems > 0 then
            audioPlaced = place_audio_items(timeline, mediaIndex, audioItems, fps, timelineStart, lines)
            lines[#lines + 1] = string.format("Placed %d of %d audio item(s) on free audio tracks.",
                audioPlaced, #audioItems)
        end

        result = {
            lines = lines,
            appended = appendedCount + audioPlaced,
            requested = requested + #audioItems,
            audio_placed = audioPlaced,
            audio_requested = #audioItems,
        }
    end)
    if not ok then
        return make_error("Could not build slideshow", err)
    end
    return result
end

-- Duplicate the current timeline, switch to the copy, and return its name.
-- Used by the "Auto-cut silences" workflow so the destructive rebuild happens
-- on a fresh timeline while the user's original stays untouched.
--
-- `spec` (optional):
--   { name_suffix = " (silence removed)", switch_to = true }
function DuplicateCurrentTimeline(spec)
    refresh_project()
    local result
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        local base = timeline:GetName() or "Timeline"
        local suffix = (spec and type(spec.name_suffix) == "string")
            and spec.name_suffix or " (silence removed)"
        local newName = base .. suffix

        local dup = mediaPool:DuplicateTimeline(newName)
        if not dup then
            error("Resolve refused to duplicate the timeline.", 0)
        end

        if not spec or spec.switch_to ~= false then
            if not project:SetCurrentTimeline(dup) then
                error("Could not switch to the duplicated timeline.", 0)
            end
        end

        result = {
            name = newName,
            timeline_ref = { __resolve_obj = rpc_register(dup) },
            lines = { "Duplicated timeline as: " .. newName },
        }
    end)
    if not ok then
        return make_error("Could not duplicate timeline", err)
    end
    return result
end

-- Create a fresh empty timeline (and switch to it) for the "Auto-cut silences"
-- workflow. Preferred over DuplicateCurrentTimeline: MediaPool:CreateEmptyTimeline
-- exists on far more Resolve builds than DuplicateTimeline, and building the cut
-- onto an empty timeline gives a clean result with only the kept media.
function CreateCutTimeline(spec)
    refresh_project()
    local result
    local ok, err = pcall(function()
        local current = project:GetCurrentTimeline()
        local base = (current and current:GetName()) or "Timeline"
        local suffix = (spec and type(spec.name_suffix) == "string")
            and spec.name_suffix or " (silence removed)"
        local newName = base .. suffix

        if not mediaPool.CreateEmptyTimeline then
            error("This DaVinci Resolve build does not support creating timelines via scripting.", 0)
        end
        local tl = mediaPool:CreateEmptyTimeline(newName)
        if not tl then
            error("Resolve refused to create a new timeline.", 0)
        end
        -- CreateEmptyTimeline makes it current in most builds; make sure.
        pcall(function() project:SetCurrentTimeline(tl) end)

        result = {
            name = newName,
            timeline_ref = { __resolve_obj = rpc_register(tl) },
            lines = { "Created cut timeline: " .. newName },
        }
    end)
    if not ok then
        return make_error("Could not create cut timeline", err)
    end
    return result
end

-- Ripple-delete every clip on the given tracks of the current timeline. Used
-- after DuplicateCurrentTimeline so ApplyKeepSegments can rebuild the tracks
-- from scratch on the duplicated copy without leaving stray originals behind.
--
-- `spec`:
--   { video_tracks = { 1 }, audio_tracks = { 1 } }
function ClearTracks(spec)
    refresh_project()
    local result
    local ok, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        if not timeline then
            error("No timeline is open.", 0)
        end
        if type(spec) ~= "table" then
            error("spec must be a table", 0)
        end

        local toDelete = {}
        local function collect(kind, list)
            for _, idx in ipairs(list or {}) do
                local i = tonumber(idx)
                if i then
                    local clips = timeline:GetItemListInTrack(kind, i) or {}
                    for _, c in ipairs(clips) do
                        toDelete[#toDelete + 1] = c
                    end
                end
            end
        end
        collect("video", spec.video_tracks)
        collect("audio", spec.audio_tracks)

        local removed = 0
        if #toDelete > 0 then
            -- ripple=false: keep the timeline coordinate system intact so
            -- ApplyKeepSegments' recordFrame math is unchanged.
            local okDel = timeline:DeleteClips(toDelete, false)
            if okDel then removed = #toDelete end
        end

        result = {
            removed = removed,
            lines = { string.format("Cleared %d clip(s) from the requested tracks.", removed) },
        }
    end)
    if not ok then
        return make_error("Could not clear tracks", err)
    end
    return result
end



-- Get a list of possible output tracks for subtitles
get_video_tracks = function()
    local tracks = {}
    local createNewTrack = {
        value = "0",
        label = "Add to New Track"
    }
    table.insert(tracks, createNewTrack)

    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("video")
        for i = 1, trackCount do
            local track = {
                value = tostring(i),
                label = timeline:GetTrackName("video", i)
            }
            table.insert(tracks, track)
        end
    end)
    return tracks
end

get_audio_tracks = function()
    local tracks = {}
    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("audio")
        for i = 1, trackCount do
            local track = {
                value = tostring(i),
                label = timeline:GetTrackName("audio", i)
            }
            table.insert(tracks, track)
        end
    end)
    return tracks
end

-- Subtitle tracks, for the AutoEdit actions that read subtitles. Unlike the
-- video list there is no "new track" entry: these only ever read existing ones.
get_subtitle_tracks = function()
    local tracks = {}
    local success, err = pcall(function()
        local timeline = project:GetCurrentTimeline()
        local trackCount = timeline:GetTrackCount("subtitle")
        for i = 1, trackCount do
            local track = {
                value = tostring(i),
                label = timeline:GetTrackName("subtitle", i)
            }
            table.insert(tracks, track)
        end
    end)
    return tracks
end


local function reset_tracks()
    resolve:OpenPage("edit")
    local timeline = project:GetCurrentTimeline()
    local audioTracks = timeline:GetTrackCount("audio")
    for i = 1, audioTracks do
        timeline:SetTrackEnable("audio", i, currentExportJob["trackStates"][i])
    end
    currentExportJob["clipBoundaries"] = nil
end

-- Restore the user's pre-export In/Out markers. No-ops if nothing was saved
-- (standalone AddSubtitles without a prior export).
local function restore_user_state()
    if currentExportJob.savedMarks == nil then return end

    local timeline = project:GetCurrentTimeline()
    if timeline and timeline.SetMarkInOut then
        for _, markType in ipairs({ "audio", "video" }) do
            local m = currentExportJob.savedMarks[markType]
            local ok = false
            if m and m["in"] ~= nil and m["out"] ~= nil then
                ok = pcall(timeline.SetMarkInOut, timeline, m["in"], m["out"], markType)
            elseif timeline.ClearMarkInOut then
                ok = pcall(timeline.ClearMarkInOut, timeline, markType)
            end
            if not ok then
                print("[AutoSubs] restore_user_state: could not restore " .. markType .. " markers")
            end
        end
    end
    currentExportJob.savedMarks = nil
end

-- Snapshot the user's render configuration before ExportAudio overwrites it.
-- A temporary preset captures the whole deliver state (format, codec, target
-- dir, export flags); the format/codec + render-mode reads are a fallback for
-- Resolve versions where SaveAsNewRenderPreset fails.
local function snapshot_render_state()
    local snap = { presetName = nil, formatCodec = nil, renderMode = nil }
    pcall(function()
        local name = "AutoSubs-Backup-" .. os.date("!%Y%m%d-%H%M%S") .. "-" .. tostring(math.random(1000, 9999))
        if project:SaveAsNewRenderPreset(name) then
            snap.presetName = name
        end
    end)
    pcall(function() snap.formatCodec = project:GetCurrentRenderFormatAndCodec() end)
    pcall(function() snap.renderMode = project:GetCurrentRenderMode() end)
    return snap
end

-- Remove our render job from the Deliver queue and restore the user's
-- pre-export render configuration. Called on every export exit path
-- (complete/fail/cancel) so the Deliver page is left as it was found.
local function cleanup_render_job()
    local pid = currentExportJob.pid
    if pid ~= nil then
        pcall(function() project:DeleteRenderJob(pid) end)
        currentExportJob.pid = nil
    end

    local snap = currentExportJob.renderSnapshot
    currentExportJob.renderSnapshot = nil
    if snap == nil then return end
    if snap.presetName ~= nil then
        pcall(function() project:LoadRenderPreset(snap.presetName) end)
        pcall(function() project:DeleteRenderPreset(snap.presetName) end)
    else
        if type(snap.formatCodec) == "table" and snap.formatCodec["format"] and snap.formatCodec["codec"] then
            pcall(function()
                project:SetCurrentRenderFormatAndCodec(snap.formatCodec["format"], snap.formatCodec["codec"])
            end)
        end
        if snap.renderMode ~= nil then
            pcall(function() project:SetCurrentRenderMode(snap.renderMode) end)
        end
        -- No preset snapshot to reload, and the API can't read render settings
        -- back — the best possible restore is resetting the export flags and
        -- frame range we pushed to conventional defaults rather than leaving
        -- the user on audio-only settings.
        pcall(function()
            project:SetRenderSettings({
                ExportVideo = true,
                ExportAudio = true,
                IsExportVideo = true,
                IsExportAudio = true,
                SelectAllFrames = true
            })
        end)
    end
end

local function render_job_progress(jobId)
    local pct = nil
    pcall(function()
        local status = project:GetRenderJobStatus(jobId)
        if type(status) == "table" then
            pct = status["CompletionPercentage"]
        end
    end)
    return pct
end

-- A queued-but-dead render job (e.g. a leftover AutoSubs job stuck in 'Ready')
-- can leave IsRenderingInProgress() reporting true forever, blocking every
-- later export. Delete leftover AutoSubs jobs — identified by their unique
-- export name prefix — so a genuine external render still blocks but a zombie
-- of ours does not. Never touches the job tracked by the active export.
--
-- only_stalled: when Resolve reports a render in progress, only drop jobs
-- whose completion percentage is provably not advancing — an AutoSubs render
-- still running after its bridge state was lost must not be deleted mid-flight.
local function remove_stale_export_jobs(only_stalled)
    local jobs = nil
    pcall(function() jobs = project:GetRenderJobList() end)
    if type(jobs) ~= "table" then return end
    for _, job in ipairs(jobs) do
        if type(job) == "table" then
            local name = tostring(job["OutputFilename"] or job["CustomName"] or "")
            local id = job["JobId"] or job["Id"]
            if id ~= nil and id ~= currentExportJob.pid and name:match("^autosubs%-exported%-audio%-") then
                local removable = true
                if only_stalled then
                    -- A live render's percentage ticks between two samples; a
                    -- stalled or never-started job's does not. When the status
                    -- can't be read, err on keeping the job.
                    local first = render_job_progress(id)
                    bmd.wait(0.3)
                    local second = render_job_progress(id)
                    removable = first ~= nil and first == second
                end
                if removable then
                    print("[AutoSubs] Removing stale render job " .. tostring(id) .. " (" .. name .. ")")
                    pcall(function() project:DeleteRenderJob(id) end)
                end
            end
        end
    end
end

local function check_track_empty(trackIndex, markIn, markOut)
    trackIndex = tonumber(trackIndex)
    local timeline = project:GetCurrentTimeline()
    local trackItems = timeline:GetItemListInTrack("video", trackIndex)
    for i, item in ipairs(trackItems) do
        local itemStart = item:GetStart()
        local itemEnd = item:GetEnd()
        if (itemStart <= markIn and itemEnd >= markIn) or (itemStart <= markOut and itemEnd >= markOut) then
            return false
        end
        if itemStart > markOut then
            break
        end
    end
    return #trackItems == 0
end

-- Get the current export progress
function GetExportProgress()
    if not currentExportJob.active then
        return {
            active = false,
            progress = 0,
            message = "No export in progress"
        }
    end

    if currentExportJob.cancelled then
        return {
            active = false,
            progress = currentExportJob.progress,
            cancelled = true,
            message = "Export was cancelled"
        }
    end

    -- Check if render is still in progress
    if currentExportJob.pid then
        local renderInProgress = false
        local success, result = pcall(function()
            return project:IsRenderingInProgress()
        end)

        if success then
            renderInProgress = result
        end

        if renderInProgress then
            -- Progress check using playhead position compared to 'mark in' and 'mark out' points (better than job status)
            local timeline = project:GetCurrentTimeline()
            local currentTimecode = timeline:GetCurrentTimecode()
            local frameRate = timeline:GetSetting("timelineFrameRate")

            -- Playhead position in frames
            local playheadPosition = timecode.frame_from_timecode(currentTimecode, tonumber(frameRate))

            -- Get mark in and out from audioInfo (already in frames)
            local markIn = currentExportJob.audioInfo.markIn
            local markOut = currentExportJob.audioInfo.markOut

            -- Calculate progress percentage
            currentExportJob.progress = math.floor(((playheadPosition - markIn) / (markOut - markIn)) * 100 + 0.5)

            return {
                active = true,
                progress = currentExportJob.progress,
                message = "Export in progress...",
                pid = currentExportJob.pid
            }
        else
            -- IsRenderingInProgress() going false only means Resolve stopped
            -- rendering — it does NOT mean the job actually succeeded. Check
            -- the job's real status so a silently failed render (e.g. bad
            -- output path, disk full, no encoder) is reported as an error
            -- instead of a fabricated success with a non-existent file.
            -- The check runs before cleanup_render_job() deletes the job.
            --
            -- Resolve localizes JobStatus (e.g. "Finalizado", "Concluído",
            -- "Завершено"), so we cannot compare only to the English word
            -- "Complete". A real failure is indicated by a non-empty Error
            -- field or an unfinished CompletionPercentage.
            local jobStatus, jobError, completionPercentage
            if currentExportJob.pid then
                local ok, status = pcall(function()
                    return project:GetRenderJobStatus(currentExportJob.pid)
                end)
                if ok and type(status) == "table" then
                    jobStatus = status["JobStatus"]
                    jobError = status["Error"]
                    completionPercentage = status["CompletionPercentage"]
                end
            end

            local detail
            if jobError and tostring(jobError) ~= "" then
                detail = tostring(jobError)
            elseif type(completionPercentage) == "number" and completionPercentage < 100 then
                detail = "Render job incomplete (" .. tostring(completionPercentage) .. "%)"
                if jobStatus then
                    detail = detail .. ": " .. tostring(jobStatus)
                end
            end

            -- A job Resolve queued but never started (still 'Ready' at 0%,
            -- no error) gets one restart before being reported as failed. A
            -- job with a real error is never restarted.
            if detail and not currentExportJob.cancelled
                and (jobError == nil or tostring(jobError) == "")
                and (completionPercentage == nil or completionPercentage == 0)
                and not currentExportJob.restartAttempted then
                currentExportJob.restartAttempted = true
                print("[AutoSubs] Render job never started; attempting one restart")
                local restartOk, restarted = pcall(function()
                    return project:StartRendering(currentExportJob.pid)
                end)
                if restartOk and restarted ~= false then
                    return {
                        active = true,
                        progress = currentExportJob.progress,
                        message = "Export in progress...",
                        pid = currentExportJob.pid
                    }
                end
            end

            -- Export completed - check if it was cancelled or completed normally
            currentExportJob.active = false

            -- Reset track states and open edit page, then drop our render job
            -- and restore the user's pre-export render configuration.
            reset_tracks()
            cleanup_render_job()

            if currentExportJob.cancelled then
                return {
                    active = false,
                    progress = currentExportJob.progress,
                    cancelled = true,
                    message = "Export was cancelled"
                }
            end

            if detail then
                print("[AutoSubs] Export did not complete successfully: " .. detail)
                return {
                    active = false,
                    progress = currentExportJob.progress,
                    error = true,
                    message = "Audio export failed in Resolve",
                    detail = detail
                }
            end

            -- Normal completion (Resolve may report a localized JobStatus here).
            currentExportJob.progress = 100
            return {
                active = false,
                progress = 100,
                completed = true,
                message = "Export completed successfully",
                audioInfo = currentExportJob.audioInfo
            }
        end
    else
        -- No PID available - something went wrong
        currentExportJob.active = false
        return {
            active = false,
            progress = 0,
            error = true,
            message = "Export job lost - no process ID available"
        }
    end
end

-- Cancel the current export operation
function CancelExport()
    if not currentExportJob.active then
        return {
            success = false,
            message = "No export in progress to cancel"
        }
    end

    if currentExportJob.pid then
        local success, err = pcall(function()
            project:StopRendering()
        end)

        -- reset tracks to original state and return to edit page
        reset_tracks()

        if success then
            cleanup_render_job()
            currentExportJob.cancelled = true
            currentExportJob.active = false
            return {
                success = true,
                message = "Export cancelled successfully"
            }
        else
            return {
                success = false,
                message = "Failed to cancel export: " .. (err or "unknown error")
            }
        end
    else
        return {
            success = false,
            message = "No render job to cancel"
        }
    end
end

-- Helper function to get individual clips with their boundaries (for segment-based transcription)
-- Returns a sorted array of clip segments: { { start, end, name }, ... }
local function get_individual_clips(timeline, selectedTracks, rangeStart, rangeEnd)
    local allClips = {}
    local timelineStart = timeline:GetStartFrame()
    local frameRate = timeline:GetSetting("timelineFrameRate")

    for trackIndex, _ in pairs(selectedTracks) do
        local clips = timeline:GetItemListInTrack("audio", trackIndex)
        if clips then
            for _, clip in ipairs(clips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                local clipName = clip:GetName() or "Unnamed"

                -- Skip clips entirely outside the marker region; clamp those that overlap
                if clipEnd > rangeStart and clipStart < rangeEnd then
                    local cs = math.max(clipStart, rangeStart)
                    local ce = math.min(clipEnd, rangeEnd)

                    table.insert(allClips, {
                        startFrame = cs,
                        endFrame = ce,
                        -- Convert to seconds relative to timeline start
                        start = (cs - timelineStart) / frameRate,
                        ["end"] = (ce - timelineStart) / frameRate,
                        name = clipName
                    })
                end
            end
        end
    end

    -- Sort by start time
    table.sort(allClips, function(a, b) return a.startFrame < b.startFrame end)

    -- Merge overlapping clips (in case clips from different tracks overlap)
    local mergedClips = {}
    for _, clip in ipairs(allClips) do
        if #mergedClips == 0 then
            table.insert(mergedClips, clip)
        else
            local lastClip = mergedClips[#mergedClips]
            -- If this clip overlaps or is adjacent to the last one, merge them
            if clip.startFrame <= lastClip.endFrame then
                lastClip.endFrame = math.max(lastClip.endFrame, clip.endFrame)
                lastClip["end"] = math.max(lastClip["end"], clip["end"])
                lastClip.name = lastClip.name .. " + " .. clip.name
            else
                table.insert(mergedClips, clip)
            end
        end
    end

    return mergedClips
end

-- Helper function to resolve in/out markers to absolute timeline frame positions.
-- timeline:GetMarkInOut() returns a dict like {audio={in=0,out=134}, video={...}}
-- where values are RELATIVE to the timeline start (0-based). Clip positions
-- (clip:GetStart()/GetEnd()) however are ABSOLUTE timeline frames, so we must
-- offset markers by timeline:GetStartFrame() before comparing.
-- If only one of in/out is set, the missing side defaults to the timeline
-- start/end frame respectively.
local function get_marker_range(timeline)
    local startFrame = timeline:GetStartFrame()
    local endFrame = timeline:GetEndFrame()

    local marks = {}
    if timeline.GetMarkInOut then
        marks = timeline:GetMarkInOut() or {}
    end
    -- Prefer audio markers; fall back to video if audio not present
    local m = marks["audio"] or marks["video"] or {}

    local inAbs = m["in"] and (m["in"] + startFrame) or startFrame
    local outAbs = m["out"] and (m["out"] + startFrame) or endFrame

    return inAbs, outAbs
end

-- Helper function to find clip boundaries on selected audio tracks within in/out markers.
-- Clips entirely outside the marker region are ignored. Clips that overlap the
-- region are clamped to the marker boundaries.
local function get_clip_boundaries(timeline, selectedTracks, rangeStart, rangeEnd)
    local earliestStart = nil
    local latestEnd = nil

    for trackIndex, _ in pairs(selectedTracks) do
        local clips = timeline:GetItemListInTrack("audio", trackIndex)
        if clips then
            for _, clip in ipairs(clips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()

                -- Skip clips completely outside the marker region
                if clipEnd > rangeStart and clipStart < rangeEnd then
                    local start = math.max(clipStart, rangeStart)
                    local end_ = math.min(clipEnd, rangeEnd)

                    if earliestStart == nil or start < earliestStart then
                        earliestStart = start
                    end
                    if latestEnd == nil or end_ > latestEnd then
                        latestEnd = end_
                    end
                end
            end
        end
    end

    return earliestStart, latestEnd
end


-- Export audio from selected tracks
-- inputTracks is a table of track indices to export
-- Request handlers below take the decoded request table, so a field renamed on
-- the TypeScript side is a nil value here rather than a silently shifted
-- positional argument.
function ExportAudio(req)
    local outputDir, inputTracks, exportRange = req.outputDir, req.inputTracks, req.exportRange
    -- Drop leftover AutoSubs render jobs from earlier exports so the Deliver
    -- queue stays clean. With nothing rendering this is unconditionally safe;
    -- a queued-but-dead one can also leave IsRenderingInProgress() stuck true.
    if not project:IsRenderingInProgress() then
        remove_stale_export_jobs(false)
    end
    if project:IsRenderingInProgress() then
        -- Busy: only drop jobs provably stalled (a live render must not be
        -- deleted mid-flight), then give Resolve a beat and re-check.
        remove_stale_export_jobs(true)
        bmd.wait(0.2)
    end
    if project:IsRenderingInProgress() then
        return {
            error = true,
            message = "Another export is already in progress",
            detail = "Resolve is rendering another job. Wait for it to finish or stop it on the Deliver page, then try again."
        }
    end

    -- Initialize export job state
    currentExportJob = {
        active = true,
        pid = nil,
        progress = 0,
        cancelled = false,
        startTime = os.time(),
        audioInfo = nil,
        trackStates = nil,
        renderSnapshot = nil,
        restartAttempted = false
    }

    local timeline = project:GetCurrentTimeline()
    local audioTracks = timeline:GetTrackCount("audio")

    -- Save track states immediately for restoration or error
    local trackStates = {}
    for i = 1, audioTracks do
        local state = timeline:GetIsTrackEnabled("audio", i)
        trackStates[i] = state
    end
    currentExportJob["trackStates"] = trackStates

    -- Create Set of selected track indices for quick lookup
    local selected = {}
    for _, v in ipairs(inputTracks) do
        local n = tonumber(v)
        if n then selected[n] = true end
    end

    -- Enable selected tracks (disable / mute others)
    for i = 1, audioTracks do
        local isEnabled = selected[i] == true
        timeline:SetTrackEnable("audio", i, isEnabled)
    end

    local exportName = "autosubs-exported-audio-" ..
        os.date("!%Y%m%d-%H%M%S") .. "-" .. tostring(math.random(100000, 999999))

    -- Build render settings. Both key spellings are sent: older Resolve docs
    -- show "ExportVideo"/"ExportAudio" while some versions accept the "Is*"
    -- forms; unknown keys are ignored, so setting both covers both.
    local renderSettings = {
        TargetDir = outputDir,
        CustomName = exportName,
        RenderMode = "Single clip",
        ExportVideo = false,
        ExportAudio = true,
        IsExportVideo = false,
        IsExportAudio = true,
        AudioBitDepth = 24,
        AudioSampleRate = 44100
    }

    -- Determine the broad region to export (in/out markers or entire timeline)
    local rangeStart, rangeEnd
    if exportRange == "inout" then
        local ok, inPt, outPt = pcall(get_marker_range, timeline)
        if ok then
            rangeStart, rangeEnd = inPt, outPt
        else
            -- GetMarkInOut() requires Resolve 20+, fall back to current In/Out points
            print("[AutoSubs] No markers found — using current In/Out points")
        end
    else
        rangeStart = timeline:GetStartFrame()
        rangeEnd = timeline:GetEndFrame()
    end

    -- Trim to actual clip boundaries (skip leading/trailing silence). Fall back
    -- to the full region if no clips are found (nil would crash the print below).
    if rangeStart then
        local exportStart, exportEnd = get_clip_boundaries(timeline, selected, rangeStart, rangeEnd)
        if exportStart == nil or exportEnd == nil then
            print("[AutoSubs] No clips found in export range — falling back to full region " ..
                tostring(rangeStart) .. " - " .. tostring(rangeEnd))
            exportStart = rangeStart
            exportEnd = rangeEnd
        end
        renderSettings.MarkIn = exportStart
        renderSettings.MarkOut = exportEnd
        print("[AutoSubs] Export range: " .. tostring(exportStart) .. " - " .. tostring(exportEnd))
    end

    -- Capture markers before the Deliver switch clobbers them.
    currentExportJob.savedMarks = nil
    if timeline.GetMarkInOut then
        pcall(function()
            currentExportJob.savedMarks = timeline:GetMarkInOut() or nil
        end)
    end

    -- Must switch to Deliver page to start render and customise settings (wierd quirk of Resolve API)
    resolve:OpenPage("deliver")

    -- Capture the user's render configuration before we overwrite it, so
    -- cleanup_render_job() can put the Deliver page back afterwards.
    currentExportJob.renderSnapshot = snapshot_render_state()

    -- Every mutation after the snapshot lives inside this pcall so a throw
    -- anywhere still runs the start-failure path (reset_tracks +
    -- cleanup_render_job) instead of leaving the user's Deliver settings
    -- half-overwritten.
    local success, err = pcall(function()
        -- 'Audio Only' is a stock preset, but its name is localized on non-English
        -- Resolve installs, so the load can silently fail. Without it the job renders
        -- with whatever preset was last selected and the app waits for a WAV that
        -- never appears. Check the return and configure audio-only output directly.
        local presetLoaded = project:LoadRenderPreset('Audio Only')
        if not presetLoaded then
            print("[AutoSubs] 'Audio Only' render preset not found; configuring WAV output directly")
            local ok, fmtErr = pcall(function()
                project:SetCurrentRenderFormatAndCodec('wav', 'LinearPCM')
            end)
            if not ok then
                print("[AutoSubs] Failed to set WAV render format: " .. tostring(fmtErr))
            end
        end

        project:SetRenderSettings(renderSettings)

        local pid = project:AddRenderJob()
        currentExportJob.pid = pid
        local started = project:StartRendering(pid)
        if not started then
            -- Resolve occasionally refuses the start while the Deliver page is
            -- still settling after the preset switch; try once more.
            print("[AutoSubs] StartRendering returned false; retrying once")
            bmd.wait(0.5)
            started = project:StartRendering(pid)
        end
        if not started then
            error("Resolve refused to start the render job (StartRendering returned false)")
        end

        -- Resolve may not immediately populate the job list. Prefer the job
        -- whose ID matches the PID we just added; if it isn't visible yet, fall
        -- back to the render settings we configured ourselves instead of picking
        -- an unrelated job from the list.
        local jobInfo
        local renderJobList = project:GetRenderJobList()
        if type(renderJobList) == "table" and #renderJobList > 0 then
            for i = #renderJobList, 1, -1 do
                local j = renderJobList[i]
                if type(j) == "table" and (j["JobId"] == pid or j["Id"] == pid) then
                    jobInfo = j
                    break
                end
            end
            if not jobInfo then
                print("[AutoSubs] Render job PID is not visible in the job list yet: " .. tostring(pid))
            end
        end

        -- Fallback so a missing or empty job list doesn't crash the server.
        if not jobInfo then
            print("[AutoSubs] GetRenderJobList did not return job info for PID " ..
            tostring(pid) .. ", using configured render settings")
            jobInfo = {
                TargetDir = outputDir,
                OutputFilename = exportName .. ".wav",
                MarkIn = renderSettings.MarkIn,
                MarkOut = renderSettings.MarkOut
            }
        end

        -- Use timeline bounds when neither the job record nor our render settings
        -- provide marks, so the offset and progress calculations never divide by zero.
        local timelineStart = timeline:GetStartFrame()
        local timelineEnd = timeline:GetEndFrame()
        local markIn = jobInfo["MarkIn"] or renderSettings.MarkIn or timelineStart
        local markOut = jobInfo["MarkOut"] or renderSettings.MarkOut or timelineEnd

        -- Calculate offset to align subtitles back to timeline (exported audio starts at mark in, not timeline 0)
        local framesFromTimelineStart = markIn - timeline:GetStartFrame()
        local frameRate = timeline:GetSetting("timelineFrameRate") or 24
        local timeOffsetInSeconds = framesFromTimelineStart / frameRate

        local targetDir = jobInfo["TargetDir"] or outputDir
        local outputFilename = jobInfo["OutputFilename"] or (exportName .. ".wav")

        local audioInfo = {
            path = join_path(targetDir, outputFilename),
            markIn = markIn,
            markOut = markOut,
            offset = timeOffsetInSeconds
        }
        currentExportJob.audioInfo = audioInfo

        print("Export started with PID: " .. tostring(pid) .. ", path: " .. audioInfo.path)
    end)

    -- Handle export start result
    if not success then
        reset_tracks()
        cleanup_render_job()
        currentExportJob.active = false
        local detail = tostring(err or "unknown error")
        print("[AutoSubs] ExportAudio failed to start: " .. detail)
        return {
            error = true,
            message = "Failed to start audio export",
            detail = detail
        }
    else
        -- Export started successfully - return immediately
        return {
            started = true,
            message = "Export started successfully. Use GetExportProgress to monitor progress.",
            pid = currentExportJob.pid
        }
    end
end

local function sanitize_track_index(timeline, trackIndex, markIn, markOut)
    -- Only create a new track if trackIndex is explicitly "0" (new track), empty/nil, or invalid
    -- Respect user's track selection regardless of whether the track is empty
    local numeric = tonumber(trackIndex)
    if trackIndex == "0" or trackIndex == "" or trackIndex == nil or numeric == nil or
        numeric < 1 or numeric > timeline:GetTrackCount("video") then
        trackIndex = timeline:GetTrackCount("video") + 1
        timeline:AddTrack("video")
        return trackIndex
    end

    -- A fractional index would make Resolve reject the clipInfo; snap it.
    return math.floor(numeric)
end

-- Check for existing clips on a track that would conflict with new subtitles
-- Returns conflict info: { hasConflicts, conflictingClips: [{start, end, name}], trackName }
function CheckTrackConflicts(req)
    local filePath, trackIndex = req.filePath, req.trackIndex
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { hasConflicts = false, error = "No active timeline" }
    end
    local timelineStart = timeline:GetStartFrame()
    local frame_rate = timeline:GetSetting("timelineFrameRate")

    -- Subtitle data arrives decoded on the request (the app reads the file
    -- itself); filePath only identifies which transcript it came from.
    local data = req.subtitleData
    if type(data) ~= "table" then
        return {
            hasConflicts = false,
            error = "Could not read subtitle file",
            detail = "request did not include subtitleData"
        }
    end

    local subtitles = data["segments"]
    if not subtitles or #subtitles == 0 then
        return { hasConflicts = false, message = "No subtitles to add" }
    end

    -- Get the time range of new subtitles
    local firstSubStart = to_frames(subtitles[1]["start"], frame_rate) + timelineStart
    local lastSubEnd = to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart

    -- Validate track index
    trackIndex = tonumber(trackIndex)
    if not trackIndex or trackIndex <= 0 or trackIndex > timeline:GetTrackCount("video") then
        return { hasConflicts = false, trackExists = false, message = "Track does not exist" }
    end

    -- Get track name
    local trackName = timeline:GetTrackName("video", trackIndex) or ("Video " .. trackIndex)

    -- Get existing clips on the track
    local existingClips = timeline:GetItemListInTrack("video", trackIndex)
    if not existingClips or #existingClips == 0 then
        return { hasConflicts = false, trackName = trackName, message = "Track is empty" }
    end

    -- Find clips that overlap with the new subtitle range
    local conflictingClips = {}
    for _, clip in ipairs(existingClips) do
        local clipStart = clip:GetStart()
        local clipEnd = clip:GetEnd()

        -- Check if clip overlaps with subtitle range
        if clipStart < lastSubEnd and clipEnd > firstSubStart then
            table.insert(conflictingClips, {
                start = (clipStart - timelineStart) / frame_rate,
                ["end"] = (clipEnd - timelineStart) / frame_rate,
                name = clip:GetName() or "Unnamed clip"
            })
        end
    end

    return {
        hasConflicts = #conflictingClips > 0,
        conflictingClips = conflictingClips,
        trackName = trackName,
        subtitleRange = {
            start = (firstSubStart - timelineStart) / frame_rate,
            ["end"] = (lastSubEnd - timelineStart) / frame_rate
        },
        totalConflicts = #conflictingClips
    }
end

local function load_subtitle_data(req)
    local data = req.subtitleData
    if type(data) ~= "table" then
        return nil, "request did not include subtitleData"
    end
    return data
end

local function get_transcript_id(data, filePath)
    return data["transcriptId"]
        or (data["metadata"] and data["metadata"]["transcriptId"])
        or data["filename"]
        or filePath
end

local function get_mark_in_out(timeline, data)
    local timelineStart = timeline:GetStartFrame()
    local timelineEnd = timeline:GetEndFrame()
    local markIn = data["mark_in"]
    local markOut = data["mark_out"]

    if not markIn or not markOut then
        local success, err = pcall(function()
            if timeline.GetMarkInOut then
                local markInOut = timeline:GetMarkInOut()
                markIn = (markInOut.audio["in"] and markInOut.audio["in"] + timelineStart) or timelineStart
                markOut = (markInOut.audio["out"] and markInOut.audio["out"] + timelineStart) or timelineEnd
            else
                markIn = timelineStart
                markOut = timelineEnd
            end
        end)

        if not success then
            markIn = timelineStart
            markOut = timelineEnd
        end
    end

    return markIn, markOut
end

local function sanitize_speaker_tracks(timeline, speakers, trackIndex, markIn, markOut)
    if not speakers or #speakers == 0 then
        return speakers
    end

    for _, speaker in ipairs(speakers) do
        if speaker.track == nil or speaker.track == "" then
            speaker.track = trackIndex
        else
            speaker.track = sanitize_track_index(timeline, speaker.track, markIn, markOut)
        end
    end

    return speakers
end

-- Frame rate of the template clip, falling back to the timeline (and finally
-- 24 fps) when Resolve cannot report the clip's FPS property.
local function template_frame_rate_of(templateItem, timeline)
    local fps = tonumber(clip_property(templateItem, "FPS"))
    if not fps then
        fps = tonumber(call_api(timeline, "GetSetting", "timelineFrameRate"))
    end
    return fps or 24
end

local function get_template(rootFolder, templateName, timeline)
    if not is_api_object(rootFolder) then
        return nil, nil, MEDIA_POOL_UNAVAILABLE
    end
    if templateName == "" then
        templateName = ANIMATED_CAPTION
    end

    templateName = resolve_template_name(templateName)
    local templateItem = nil
    local resolvedName = templateName -- tracks which template was actually found
    if templateName ~= nil and templateName ~= "" then
        templateItem = get_template_item(rootFolder, templateName)
    end
    -- If the template wasn't found, auto-import the default caption-bin.drb
    -- if it hasn't been tried for this project yet, then retry the lookup.
    if not templateItem and templateName ~= nil and templateName ~= "" then
        ensure_default_template(rootFolder)
        templateItem = get_template_item(rootFolder, templateName)
    end
    if not templateItem then
        templateItem = get_template_item(rootFolder, "Default Template")
        resolvedName = "Default Template"
    end
    -- Final fallback: the bundled animated caption template.
    if not templateItem then
        templateItem = get_template_item(rootFolder, ANIMATED_CAPTION)
        resolvedName = ANIMATED_CAPTION
    end
    if not templateItem then
        return nil, nil, "Could not find subtitle template '" .. tostring(templateName) ..
            "' in media pool (also tried 'Default Template' and '" .. ANIMATED_CAPTION .. "')"
    end

    local template_frame_rate = template_frame_rate_of(templateItem, timeline)
    -- Return resolvedName so callers detect the animated caption template even
    -- after a fallback (the isAnimated flag depends on it).
    return templateItem, template_frame_rate, nil, resolvedName
end

local function apply_conflict_mode(timeline, subtitles, trackIndex, conflictMode, frame_rate, timelineStart)
    if conflictMode == "new_track" then
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local firstSubStart = to_frames(subtitles[1]["start"], frame_rate) + timelineStart
            local lastSubEnd = to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart
            local hasConflict = false
            for _, clip in ipairs(existingClips) do
                if clip:GetStart() < lastSubEnd and clip:GetEnd() > firstSubStart then
                    hasConflict = true
                    break
                end
            end
            if hasConflict then
                trackIndex = timeline:GetTrackCount("video") + 1
                timeline:AddTrack("video")
                print("[AutoSubs] Created new track: " .. trackIndex)
            else
                print("[AutoSubs] No conflicts on track " .. trackIndex .. ", using existing track")
            end
        else
            print("[AutoSubs] Track " .. trackIndex .. " is empty, using existing track")
        end
        return trackIndex, subtitles, nil
    end

    if conflictMode == "replace" then
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local firstSubStart = to_frames(subtitles[1]["start"], frame_rate) + timelineStart
            local lastSubEnd = to_frames(subtitles[#subtitles]["end"], frame_rate) + timelineStart

            local clipsToDelete = {}
            for _, clip in ipairs(existingClips) do
                local clipStart = clip:GetStart()
                local clipEnd = clip:GetEnd()
                if clipStart < lastSubEnd and clipEnd > firstSubStart then
                    table.insert(clipsToDelete, clip)
                end
            end

            for _, clip in ipairs(clipsToDelete) do
                timeline:DeleteClips({ clip }, false)
            end
            print("[AutoSubs] Deleted " .. #clipsToDelete .. " conflicting clips")
        end

        return trackIndex, subtitles, nil
    end

    if conflictMode == "skip" then
        local existingClips = timeline:GetItemListInTrack("video", trackIndex)
        if existingClips and #existingClips > 0 then
            local filteredSubtitles = {}
            for _, subtitle in ipairs(subtitles) do
                local subStart = to_frames(subtitle["start"], frame_rate) + timelineStart
                local subEnd = to_frames(subtitle["end"], frame_rate) + timelineStart

                local hasConflict = false
                for _, clip in ipairs(existingClips) do
                    local clipStart = clip:GetStart()
                    local clipEnd = clip:GetEnd()
                    if subStart < clipEnd and subEnd > clipStart then
                        hasConflict = true
                        break
                    end
                end

                if not hasConflict then
                    table.insert(filteredSubtitles, subtitle)
                end
            end

            print("[AutoSubs] Skipped " .. (#subtitles - #filteredSubtitles) .. " conflicting subtitles")
            subtitles = filteredSubtitles

            if #subtitles == 0 then
                print("[AutoSubs] All subtitles skipped due to conflicts")
                return trackIndex, subtitles,
                    { success = true, message = "All subtitles skipped due to existing content", added = 0 }
            end
        end
    end

    return trackIndex, subtitles, nil
end

local function normalize_speaker_id(id)
    if id == nil then return nil end
    local normalized = tostring(id):match("^%s*(.-)%s*$")
    if normalized == "" or normalized == "?" then return nil end

    local withoutPrefix = normalized:match("^Speaker%s+(.+)$")
    if withoutPrefix then
        normalized = withoutPrefix:match("^%s*(.-)%s*$")
    end
    return normalized
end

local function build_speaker_index_by_id(subtitles)
    local speakerIndexById = {}
    local nextIndex = 1
    for _, subtitle in ipairs(subtitles or {}) do
        local speakerId = normalize_speaker_id(subtitle.speaker_id)
        if speakerId and speakerIndexById[speakerId] == nil then
            speakerIndexById[speakerId] = nextIndex
            nextIndex = nextIndex + 1
        end
    end
    return speakerIndexById
end

local function get_speaker_from_id(speakers, id, speakerIndexById)
    local normalizedId = normalize_speaker_id(id)
    if normalizedId == nil then return nil end

    -- Rust builds the speakers array in first-appearance order while preserving
    -- the engine's raw IDs on segments. Mirror that ordering instead of treating
    -- numeric IDs as array positions.
    local speakerIndex = speakerIndexById and speakerIndexById[normalizedId]
    if speakerIndex and speakers[speakerIndex] ~= nil then
        return speakers[speakerIndex]
    end

    -- Preserve compatibility with legacy documents that predate aggregation.
    local numericId = tonumber(normalizedId)
    if numericId == nil then return nil end
    return speakers[numericId + 1] or speakers[numericId]
end

local function tag_subtitle_tool(tool, transcriptId, segmentIndex, speakerId)
    tool:SetData("AutoSubsTranscriptId", tostring(transcriptId))
    tool:SetData("AutoSubsSegmentIndex", segmentIndex)
    tool:SetData("AutoSubsSpeakerId", speakerId ~= nil and tostring(speakerId) or "")
end

local function find_subtitle_clips(timeline, transcriptId, subtitles, targetSpeakerId)
    local matches = {}
    local stats = { scanned = 0, failed = 0, migrated = 0 }
    local expectedByFrame = {}
    local timelineStart = timeline:GetStartFrame()
    local frameRate = tonumber(timeline:GetSetting("timelineFrameRate"))

    -- Legacy animated captions do not have hidden tags. Index the current
    -- transcript by start frame so matching clips can be tagged on first use.
    if frameRate then
        for index, subtitle in ipairs(subtitles or {}) do
            if subtitle.start ~= nil then
                local frame = math.floor(timelineStart + to_frames(subtitle.start, frameRate) + 0.5)
                expectedByFrame[frame] = { index = index, subtitle = subtitle }
            end
        end
    end

    local wantedTranscript = tostring(transcriptId)
    local wantedSpeaker = targetSpeakerId ~= nil and tostring(targetSpeakerId) or nil
    local trackCount = timeline:GetTrackCount("video")

    for trackIndex = 1, trackCount do
        local items = timeline:GetItemListInTrack("video", trackIndex) or {}
        for _, timelineItem in ipairs(items) do
            stats.scanned = stats.scanned + 1
            local ok, err = pcall(function()
                local compCount = timelineItem:GetFusionCompCount()
                if not compCount or compCount < 1 then return end

                local comp = timelineItem:GetFusionCompByIndex(1)
                if not comp then return end

                local autosubsTool = comp:FindTool("AutoSubs")
                local template = comp:FindTool("Template") or comp:FindToolByID("TextPlus")
                local styleTool = autosubsTool or template
                if not styleTool then return end

                local taggedTranscript = styleTool:GetData("AutoSubsTranscriptId")
                local segmentIndex = tonumber(styleTool:GetData("AutoSubsSegmentIndex"))
                local speakerId = styleTool:GetData("AutoSubsSpeakerId")

                -- Migrate legacy AutoSubs Caption clips conservatively: require
                -- the named macro, matching start frame, and matching text.
                if (taggedTranscript == nil or taggedTranscript == "") and autosubsTool and template then
                    local itemFrame = math.floor(tonumber(timelineItem:GetStart()) + 0.5)
                    local expected = expectedByFrame[itemFrame]
                        or expectedByFrame[itemFrame - 1]
                        or expectedByFrame[itemFrame + 1]
                    if expected then
                        local currentText = template:GetInput("Text")
                        if tostring(currentText) == tostring(expected.subtitle.text) then
                            segmentIndex = expected.index
                            speakerId = expected.subtitle.speaker_id
                            tag_subtitle_tool(styleTool, transcriptId, segmentIndex, speakerId)
                            taggedTranscript = wantedTranscript
                            stats.migrated = stats.migrated + 1
                        end
                    end
                end

                if tostring(taggedTranscript) ~= wantedTranscript then return end
                if wantedSpeaker and tostring(speakerId) ~= wantedSpeaker then return end

                table.insert(matches, {
                    timelineItem = timelineItem,
                    comp = comp,
                    styleTool = styleTool,
                    template = template,
                    isAnimated = autosubsTool ~= nil,
                    segmentIndex = segmentIndex,
                    speakerId = speakerId,
                    trackIndex = trackIndex
                })
            end)
            if not ok then
                stats.failed = stats.failed + 1
                print("[AutoSubs] Failed to inspect timeline clip for batch styling: " .. tostring(err))
            end
        end
    end

    stats.matched = #matches
    return matches, stats
end

-- AppendToTimeline does not report a blocked append: it returns truthy "dead"
-- item handles whose methods all return nothing (so they later surface as
-- GetFusionCompCount() == nil and look like a version-incompatible template).
-- Probing a cheap getter tells a placed clip from a dead handle.
local function is_live_item(item)
    if item == nil then return false end
    local probeOk, probeVal = pcall(function() return item:GetStart() end)
    return probeOk and probeVal ~= nil
end

-- Builds the clipInfo list for AppendToTimeline. Returns:
--   clipList           -- clipInfo dicts in subtitle order
--   clipSubtitleIndex  -- clipList[k] belongs to subtitles[clipSubtitleIndex[k]]
--   skippedBounds      -- count of segments dropped for falling outside the
--                         timeline (whisper can emit slightly negative starts,
--                         and transcripts can be longer than the timeline).
-- A clipInfo outside the timeline bounds (or with a non-integer frame) can make
-- Resolve reject or dead-handle the whole batch, so out-of-bounds segments are
-- dropped here rather than left to fail inside the append.
local function build_clip_list(subtitles, speakers, speakersExist, trackIndex, templateItem, frame_rate,
                               template_frame_rate, timelineStart, timelineEnd, speakerIndexById)
    local joinThreshold = frame_rate
    local clipList = {}
    local clipSubtitleIndex = {}
    local skippedBounds = 0
    local prevClip, prevClipEnd = nil, nil -- last emitted clip + its exclusive end frame
    for i, subtitle in ipairs(subtitles) do
        -- Skip malformed segments (nil start/end) instead of crashing in to_frames().
        if subtitle["start"] == nil or subtitle["end"] == nil then
            print(string.format("[AutoSubs] Skipping subtitle #%d with missing start/end time (start=%s, end=%s)",
                i, tostring(subtitle["start"]), tostring(subtitle["end"])))
            goto continue
        end
        -- Resolve 21 AppendToTimeline rejects non-integer frame values and
        -- returns nil for the whole batch. Snap to nearest timeline frame.
        local start_frame = math.floor(to_frames(subtitle["start"], frame_rate) + 0.5)
        local end_frame = math.floor(to_frames(subtitle["end"], frame_rate) + 0.5)
        if end_frame <= start_frame then
            end_frame = start_frame + 1
        end

        local itemTrack = trackIndex
        if speakersExist then
            local speaker = get_speaker_from_id(speakers, subtitle.speaker_id, speakerIndexById)
            if speaker and speaker.track ~= nil and speaker.track ~= "" then
                itemTrack = speaker.track
            end
        end

        local timeline_pos = timelineStart + start_frame
        local clip_timeline_duration = end_frame - start_frame

        -- Clips cannot start before the timeline's first frame.
        if timelineEnd and timeline_pos >= timelineEnd or timeline_pos + clip_timeline_duration <= timelineStart then
            skippedBounds = skippedBounds + 1
            goto continue
        end
        if timeline_pos < timelineStart then
            clip_timeline_duration = clip_timeline_duration - (timelineStart - timeline_pos)
            timeline_pos = timelineStart
        end
        if timelineEnd and timeline_pos + clip_timeline_duration > timelineEnd then
            clip_timeline_duration = timelineEnd - timeline_pos
        end

        -- If the gap to the previous clip on the same track is under ~1 s, join
        -- them by extending the previous clip to end at this clip's start (the
        -- old +1 overshot into this clip's first frame, a 1-frame overlap that
        -- Resolve can refuse as a blocked append).
        if prevClip and prevClip.trackIndex == itemTrack then
            local frames_between = timeline_pos - prevClipEnd
            if frames_between < joinThreshold then
                prevClip.endFrame = math.max(1, math.floor(
                    prevClip.endFrame + (frames_between / frame_rate) * template_frame_rate + 0.5))
            end
        end

        -- endFrame is template-relative source frames, not timeline frames.
        local duration = math.max(1, math.floor((clip_timeline_duration / frame_rate) * template_frame_rate + 0.5))

        local newClip = {
            mediaPoolItem = templateItem,
            mediaType = 1,
            startFrame = 0,
            endFrame = duration,
            recordFrame = math.floor(timeline_pos + 0.5),
            trackIndex = itemTrack
        }

        table.insert(clipList, newClip)
        table.insert(clipSubtitleIndex, i)
        prevClip, prevClipEnd = newClip, timeline_pos + clip_timeline_duration
        ::continue::
    end

    if skippedBounds > 0 then
        print(string.format("[AutoSubs] Skipped %d subtitle(s) that fall outside the timeline's range",
            skippedBounds))
    end

    return clipList, clipSubtitleIndex, skippedBounds
end

-- Applies subtitle text + styling to each appended timeline item. Instead of
-- spamming one print per failed clip, we aggregate failures and return a
-- summary so the caller can surface a single clean error.
-- Returns: { failed = N, total = M, firstError = "..." }
-- templateName names the media pool clip these items were appended from:
-- caption_style.apply needs it to tell the bundled macro from a user's own
-- title before running any helper the comp carries.
local function apply_subtitle_text(timelineItems, clipCount, subtitles, clipSubtitleIndex, speakers,
                                   speakersExist, presetSettings, speakerIndexById, transcriptId, templateName)
    local startTime = os.clock()
    local failed = 0
    local noFusionComp = 0
    local firstError = nil
    -- timelineItems aligns with clipSubtitleIndex and may have holes (clips
    -- Resolve never placed), so iterate to clipCount rather than ipairs.
    for i = 1, clipCount do
        local timelineItem = timelineItems[i]
        if timelineItem == nil then
            failed = failed + 1
            if firstError == nil then
                firstError = "clip was not placed on the timeline (AppendToTimeline returned no item)"
            end
        else
            local success, err = pcall(function()
                -- clipSubtitleIndex maps the appended clip back to its segment;
                -- build_clip_list can skip malformed/out-of-range segments, so a
                -- bare [i] would pair text to the wrong subtitle after a skip.
                local subtitle = subtitles[clipSubtitleIndex[i]]
                local subtitleText = subtitle["text"]

                local fusionCompCount = timelineItem:GetFusionCompCount()
                if not fusionCompCount then
                    noFusionComp = noFusionComp + 1
                    error(
                    "clip has no Fusion composition (GetFusionCompCount returned nil): Resolve either refused to place the clip (blocked append) or the template is incompatible with this Resolve version")
                end
                if fusionCompCount > 0 then
                    local comp = timelineItem:GetFusionCompByIndex(1)
                    local speaker = nil
                    if speakersExist then
                        speaker = get_speaker_from_id(speakers, subtitle.speaker_id, speakerIndexById)
                    end

                    local styleTool = caption_style.apply(comp, {
                        templateName = templateName,
                        text = subtitleText,
                        words = subtitle.words,
                        start = subtitle.start,
                        settings = presetSettings,
                        speaker = speaker,
                    })

                    -- Hidden Fusion tool data lets later batch operations identify
                    -- the transcript segment without changing visible clip names.
                    tag_subtitle_tool(styleTool, transcriptId, clipSubtitleIndex[i], subtitle.speaker_id)

                    timelineItem:SetClipColor("Green") -- Visualise updated clips
                end
            end)

            if not success then
                failed = failed + 1
                if firstError == nil then firstError = tostring(err) end
            end
        end
    end

    if noFusionComp > 0 then
        print(string.format(
            "[AutoSubs] %d of %d subtitle clips had no Fusion composition (GetFusionCompCount returned nil). Resolve either refused to place those clips or the template is incompatible with this Resolve version.",
            noFusionComp, clipCount))
    end
    if failed > 0 then
        print(string.format("[AutoSubs] Failed to place %d of %d subtitles. First error: %s",
            failed, clipCount, tostring(firstError)))
    end

    print(string.format("[AutoSubs] Applied subtitle text to %d clips in %.3f seconds.", clipCount - failed,
        os.clock() - startTime))

    return { failed = failed, total = clipCount, firstError = firstError, noFusionComp = noFusionComp }
end

-- Add subtitles to the timeline using the specified template
-- conflictMode: "replace" (delete existing), "skip" (write around conflicts), "new_track" (use new track), nil (default/old behavior)
-- presetSettings: optional opaque table of AutoSubs Caption macro input values
-- (captured via OpenPresetEdit/SavePresetEdit). Ignored for non-animated templates.
function AddSubtitles(req)
    local filePath, trackIndex, templateName = req.filePath, req.trackIndex, req.templateName
    local conflictMode, presetSettings = req.conflictMode, req.presetSettings
    refresh_project()
    resolve:OpenPage("edit")

    -- Wrap placement so restore_user_state() runs on every exit path.
    local result
    local ok, err = pcall(function()
        result = (function()
            local data, loadErr = load_subtitle_data(req)
            if not data then
                return make_error("Failed to load subtitle file", loadErr)
            end

            ---@type { mark_in: integer, mark_out: integer, segments: table, speakers: table }
            data = data

            local timeline = project:GetCurrentTimeline()
            if not timeline then
                return make_error("Failed to add subtitles", "No active timeline in Resolve")
            end
            local timelineStart = timeline:GetStartFrame()
            local markIn, markOut = get_mark_in_out(timeline, data)
            local subtitles = data["segments"]
            local speakers = data["speakers"]

            if not subtitles or #subtitles == 0 then
                return make_error("Failed to add subtitles", "Transcript has no segments")
            end
            local speakerIndexById = build_speaker_index_by_id(subtitles)
            local transcriptId = get_transcript_id(data, filePath)

            local speakersExist = false
            if speakers and #speakers > 0 then
                speakersExist = true
            end

            trackIndex = sanitize_track_index(timeline, trackIndex, markIn, markOut)

            local frame_rate = tonumber(timeline:GetSetting("timelineFrameRate"))
            if not frame_rate then
                return make_error("Failed to add subtitles", "Could not read the timeline frame rate")
            end

            local earlyResult = nil
            trackIndex, subtitles, earlyResult = apply_conflict_mode(timeline, subtitles, trackIndex, conflictMode,
                frame_rate,
                timelineStart)
            if earlyResult then
                return earlyResult
            end

            speakers = sanitize_speaker_tracks(timeline, speakers, trackIndex, markIn, markOut)

            local rootFolder = call_api(mediaPool, "GetRootFolder")
            local templateItem, template_frame_rate, templateErr, resolvedTemplateName = get_template(rootFolder,
                templateName, timeline)
            if not templateItem then
                return make_error("Template not found", templateErr)
            end

            local clipList, clipSubtitleIndex, skippedBounds = build_clip_list(subtitles, speakers, speakersExist,
                trackIndex, templateItem, frame_rate, template_frame_rate, timelineStart, timeline:GetEndFrame(),
                speakerIndexById)

            if #clipList == 0 then
                local reason = skippedBounds > 0 and
                    "all " .. skippedBounds .. " subtitle(s) fall outside the timeline's range" or
                    "no valid segments to place"
                return make_error("Failed to add subtitles to timeline", reason)
            end

            -- Temporarily unlock locked target tracks so AppendToTimeline doesn't
            -- silently return an empty table. Re-lock them afterwards.
            local lockedTracks = {}
            if timeline.GetIsTrackLocked and timeline.SetTrackLock then
                local trackSet = {}
                for _, clip in ipairs(clipList) do
                    trackSet[clip.trackIndex] = true
                end
                for ti in pairs(trackSet) do
                    local isLocked = false
                    pcall(function()
                        isLocked = timeline:GetIsTrackLocked("video", ti) or false
                    end)
                    if isLocked then
                        pcall(timeline.SetTrackLock, timeline, "video", ti, false)
                        lockedTracks[ti] = true
                        print("[AutoSubs] Temporarily unlocked video track " .. ti .. " for placement")
                    end
                end
            end

            local appendOk, timelineItems = pcall(function()
                return mediaPool:AppendToTimeline(clipList)
            end)

            -- A single bad clipInfo can make Resolve reject or return nil for
            -- the whole batch on Resolve 21. Fall back to one append per clip so
            -- the good ones still land; dead handles are retried below.
            if not appendOk or type(timelineItems) ~= "table" or #timelineItems == 0 then
                if not appendOk then
                    print("[AutoSubs] Batch AppendToTimeline failed: " .. tostring(timelineItems))
                else
                    print("[AutoSubs] Batch AppendToTimeline returned no items; retrying per clip")
                end
                timelineItems = {}
                for i, clip in ipairs(clipList) do
                    local oneOk, oneItems = pcall(function()
                        return mediaPool:AppendToTimeline({ clip })
                    end)
                    if oneOk and type(oneItems) == "table" and oneItems[1] ~= nil then
                        timelineItems[i] = oneItems[1]
                    end
                end
            end

            for ti in pairs(lockedTracks) do
                pcall(timeline.SetTrackLock, timeline, "video", ti, true)
                print("[AutoSubs] Re-locked video track " .. ti)
            end

            local anyPlaced = false
            for i = 1, #clipList do
                if timelineItems[i] ~= nil then
                    anyPlaced = true
                    break
                end
            end
            if not anyPlaced then
                return make_error("Failed to add subtitles to timeline",
                    "Resolve did not place any caption clips. This can happen if the template " ..
                    "clip is invalid/corrupt or the target track index is out of range. " ..
                    "Try re-importing the template or choosing a different track.")
            end

            -- AppendToTimeline does not report a blocked append: it returns
            -- truthy "dead" item handles whose methods all return nothing (so
            -- they later surface as GetFusionCompCount() == nil and look like
            -- a version-incompatible template). Detect them by probing a cheap
            -- getter, then retry each blocked clip individually on freshly
            -- added video tracks. Per-clip retries matter: clip frame ranges
            -- can overlap each other (build_clip_list extends durations into
            -- small gaps), so clips that were blocked may still conflict with
            -- each other on a shared fresh track. When the current fresh track
            -- also returns a dead handle for a clip, that clip spills onto
            -- another fresh track.
            local createdTracks = {}
            local function add_fresh_track()
                local addOk, added = pcall(function() return timeline:AddTrack("video") end)
                if addOk and added then
                    local idx = timeline:GetTrackCount("video")
                    table.insert(createdTracks, idx)
                    return idx
                end
                return nil
            end

            -- timelineItems is aligned with clipList, not necessarily dense: a
            -- clip the batch never placed leaves a hole, which counts as dead.
            local deadIndices = {}
            for i = 1, #clipList do
                if not is_live_item(timelineItems[i]) then
                    table.insert(deadIndices, i)
                end
            end
            if #deadIndices > 0 then
                print(string.format(
                    "[AutoSubs] %d of %d appended clips are dead handles (blocked append), retrying on fresh video tracks",
                    #deadIndices, #clipList))
                -- Each source track gets its own fresh retry track so retries
                -- preserve speaker-track separation instead of folding every
                -- speaker onto one track.
                local retryTrackBySource = {}
                local retryTrackUsed = {}
                local recovered = 0
                for _, i in ipairs(deadIndices) do
                    local clip = clipList[i]
                    if clip then
                        local sourceTrack = clip.trackIndex
                        -- First-choice retry track for this source track:
                        -- remembered even while it is empty so sibling clips of
                        -- the same speaker track still land together.
                        local retryTrack = retryTrackBySource[sourceTrack]
                        if retryTrack == nil then
                            retryTrack = add_fresh_track()
                            retryTrackBySource[sourceTrack] = retryTrack
                        end
                        local placed = false
                        for attempt = 1, 2 do
                            if retryTrack == nil then break end
                            clip.trackIndex = retryTrack
                            local retryOk, retryItems = pcall(function()
                                return mediaPool:AppendToTimeline({ clip })
                            end)
                            if retryOk and type(retryItems) == "table" and retryItems[1] and is_live_item(retryItems[1]) then
                                timelineItems[i] = retryItems[1]
                                retryTrackUsed[retryTrack] = true
                                placed = true
                                recovered = recovered + 1
                                break
                            end
                            -- Overlapping sibling clips can collide on the same
                            -- retry track, so the next attempt uses another
                            -- fresh track; the map keeps pointing at the first
                            -- choice for later siblings.
                            retryTrack = nil
                        end
                        if not placed then
                            print("[AutoSubs] Clip " .. i .. " could not be placed even on fresh tracks")
                        end
                    end
                end
                -- Remove retry tracks where nothing landed (failed appends leave
                -- empty tracks behind). Delete highest index first so earlier
                -- indices stay valid.
                for t = #createdTracks, 1, -1 do
                    local idx = createdTracks[t]
                    if not retryTrackUsed[idx] then
                        local items = timeline:GetItemsInTrack("video", idx)
                        if items == nil or next(items) == nil then
                            timeline:DeleteTrack("video", idx)
                        end
                    end
                end
                if recovered > 0 then
                    print(string.format("[AutoSubs] Recovered %d of %d blocked clips onto fresh video tracks",
                        recovered, #deadIndices))
                end
            end

            -- Use the resolved template name so a fallback to ANIMATED_CAPTION still
            -- enables the animated-text path.
            local isAnimated = caption_style.is_autosubs_template(resolvedTemplateName)

            -- Auto-swap the caption Font for non-Latin transcript languages when the
            -- user is still on the macro's default font. Uses the transcript JSON's
            -- `language` field so older transcripts in a different language still get
            -- the right font even if the app's current language setting has moved on.
            local fontSwap = nil
            if isAnimated and font_fallback then
                presetSettings, fontSwap = font_fallback.maybe_override(presetSettings, data["language"])
            end

            local applyStats = apply_subtitle_text(timelineItems, #clipList, subtitles, clipSubtitleIndex, speakers,
                speakersExist, presetSettings, speakerIndexById, transcriptId, resolvedTemplateName)

            -- What was placed, for AI Edit: it remembers each title's text so
            -- a later cut can re-create the pieces (a Text+ cannot be read
            -- back from the bridge loop, and has no media to rebuild from).
            local createdItems = {}
            for k = 1, #clipList do
                local item = timelineItems[k]
                local sub = subtitles[clipSubtitleIndex[k]]
                if sub and is_live_item(item) then
                    local okId, id = pcall(item.GetUniqueId, item)
                    local okTrack, _, trackIdx = pcall(item.GetTrackTypeAndIndex, item)
                    if okId and id then
                        createdItems[#createdItems + 1] = {
                            id = id,
                            text = sub.text,
                            start = sub.start,
                            ["end"] = sub["end"],
                            track = okTrack and tonumber(trackIdx) or nil,
                        }
                    end
                end
            end
            if skippedBounds > 0 then
                applyStats.failed = applyStats.failed + skippedBounds
                applyStats.total = applyStats.total + skippedBounds
                if applyStats.firstError == nil then
                    applyStats.firstError =
                        skippedBounds .. " subtitle(s) fell outside the timeline's range and were skipped"
                end
            end

            -- Force timeline refresh by jumping to the first subtitle
            if subtitles and #subtitles > 0 then
                JumpToTime(subtitles[1].start)
            end

            -- If some (but not all) clips failed to receive text/styling, still
            -- report success plus the counts so the UI can localize a warning.
            if applyStats and applyStats.failed > 0 and applyStats.failed < applyStats.total then
                return {
                    ok = true,
                    fontSwap = fontSwap,
                    items = createdItems,
                    failed = applyStats.failed,
                    total = applyStats.total,
                    noFusionComp = applyStats.noFusionComp,
                    skipped = skippedBounds,
                    detail = applyStats.firstError
                }
            elseif applyStats and applyStats.failed == applyStats.total and applyStats.total > 0 then
                local short = string.format("Failed to place all %d subtitles", applyStats.total)
                local errCode = nil
                if applyStats.noFusionComp and applyStats.noFusionComp == #clipList and #clipList > 0 then
                    -- Every clip was a dead handle / comp-less: the frontend
                    -- renders the occupied-or-locked-track guidance localized.
                    errCode = "clips_blocked"
                end
                return make_error(short, applyStats.firstError, errCode)
            end

            return { ok = true, fontSwap = fontSwap, items = createdItems }
        end)() -- end of inner placement function
    end)

    restore_user_state()

    if not ok then
        return make_error("Failed to add subtitles", err)
    end
    return result
end

function BatchApplyStyle(req)
    local filePath, targetSpeakerId, presetSettings = req.filePath, req.targetSpeakerId, req.presetSettings
    refresh_project()

    local data, loadErr = load_subtitle_data(req)
    if not data then
        return make_error("Failed to load subtitle file", loadErr)
    end

    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return make_error("Failed to apply caption styles", "No active timeline in Resolve")
    end

    local subtitles = data["segments"] or {}
    if #subtitles == 0 then
        return make_error("Failed to apply caption styles", "Transcript has no segments")
    end

    local speakers = data["speakers"] or {}
    local speakerIndexById = build_speaker_index_by_id(subtitles)
    local transcriptId = get_transcript_id(data, filePath)
    local matches, discovery = find_subtitle_clips(
        timeline,
        transcriptId,
        subtitles,
        targetSpeakerId
    )

    local fontSwap = nil
    if presetSettings ~= nil and next(presetSettings) ~= nil and font_fallback then
        presetSettings, fontSwap = font_fallback.maybe_override(presetSettings, data["language"])
    end

    local updated = 0
    local skipped = 0
    local failed = 0
    local firstError = nil

    for _, match in ipairs(matches) do
        local ok, err = pcall(function()
            local didUpdate = false

            local speaker = get_speaker_from_id(speakers, match.speakerId, speakerIndexById)

            if match.isAnimated then
                local clipSettings = caption_style.with_speaker(presetSettings, speaker)
                if next(clipSettings) ~= nil then
                    caption_style.write(match.comp, match.styleTool, clipSettings)
                    didUpdate = true
                end
            else
                didUpdate = caption_style.apply_speaker_to_textplus(match.styleTool, speaker)
            end

            if didUpdate then
                updated = updated + 1
            else
                skipped = skipped + 1
            end
        end)

        if not ok then
            failed = failed + 1
            if firstError == nil then firstError = tostring(err) end
        end
    end

    if #matches > 0 and failed == #matches then
        return {
            error = "Failed to apply caption styles",
            detail = firstError,
            matched = #matches,
            failed = failed
        }
    end

    return {
        ok = true,
        matched = #matches,
        updated = updated,
        skipped = skipped,
        failed = failed,
        scanned = discovery.scanned,
        inspectionFailed = discovery.failed,
        migrated = discovery.migrated,
        warning = failed > 0 and ("Failed to update " .. failed .. " caption clips") or nil,
        detail = firstError,
        fontSwap = fontSwap
    }
end

-- Which video track holds this item. Resolve hands back a fresh proxy on each
-- call, so fall back to the unique id when identity comparison comes up empty.
local function track_index_of_item(timeline, target)
    if not (timeline and target) then return nil end
    local okId, targetId = pcall(target.GetUniqueId, target)
    local ok, count = pcall(timeline.GetTrackCount, timeline, "video")
    if not ok or type(count) ~= "number" then return nil end
    for index = count, 1, -1 do
        local listed, items = pcall(timeline.GetItemListInTrack, timeline, "video", index)
        if listed and type(items) == "table" then
            for _, item in ipairs(items) do
                if item == target then return index end
                if okId and targetId then
                    local gotId, id = pcall(item.GetUniqueId, item)
                    if gotId and id == targetId then return index end
                end
            end
        end
    end
    return nil
end

-- Export the frame under the playhead to a PNG in `exportDir` via Resolve's
-- own still export and return its path, or "" plus an error message. This
-- deliberately stays on the Resolve API: on Resolve 21.1 every route that
-- renders through the Fusion comp from a script state (Composition:Render,
-- RunScript, Execute) either does nothing or crashes Resolve.
local function extract_frame(timeline, timelineItem, exportDir)
    local function debug_log(message)
        print("[AutoSubs] " .. os.date("%H:%M:%S") .. " " .. tostring(message))
    end

    debug_log("enter")
    local clipStart, clipEnd = timelineItem:GetStart(), timelineItem:GetEnd()
    if not (clipStart and clipEnd and clipEnd > clipStart) then
        return "", "preview clip has no duration"
    end
    local frame = math.floor((clipStart + clipEnd) / 2)
    local outputPath = join_path(exportDir, "subtitle-preview-" .. frame .. ".png")

    -- Video tracks we disable, to re-enable afterwards.
    local trackStates = {}
    local ok, err = pcall(function()
        -- Hide every other video track so the still is the caption on black.
        local count = timeline:GetTrackCount("video")
        local previewTrack = track_index_of_item(timeline, timelineItem)
        if not previewTrack then
            error("could not locate the preview clip's track")
        end
        for i = 1, count do
            if i ~= previewTrack then
                local enabled = timeline:GetIsTrackEnabled("video", i)
                if enabled then
                    -- Record first so a throw still gets the track restored.
                    trackStates[i] = true
                    if not timeline:SetTrackEnable("video", i, false) then
                        error("could not disable video track " .. i)
                    end
                end
            end
        end

        -- Park the playhead mid clip so the viewer shows the settled caption.
        local frameRate = tonumber(timeline:GetSetting("timelineFrameRate"))
        local tc = timecode.timecode_from_frame_auto(frame, frameRate,
            timeline:GetSetting("timelineDropFrameTimecode"))
        if not timeline:SetCurrentTimecode(tc) then
            error("could not move the playhead to the preview clip")
        end

        -- Give the viewer a moment to draw the frame, then export it.
        bmd.wait(0.5)
        debug_log("exporting still for frame " .. frame)
        local exported = project:ExportCurrentFrameAsStill(outputPath)
        debug_log("ExportCurrentFrameAsStill returned " .. tostring(exported))
        if exported ~= true then
            error("ExportCurrentFrameAsStill returned " .. tostring(exported))
        end
        local deadline = os.time() + 10
        while not bmd.fileexists(outputPath) and os.time() < deadline do
            bmd.wait(0.1)
        end
        if not bmd.fileexists(outputPath) then
            error("still export produced no image at " .. outputPath)
        end
    end)

    -- Always restore the tracks we disabled, and say which ones would not come
    -- back: a preview that quietly leaves the user's footage hidden is worse
    -- than no preview.
    local stuck = {}
    for i, _ in pairs(trackStates) do
        local called, restored = pcall(timeline.SetTrackEnable, timeline, "video", i, true)
        if not (called and restored) then
            stuck[#stuck + 1] = i
        end
    end
    if #stuck > 0 then
        table.sort(stuck)
        local message = "could not re-enable video track(s) " .. table.concat(stuck, ", ")
            .. "; turn them back on in the timeline"
        if not ok then message = tostring(err) .. "; " .. message end
        print("[AutoSubs] extract_frame: " .. message)
        return "", message
    end
    if not ok then
        print("[AutoSubs] extract_frame failed: " .. tostring(err))
        return "", tostring(err)
    end
    return outputPath
end

-- place example subtitle on timeline with theme and export frame
-- `language` (optional): ISO code of the transcript this preview represents,
-- used for language-aware font fallback on the AutoSubs Caption macro.
function GeneratePreview(req)
    local speaker, templateName = req.speaker, req.templateName
    local presetSettings, exportDir, language = req.presetSettings, (req.exportDir or req.exportPath), req.language
    refresh_project()
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return make_error("Failed to generate preview", "No active timeline in Resolve")
    end
    local rootFolder = call_api(mediaPool, "GetRootFolder")
    if not rootFolder then
        return make_error("Failed to generate preview", MEDIA_POOL_UNAVAILABLE)
    end

    -- Resolve the template item
    local templateItem = get_template_item(rootFolder, templateName)
    if not templateItem then
        -- Template missing — trigger auto-import and retry
        ensure_default_template(rootFolder)
        templateItem = get_template_item(rootFolder, templateName)
    end
    if not templateItem then
        return make_error("Failed to generate preview",
            "Could not find subtitle template '" .. tostring(templateName) .. "' in media pool")
    end

    -- Add new track and place item at start of timeline (avoids overwriting existing clips)
    local setupOk, setupErr = pcall(function()
        timeline:AddTrack("video")
    end)
    if not setupOk then
        return make_error("Failed to generate preview", setupErr)
    end

    local trackIndex = timeline:GetTrackCount("video")
    local fps = template_frame_rate_of(templateItem, timeline)

    local appendOk, appended = pcall(function()
        return mediaPool:AppendToTimeline({ {
            mediaPoolItem = templateItem,
            startFrame = 0,
            endFrame = math.floor(fps * 5), -- 5-second preview clip
            recordFrame = timeline:GetStartFrame(),
            trackIndex = trackIndex
        } })
    end)
    -- A blocked append returns a truthy dead handle, so validate the item.
    if not appendOk or type(appended) ~= "table" or not is_live_item(appended[1]) then
        pcall(function() timeline:DeleteTrack("video", trackIndex) end)
        return make_error("Failed to generate preview",
            (not appendOk) and tostring(appended) or "AppendToTimeline did not place the clip")
    end
    local timelineItem = appended[1]

    local isAnimated = caption_style.is_autosubs_template(templateName)
    local fontSwap = nil
    if isAnimated and font_fallback then
        presetSettings, fontSwap = font_fallback.maybe_override(presetSettings, language)
    end

    local savedTimecode = nil
    pcall(function() savedTimecode = timeline:GetCurrentTimecode() end)

    local outputPath, outputErr = nil, nil
    local success, err = pcall(function()
        if timelineItem:GetFusionCompCount() > 0 then
            local comp = timelineItem:GetFusionCompByIndex(1)

            -- A still frame cannot show the animation, so the preview text is
            -- given word timings that put it mid-reveal rather than blank.
            local previewWords = {
                { word = "Subtitle", start = 0.0, ["end"] = 0.7 },
                { word = " Example", start = 0.8, ["end"] = 1.5 },
                { word = " Text",    start = 1.6, ["end"] = 2.3 },
            }

            local styleTool = caption_style.apply(comp, {
                templateName = templateName,
                text = "Subtitle Example Text",
                words = previewWords,
                start = 0,
                settings = presetSettings,
                speaker = speaker,
            })

            if fontSwap and fontSwap.to then
                pcall(function() styleTool:SetInput("Font", fontSwap.to) end)
            end

            outputPath, outputErr = extract_frame(timeline, timelineItem, exportDir)
        end
    end)

    -- Always clean up, even on failure, so the user isn't left with a stray track.
    pcall(function() timeline:DeleteClips({ timelineItem }) end)
    pcall(function() timeline:DeleteTrack("video", trackIndex) end)
    if savedTimecode then
        pcall(function() timeline:SetCurrentTimecode(savedTimecode) end)
    end

    if not success then
        return make_error("Failed to generate preview", err)
    end
    if not outputPath or outputPath == "" then
        return make_error("Failed to generate preview",
            outputErr or "Template has no Fusion composition to render from")
    end

    return { path = outputPath, fontSwap = fontSwap }
end

-- ---------------------------------------------------------------------------
-- Caption-preset editing
--
-- The AutoSubs animated caption macro exposes two helper scripts via
-- `tool:GetData("GetInputValues")` and `tool:GetData("SetInputValues")`. We
-- use these to let the user tweak preset parameters in Resolve's Fusion
-- inspector and round-trip those values back into a JSON preset we store in
-- the app.
--
-- The three endpoints below are one per user action:
--   OpenPresetEdit   -> drops a caption clip on a temp track, parks on it.
--   SavePresetEdit   -> reads tool inputs, renders the thumbnail, closes.
--   CancelPresetEdit -> closes without reading.
--
-- The clip stays on the timeline for the whole session so the user can tweak
-- its controls and watch the animation play, and so saving is read-plus-render
-- rather than append-render-delete. The page is left alone: the Inspector
-- exposes the macro's controls on the edit page, so there is no need to drag
-- the user over to Fusion. The session remembers the user's playhead position
-- and restores it when the clip comes off the timeline.
-- ---------------------------------------------------------------------------

-- Name given to the temporary track, so teardown can find it again by identity.
local PRESET_EDIT_TRACK_NAME = "AutoSubs Preview"

-- Stamped on the preview clip as a marker. The track name on its own is not
-- proof of ownership -- a user is free to have a track called "AutoSubs
-- Preview" -- and cleanup deletes whole tracks, so every clip has to say it is
-- ours before anything is removed.
local PRESET_EDIT_MARKER = "AutoSubsPresetEdit"

local function mark_preset_edit_item(timelineItem)
    pcall(function()
        timelineItem:AddMarker(0, "Blue", PRESET_EDIT_TRACK_NAME,
            "Temporary AutoSubs preset preview clip", 1, PRESET_EDIT_MARKER)
    end)
end

local function is_preset_edit_item(item)
    if not item then return false end
    local ok, marker = pcall(item.GetMarkerByCustomData, item, PRESET_EDIT_MARKER)
    return ok and type(marker) == "table" and next(marker) ~= nil
end

-- A track is ours only if everything on it is a clip we stamped. An empty
-- track cannot prove anything, so it counts as the user's.
local function preset_edit_track_is_ours(timeline, index)
    local ok, items = pcall(timeline.GetItemListInTrack, timeline, "video", index)
    if not ok or type(items) ~= "table" or #items == 0 then return false end
    for _, item in ipairs(items) do
        if not is_preset_edit_item(item) then return false end
    end
    return true
end

-- Find the preview track by name and ownership. A stored index goes stale the
-- moment the user adds or removes a video track mid session, and deleting by a
-- stale index would delete one of their tracks. A same-named track of theirs is
-- left alone, as is an empty one: a stray empty track beats deleting their work.
local function find_preset_edit_track(timeline)
    if not timeline then return nil end
    local ok, count = pcall(timeline.GetTrackCount, timeline, "video")
    if not ok or type(count) ~= "number" then return nil end
    for index = count, 1, -1 do
        local named, name = pcall(timeline.GetTrackName, timeline, "video", index)
        if named and name == PRESET_EDIT_TRACK_NAME and preset_edit_track_is_ours(timeline, index) then
            return index
        end
    end
    return nil
end

-- Look up one of the project's timelines by unique id, for when the user has
-- switched timelines mid session: cleanup still has to reach the timeline the
-- preview clip actually sits on.
local function find_timeline_by_id(timelineId)
    if not (project and timelineId) then return nil end
    local ok, count = pcall(project.GetTimelineCount, project)
    if not ok or type(count) ~= "number" then return nil end
    for index = 1, count do
        local got, candidate = pcall(project.GetTimelineByIndex, project, index)
        if got and candidate then
            local hasId, id = pcall(candidate.GetUniqueId, candidate)
            if hasId and id == timelineId then return candidate end
        end
    end
    return nil
end

-- Remove the temp clip + track, if any, and return to the edit page in case
-- the user wandered off to Fusion mid session. Safe to call without an active
-- session.
local function teardown_preset_edit_session()
    local session = presetEditSession
    presetEditSession = nil

    local timeline = project and project:GetCurrentTimeline()

    -- Only ever touch the timeline the clip was added to: after a timeline
    -- switch the current one is somewhere else entirely. Go and fetch the
    -- session's own timeline rather than giving up, which used to strand the
    -- preview clip and its track until the user came back and edited a preset
    -- there again.
    -- Closing the timeline leaves no current one at all, which is just as much
    -- a reason to go looking for the session's own as having switched to
    -- another. Only an unreadable id on a timeline we do have is taken as a
    -- match, so a Resolve build without GetUniqueId still cleans up in place.
    if session then
        local sameTimeline = timeline ~= nil
        if timeline then
            pcall(function()
                sameTimeline = timeline:GetUniqueId() == session.timelineId
            end)
        end
        if not sameTimeline then
            timeline = find_timeline_by_id(session.timelineId)
        end
    end

    -- The track has to be identified before the clip goes: once it is empty
    -- nothing on it can show it was ours.
    local trackIndex = nil
    if timeline and session and session.timelineItem then
        local candidate = track_index_of_item(timeline, session.timelineItem)
        -- Only the track our preview clip has to itself. The user may have
        -- dropped clips of their own on it mid session.
        if candidate and preset_edit_track_is_ours(timeline, candidate) then
            trackIndex = candidate
        end
        pcall(function() timeline:DeleteClips({ session.timelineItem }) end)
    elseif timeline then
        trackIndex = find_preset_edit_track(timeline)
    end

    if timeline and trackIndex then
        pcall(function() timeline:DeleteTrack("video", trackIndex) end)
    end

    if timeline and session and session.timecode then
        pcall(function() timeline:SetCurrentTimecode(session.timecode) end)
    end

    pcall(function() resolve:OpenPage("edit") end)
end

-- Remove a preview track left behind by a crash, a server restart or a hot
-- reload: the session only ever lived in memory, so nothing else would. Only
-- a track carrying nothing but our own stamped clips is touched.
local function sweep_orphan_preset_edit_track(timeline)
    if presetEditSession ~= nil then return end
    local trackIndex = find_preset_edit_track(timeline)
    if not trackIndex then return end
    print("[AutoSubs] Removing stranded '" .. PRESET_EDIT_TRACK_NAME .. "' track")
    pcall(function()
        local items = timeline:GetItemListInTrack("video", trackIndex)
        if items and #items > 0 then
            timeline:DeleteClips(items)
        end
    end)
    pcall(function() timeline:DeleteTrack("video", trackIndex) end)
end

function OpenPresetEdit(req)
    local initialSettings = req and req.initialSettings

    -- Never stack sessions. Callers finalise or cancel first.
    if presetEditSession ~= nil then
        return { error = "A caption is already open for editing" }
    end

    refresh_project()
    local timeline = project:GetCurrentTimeline()
    if not timeline then
        return { error = "No active timeline" }
    end

    sweep_orphan_preset_edit_track(timeline)

    local rootFolder = mediaPool and mediaPool:GetRootFolder()
    if not rootFolder then
        return { error = "Could not read the media pool" }
    end
    local templateItem = get_template_item(rootFolder, ANIMATED_CAPTION)
    if not templateItem then
        -- Template missing: trigger auto-import and retry.
        ensure_default_template(rootFolder)
        templateItem = get_template_item(rootFolder, ANIMATED_CAPTION)
    end
    if not templateItem then
        return { error = "Could not find '" .. ANIMATED_CAPTION .. "' template in media pool" }
    end

    -- Read before the protected block so the failure path below can restore
    -- it even when setup throws before the session exists.
    local originalTimecode = nil
    pcall(function() originalTimecode = timeline:GetCurrentTimecode() end)

    local ok, err = pcall(function()
        timeline:AddTrack("video")
        local trackIndex = timeline:GetTrackCount("video")
        pcall(timeline.SetTrackName, timeline, "video", trackIndex, PRESET_EDIT_TRACK_NAME)

        local fps = tonumber(templateItem:GetClipProperty()["FPS"]) or 24
        local position = timeline:GetStartFrame()

        local appended = mediaPool:AppendToTimeline({ {
            mediaPoolItem = templateItem,
            startFrame = 0,
            endFrame = math.floor(fps * 5), -- 5-second preview clip
            recordFrame = position,
            trackIndex = trackIndex,
        } })
        -- A blocked append returns a truthy dead handle, so validate the item.
        local timelineItem = appended and appended[1]
        if not is_live_item(timelineItem) then
            error("Failed to append preview clip to timeline")
        end

        -- Stamp it before anything else can go wrong: cleanup will not remove a
        -- track it cannot see an owned clip on.
        mark_preset_edit_item(timelineItem)

        -- Park the playhead at the middle of the preview clip: the animation
        -- has settled by then, so the caption reads as it will on export, and
        -- the clip's controls are what the Inspector shows.
        local parked = false
        local clipStart = timelineItem:GetStart()
        local clipEnd = timelineItem:GetEnd()
        local frameRate = tonumber(timeline:GetSetting("timelineFrameRate")) or fps
        if clipStart and clipEnd and clipEnd > clipStart then
            local centreFrame = math.floor((clipStart + clipEnd) / 2)
            local tc = timecode.timecode_from_frame_auto(centreFrame, frameRate,
                timeline:GetSetting("timelineDropFrameTimecode"))
            parked = timeline:SetCurrentTimecode(tc) and true or false
        end
        if not parked then
            timeline:SetCurrentTimecode(timeline:GetStartTimecode())
        end

        local comp = timelineItem:GetFusionCompByIndex(1)
        local tool = comp and comp:FindTool("AutoSubs")

        -- Seed with the preset's current look so editing starts from it
        -- rather than from the macro defaults. caption_style owns reading and
        -- writing the macro's inputs, here as everywhere else.
        if tool and initialSettings ~= nil and next(initialSettings) ~= nil then
            pcall(caption_style.write, comp, tool, initialSettings)
        end

        presetEditSession = {
            timelineId = timeline:GetUniqueId(),
            timelineItem = timelineItem,
            comp = comp,
            tool = tool,
            timecode = originalTimecode,
        }
    end)

    if not ok then
        -- Best-effort cleanup so we do not leave an orphan track. Without a
        -- session teardown does not know where the playhead was, so put it back
        -- here.
        teardown_preset_edit_session()
        if originalTimecode then
            pcall(function() timeline:SetCurrentTimecode(originalTimecode) end)
        end
        return { error = "Failed to open the caption for editing: " .. tostring(err) }
    end

    return { ok = true }
end

function SavePresetEdit(req)
    local exportDir = req and req.exportDir

    if presetEditSession == nil then
        return { error = "No caption is open for editing" }
    end

    local tool = presetEditSession.tool
    if not tool then
        teardown_preset_edit_session()
        return { error = "AutoSubs tool not found in the preview composition" }
    end

    local settings = nil
    local ok, err = pcall(function()
        settings = caption_style.read(tool)
    end)

    -- Always close, even on failure, so the user is never left with a stray
    -- preview clip. The thumbnail is rendered afterwards from a fresh clip so
    -- the still shows the saved settings on their own, with the session clip
    -- and the user's other tracks out of the picture.
    teardown_preset_edit_session()

    if not ok then
        return { error = "Failed to read the caption settings: " .. tostring(err) }
    end

    -- Render the thumbnail from the captured settings, the same path the
    -- gallery's re-render uses. Once per save, not once per tweak.
    local previewPath, previewError
    if type(exportDir) == "string" and exportDir ~= "" then
        local previewOk, result = pcall(GeneratePreview, {
            templateName = ANIMATED_CAPTION,
            presetSettings = settings,
            exportDir = exportDir,
        })
        if previewOk and type(result) == "table" and result.path then
            previewPath = result.path
        elseif previewOk and type(result) == "table" then
            previewError = (result.detail and result.detail ~= "" and result.detail)
                or result.error
                or "Preset preview render produced no image"
        else
            previewError = tostring(result)
        end
        if previewError then
            print("[AutoSubs] Preset preview render failed: " .. tostring(previewError))
        end
    end

    return { settings = settings or {}, previewPath = previewPath, previewError = previewError }
end

function CancelPresetEdit()
    teardown_preset_edit_session()
    return { ok = true }
end

-- Minimal JSON helper to avoid crashes if `json` is unavailable
local function safe_json(obj)
    if json and json.encode then
        return json.encode(obj)
    end
    if obj and obj.message ~= nil then
        local msg = tostring(obj.message):gsub('"', '\\"')
        return '{"message":"' .. msg .. '"}'
    end
    return "{}"
end


-- ---------------------------------------------------------------------------
-- Request handlers
--
-- One entry per exposed function. Each takes the decoded request table and
-- returns the response value; a handler that stops or reloads the server
-- returns a control table as its second result. Adding a function means adding
-- an entry here and a wrapper in `src/api/resolve-api.ts`, and nothing else.
-- ---------------------------------------------------------------------------
local handlers = {
    GetTimelineInfo = function() return GetTimelineInfo() end,
    GetTemplates = function(req) return GetTemplates(req and req.force) end,
    GetVersion = function() return GetVersion() end,
    GetExportProgress = function() return GetExportProgress() end,
    CancelExport = function() return CancelExport() end,
    ExportAudio = function(req) return ExportAudio(req) end,
    CheckTrackConflicts = function(req) return CheckTrackConflicts(req) end,
    BatchApplyStyle = function(req) return BatchApplyStyle(req) end,
    GeneratePreview = function(req) return GeneratePreview(req) end,
    OpenPresetEdit = function(req) return OpenPresetEdit(req) end,
    SavePresetEdit = function(req) return SavePresetEdit(req) end,
    StartPresetEdit = function(req) return OpenPresetEdit(req) end,
    CapturePresetSettings = function(req) return SavePresetEdit(req) end,
    CancelPresetEdit = function() return CancelPresetEdit() end,
    GetResolveInfo = function() return GetResolveInfo() end,
    AddMarkerAtPlayhead = function() return AddMarkerAtPlayhead() end,
    GetYoutubeChapters = function() return GetYoutubeChapters() end,
    MarkClipCuts = function(req) return MarkClipCuts(req and req.trackIndex) end,
    ClearTimelineMarkers = function(req) return ClearTimelineMarkers(req and req.color) end,
    MarkersFromSubtitles = function(req) return MarkersFromSubtitles(req and req.trackIndex) end,
    MarkSpeechGaps = function(req) return MarkSpeechGaps(req and req.minSeconds, req and req.trackIndex) end,
    FindTimelineGaps = function(req) return FindTimelineGaps(req and req.trackIndex) end,
    GetTimelineSelection = function(req) return GetTimelineSelection(req and req.spec) end,
    ApplyKeepSegments = function(req) return ApplyKeepSegments(req and req.spec) end,
    BuildStoryboard = function(req) return BuildStoryboard(req and req.spec) end,
    DuplicateCurrentTimeline = function(req) return DuplicateCurrentTimeline(req and req.spec) end,
    CreateCutTimeline = function(req) return CreateCutTimeline(req and req.spec) end,
    ClearTracks = function(req) return ClearTracks(req and req.spec) end,
    ResolveRpc = function(req)
        return ResolveRpc(req and req.objectId, req and req.method, req and req.args, req and req.argCount)
    end,
    ResetResolveRpc = function() return ResetResolveRpc() end,
    GetTimelineSnapshot = function() return ai_edit.get_timeline_snapshot() end,
    AddMarkers = function(req) return ai_edit.add_markers(req) end,
    DeleteMarkers = function(req) return ai_edit.delete_markers(req) end,
    UpdateClip = function(req) return ai_edit.update_clip(req) end,
    DeleteClips = function(req) return ai_edit.delete_clips(req) end,
    SplitClips = function(req) return ai_edit.split_clips(req) end,
    RemoveRanges = function(req) return ai_edit.remove_ranges(req) end,

    JumpToTime = function(req)
        JumpToTime(req.seconds)
        return { message = "Jumped to time" }
    end,

    AddSubtitles = function(req)
        -- Kept nested under `result` for backwards compatibility with the
        -- frontend wrapper, which unwraps both levels when checking for errors.
        return { message = "Job completed", result = AddSubtitles(req) }
    end,

    Ping = function() return { message = "Pong" } end,

    ReloadServer = function()
        return { message = "Reloading server" }, { quit = true, reload = true }
    end,

    Exit = function()
        return { message = "Server shutting down" }, { quit = true }
    end,
}

-- Standard-alphabet base64 with '=' padding, pure Lua (the sandbox has no
-- bit ops). Works on whole 3-byte groups and joins once at the end: the
-- per-bit string version this replaced took seconds on a large timeline
-- snapshot, all of it spent before the app could see the response.
local B64_DIGITS = {}
do
    local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for i = 1, 64 do
        B64_DIGITS[i - 1] = alphabet:sub(i, i)
    end
end

local function base64_encode(data)
    local D, floor = B64_DIGITS, math.floor
    local out, n = {}, #data
    local i = 1
    while i + 2 <= n do
        local a, b, c = data:byte(i, i + 2)
        local v = a * 65536 + b * 256 + c
        out[#out + 1] = D[floor(v / 262144)] .. D[floor(v / 4096) % 64] .. D[floor(v / 64) % 64] .. D[v % 64]
        i = i + 3
    end
    local rest = n - i + 1
    if rest == 2 then
        local a, b = data:byte(i, i + 1)
        local v = a * 65536 + b * 256
        out[#out + 1] = D[floor(v / 262144)] .. D[floor(v / 4096) % 64] .. D[floor(v / 64) % 64] .. "="
    elseif rest == 1 then
        local v = data:byte(i) * 65536
        out[#out + 1] = D[floor(v / 262144)] .. D[floor(v / 4096) % 64] .. "=="
    end
    return table.concat(out)
end

-- Write an ack / response for a request into Fusion.prefs. Rust polls the
-- prefs file on disk; SetPrefs + SavePrefs is the only channel back that the
-- sandboxed scripting state still allows.
local function bridge_write(key, value)
    if not fusion then
        return
    end
    -- Retry a few times: SavePrefs can transiently fail while Resolve is
    -- writing the file itself.
    for _ = 1, 5 do
        local ok = pcall(function()
            fusion:SetPrefs(key, value)
            fusion:SavePrefs()
        end)
        if ok then
            return
        end
        bmd.wait(0.05)
    end
end

local function bridge_ack(id)
    bridge_write("Global.AutoSubsBridge.Ack", id)
end

local function bridge_respond(id, body_json)
    -- Response strings can hold bytes ≥0x80 in two encodings at once: ANSI
    -- code-page bytes from Resolve's API (names, paths) and UTF-8 from values
    -- the app sent that we echo back. Neither survives as raw JSON text, so
    -- each such byte is escaped as a \uE0xx private-use marker — the payload
    -- stays pure ASCII and the app maps the markers back to bytes, decoding
    -- each string as UTF-8-or-ANSI on its side.
    local safe = body_json:gsub("[\128-\255]", function(c)
        return string.format("\\u%04x", 0xE000 + c:byte())
    end)
    bridge_write("Global.AutoSubsBridge.Response", id .. ":" .. base64_encode(safe))
end

-- Claim a mailbox request so only one loop handles it. A raced takeover or
-- double launch can briefly leave two loops polling the same mailbox; the
-- claim lives in shared (in-memory) prefs and is decided last-writer-wins
-- after a settle window, so a request is never handled twice.
local function bridge_claim(req_id, instance_id)
    if not fusion then
        return true
    end
    local key = "Global.AutoSubsBridge.Claim"
    local mine = instance_id .. ":" .. req_id
    local ok, claim = pcall(fusion.GetPrefs, fusion, key)
    if ok and type(claim) == "string" and claim ~= mine
        and claim:sub(-(#req_id + 1)) == ":" .. req_id then
        return false -- another loop already claimed this request
    end
    -- Owner is decided last-writer-wins at launch, so at most one loop holds
    -- it: that loop can take the request without the settle wait, which
    -- otherwise adds 150 ms to every call. A loop that sees a foreign Owner
    -- is about to exit and leaves the request to the owner. Only loops with
    -- no owner recorded (older launchers) fall back to the timed claim.
    local own_ok, owner = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Owner")
    if own_ok and type(owner) == "string" and owner ~= "" then
        if owner ~= instance_id then
            return false
        end
        pcall(fusion.SetPrefs, fusion, key, mine)
        return true
    end
    pcall(fusion.SetPrefs, fusion, key, mine)
    bmd.wait(0.15)
    local ok2, final = pcall(fusion.GetPrefs, fusion, key)
    return ok2 and final == mine
end

function StartServer()
    -- File-mailbox loop: the desktop app drops request.lua in the shared
    -- mailbox directory; we ack it, run the handler, and write the response
    -- into Fusion.prefs (see bridges/davinci/bridge.rs for the other side).
    local quitServer = false
    local shouldReload = false
    -- Last handled request id lives in the AUTOSUBS_LAST_REQUEST_ID global
    -- so it survives hot-reloads: a lingering request file can't be
    -- re-dispatched after ReloadServer.
    -- Handshake identity (see bootstrap.lua): a loop exits when the Stop pref
    -- changes from the value it saw at startup, so a Stop aimed at a previous
    -- loop (or a stale one persisted to disk) never kills a fresh loop.
    -- Request claims name this incarnation so a duplicate can't re-run them.
    local stop_snapshot = ""
    local last_probe = ""
    if fusion then
        local ok, s = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Stop")
        if ok and type(s) == "string" then
            stop_snapshot = s
        end
        -- Same for Probe: a token persisted to disk by an earlier SavePrefs
        -- must not be re-acked on behalf of a launcher that asked ages ago.
        local pok, p = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Probe")
        if pok and type(p) == "string" then
            last_probe = p
        end
    end
    local instance_id = rawget(_G, "AUTOSUBS_OWNER") or tostring({})
    local pref_tick = 0

    -- If a launch claimed the bridge while we were offline (e.g. during a
    -- reload), it owns it now — bow out instead of running a second loop.
    if fusion then
        local ok, owner = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Owner")
        if ok and type(owner) == "string" and owner ~= "" and owner ~= instance_id then
            return
        end
    end

    while not quitServer do
        -- Resident-bridge handshake (see bootstrap.lua): every bound fusion:
        -- call is marshaled through Resolve's UI event queue, and a queued
        -- prefs event landing during Resolve's shutdown teardown has crashed
        -- the app — so the idle loop touches prefs only ~2x/sec (10 ticks of
        -- the 50 ms wait) and writes nothing at all unless probed. In-memory
        -- prefs only — no SavePrefs, so this never touches disk.
        --   Stop: a manual launch asks us to exit (value changed from the
        --         snapshot taken above).
        --   Probe: a launcher asking "are you alive" — echo the token into
        --         ProbeAck once, when it changes.
        --   Owner: a foreign token means a launch claimed the bridge while
        --         we were busy — bow out instead of running a second loop.
        pref_tick = pref_tick + 1
        if fusion and pref_tick >= 10 then
            pref_tick = 0
            local stop_ok, stop = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Stop")
            if stop_ok and type(stop) == "string" and stop ~= "" and stop ~= stop_snapshot then
                quitServer = true
            end
            local probe_ok, probe = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Probe")
            if probe_ok and type(probe) == "string" and probe ~= "" and probe ~= last_probe then
                last_probe = probe
                pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.ProbeAck", probe)
            end
            local own_ok, owner = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Owner")
            if own_ok and type(owner) == "string" and owner ~= "" and owner ~= instance_id then
                quitServer = true
            end
        end

        if bmd.fileexists(REQUEST_FILE) then
            -- nil on a half-written/garbage file: just retry next tick
            local chunk = loadfile(REQUEST_FILE)
            local ok, req = false, nil
            if chunk then
                ok, req = pcall(chunk)
            end
            if ok and type(req) == "table" and type(req.id) == "string"
                and req.id ~= AUTOSUBS_LAST_REQUEST_ID then
                AUTOSUBS_LAST_REQUEST_ID = req.id

                -- Request ids are unix_millis * 1000 + counter, and Rust only
                -- writes a request after the previous response, so a
                -- legitimate request is always fresh — unless it queued in
                -- the mailbox behind a handler that outlived its app-side
                -- timeout, which can park it for over a minute. Anything
                -- older than 120 s is a leftover (e.g. an Exit from a
                -- previous app run): record it as handled without acking or
                -- responding.
                local req_millis = tonumber(req.id)
                local stale = req_millis ~= nil
                    and (os.time() * 1000 - math.floor(req_millis / 1000) > 120000)
                if stale then
                    print("[AutoSubs Server] Ignoring stale request id " .. req.id)
                else
                    -- Ack before claiming: the ack is the app's only liveness
                    -- signal on a short deadline, while the claim costs
                    -- several marshaled prefs round trips plus a settle wait,
                    -- so answering "seen" first keeps a congested Resolve UI
                    -- queue from looking like a dead bridge.
                    bridge_ack(req.id)

                    if bridge_claim(req.id, instance_id) then
                        local data, _, jerr = json.decode(req.body, 1, nil)

                        local body = nil
                        local success, err = pcall(function()
                            if data ~= nil then
                                local handler = handlers[data.func]
                                if handler then
                                    print("[AutoSubs Server] " .. tostring(data.func))
                                    local result, control = handler(data)
                                    body = safe_json(result == nil and { message = "OK" } or result)
                                    if control then
                                        quitServer = control.quit or quitServer
                                        shouldReload = control.reload or shouldReload
                                        -- Wind down a raced duplicate too: it
                                        -- would otherwise outlive an Exit.
                                        if control.quit and fusion then
                                            pcall(fusion.SetPrefs, fusion,
                                                "Global.AutoSubsBridge.Stop",
                                                tostring(os.time()) .. " " .. tostring({}))
                                        end
                                    end
                                else
                                    print("Invalid function name: " .. tostring(data.func))
                                    body = safe_json({ error = true, message = "Invalid function name",
                                        func = data.func })
                                end
                            else
                                body = safe_json({ message = "Invalid JSON data" })
                                print("Invalid JSON data: " .. tostring(jerr))
                            end
                        end)

                        -- Ensure we always return a body
                        if body == nil then
                            body = safe_json({ message = "OK" })
                        end

                        if not success then
                            local errMsg = tostring(err)
                            body = safe_json({
                                error = true,
                                message = "Server handler failed",
                                detail = errMsg,
                                func = data and data.func or nil
                            })
                            print("[AutoSubs Server] handler error (" ..
                                tostring(data and data.func or "<unknown>") .. "): " .. errMsg)
                        end

                        bridge_respond(req.id, body)
                    end
                    -- A lost claim means a racing loop owns the request and
                    -- will respond; the id is already marked handled either
                    -- way, so it won't be re-claimed every tick.
                end
            end
        end
        bmd.wait(0.05)
    end

    -- Leaving the loop (Stop takeover or Exit): clear the handshake keys so a
    -- waiting manual launch can proceed and nothing sees a stale heartbeat —
    -- but only while we still own the bridge, or a busy loop that lost a
    -- takeover would erase the winner's heartbeat on its way out. A reload
    -- keeps ownership: the new incarnation is the same owner, and clearing it
    -- would let a launch mid-reload claim the bridge and double the loops.
    if fusion then
        local owner_ok, owner = pcall(fusion.GetPrefs, fusion, "Global.AutoSubsBridge.Owner")
        if not owner_ok or type(owner) ~= "string" or owner == "" or owner == instance_id then
            pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.Stop", "")
            pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.Probe", "")
            pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.ProbeAck", "")
            if not shouldReload then
                pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.Heartbeat", "0")
                pcall(fusion.SetPrefs, fusion, "Global.AutoSubsBridge.Owner", "")
            end
        end
    end

    print("Shutting down AutoSubs server...")

    if shouldReload then
        print("[AutoSubs Server] Hot-reloading autosubs_core...")

        -- Always reload from the resources directory this server was started with,
        -- so a caller cannot ask us to execute Lua from an arbitrary path.
        local reload_resources_path = resources_path
        local reload_executable_path = main_app

        local new_modules_path = join_path(reload_resources_path, "modules")
        local new_core_path = join_path(new_modules_path, "autosubs_core.lua")

        -- Clear cached modules BEFORE running the new chunk so it re-requires
        -- fresh copies instead of binding the old cached modules. The running
        -- server keeps its own locals, so the fallbacks below still work.
        for _, name in ipairs({
            "autosubs_core", "resolve_env", "caption_template_version",
            "caption_style", "font_fallback", "dkjson", "version",
            "timecode", "bootstrap", "ai_edit"
        }) do
            AutoSubs_loaded[name] = nil
        end

        local new_core_chunk, load_err = loadfile(new_core_path)
        if not new_core_chunk then
            print("[AutoSubs Server] Failed to load new autosubs_core.lua:", load_err)
            print("[AutoSubs Server] Restarting previous server...")
            return StartServer()
        end

        local new_core = new_core_chunk()
        if type(new_core) ~= "table" or type(new_core.Init) ~= "function" then
            print("[AutoSubs Server] New autosubs_core.lua did not return an AutoSubs table")
            print("[AutoSubs Server] Restarting previous server...")
            return StartServer()
        end

        local ok, init_err = pcall(new_core.Init, new_core, reload_executable_path, reload_resources_path, DEV_MODE,
            false)
        if not ok then
            print("[AutoSubs Server] New server initialization failed:", init_err)
            print("[AutoSubs Server] Restarting previous server...")
            -- Drop the broken new module so a later reload can be retried.
            AutoSubs_loaded["autosubs_core"] = nil
            return StartServer()
        end

        -- Init tail-calls StartServer; if it returns we are done.
        return
    end

    print("Server shut down.")
end

local AutoSubs = {
    Init = function(self, executable_path, resources_folder, dev_mode)
        DEV_MODE = dev_mode
        main_app = executable_path
        resources_path = resources_folder
        REQUEST_FILE = join_path(AUTOSUBS_MAILBOX, "request.lua")

        json = AutoSubs_require("dkjson")
        timecode = AutoSubs_require("timecode")
        font_fallback = AutoSubs_require("font_fallback")
        return StartServer()
    end
}

return AutoSubs
