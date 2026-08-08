-- youtube-mpv-shim in-player menu
-- enter opens, arrows navigate, enter selects, left goes back, esc closes.
-- rendered through mpv's native osd like jellyfin-mpv-shim's menu, so it
-- follows the user's osd font; while open, osd-back-color / osd-font-size /
-- osd-border-style are overridden and restored on close. theme via
-- script-opts/ytshim_menu.conf: back_color, font_size, max_visible_items.
-- the daemon pushes per-video data and toggle states via script-messages.

local utils = require 'mp.utils'
local msg = require 'mp.msg'
local options = require 'mp.options'

local opts = {
  back_color = '#CC333333',
  font_size = 40,
  max_visible_items = 10,
}
options.read_options(opts, 'ytshim_menu')

local menu_stack = {}
local related = nil -- nil = not loaded yet, {} = loaded but empty
local captions = nil -- auto caption tracks pushed by the daemon, same nil/{} convention
local added_caption_urls = {} -- urls already sub-added this file
-- remembered subtitle choice, kept across videos and persisted by the
-- daemon; nil = off, otherwise { lang, auto }
local caption_pref = nil
local subs_restored = false -- restore runs once per file
local saved_osd = nil

local OSD_DURATION = '2147483647'

local SPEEDS = { 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0 }

local QUALITIES = {
  { label = 'Best available', fmt = 'bestvideo+bestaudio/best' },
  { label = '2160p (4K)', fmt = 'bestvideo[height<=2160]+bestaudio/best[height<=2160]' },
  { label = '1440p', fmt = 'bestvideo[height<=1440]+bestaudio/best[height<=1440]' },
  { label = '1080p', fmt = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
  { label = '720p', fmt = 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
  { label = '480p', fmt = 'bestvideo[height<=480]+bestaudio/best[height<=480]' },
  { label = '360p', fmt = 'bestvideo[height<=360]+bestaudio/best[height<=360]' },
}

-- stable volume state pushed by the daemon; the audio filter itself comes
-- and goes per video, so it cannot be used as the state
local stable_volume = false

-- sponsorblock state and per-video segments, both pushed by the daemon
local sponsorblock = false
local sb_segments = {}
local sb_last_skip_end = nil   -- end of the segment we last auto-skipped (anti-fight guard)
local sb_prompt_seg = nil      -- prompt segment currently on screen
local sb_prev_pos = nil        -- last observed time-pos (for forward-seek detection)
local sb_seek_from = nil       -- position captured at the 'seek' event

-- derive the quality label from the live ytdl-format property; it may have
-- been restored from a previous session by the daemon
local function quality_label()
  local fmt = mp.get_property('ytdl-format')
  if not fmt or fmt == '' then
    return 'Default'
  end
  for _, q in ipairs(QUALITIES) do
    if q.fmt == fmt then
      return q.label
    end
  end
  return 'Custom'
end

-- ---------------------------------------------------------------- osd settings

local function apply_menu_osd()
  if saved_osd then
    return
  end
  saved_osd = {
    back_color = mp.get_property('osd-back-color'),
    font_size = mp.get_property('osd-font-size'),
  }
  local ok, border_style = pcall(mp.get_property, 'osd-border-style')
  saved_osd.border_style = ok and border_style or nil

  mp.set_property('osd-back-color', opts.back_color)
  mp.set_property('osd-font-size', opts.font_size)
  -- required for osd-back-color to render as a filled box (mpv >= 0.35)
  pcall(mp.set_property, 'osd-border-style', 'background-box')
end

local function restore_osd()
  if not saved_osd then
    return
  end
  mp.set_property('osd-back-color', saved_osd.back_color)
  mp.set_property('osd-font-size', saved_osd.font_size)
  if saved_osd.border_style then
    pcall(mp.set_property, 'osd-border-style', saved_osd.border_style)
  end
  saved_osd = nil
end

-- ---------------------------------------------------------------- rendering

local function render()
  local menu = menu_stack[#menu_stack]
  if not menu then
    mp.commandv('show-text', '', '0', '1')
    restore_osd()
    return
  end

  apply_menu_osd()

  local text = menu.title
  local count = #menu.items

  local first = 1
  if count > opts.max_visible_items then
    first = math.max(1, math.min(menu.sel - math.floor(opts.max_visible_items / 2),
      count - opts.max_visible_items + 1))
  end
  local last = math.min(count, first + opts.max_visible_items - 1)

  if first > 1 then
    text = text .. '\n   ...'
  end
  for i = first, last do
    local item = menu.items[i]
    local label = item.label
    if item.checked then
      label = label .. ' (*)'
    end
    if item.hint then
      label = label .. ' - ' .. item.hint
    end
    if i == menu.sel then
      text = text .. '\n   **' .. label .. '**'
    else
      text = text .. '\n   ' .. label
    end
  end
  if last < count then
    text = text .. '\n   ...'
  end

  mp.commandv('show-text', text, OSD_DURATION, '1')
end

-- ---------------------------------------------------------------- actions

local function close_menu()
  menu_stack = {}
  remove_nav_bindings()
  render()
end

local function push_menu(menu)
  menu.sel = menu.sel or 1
  menu_stack[#menu_stack + 1] = menu
  render()
end

local function reload_with_format(fmt, label)
  local pos = mp.get_property_number('time-pos') or 0
  local path = mp.get_property('path')
  if not path then
    return
  end
  mp.set_property('ytdl-format', fmt)
  local start = string.format('start=%d', math.floor(pos))
  local ok = pcall(function()
    mp.commandv('loadfile', path, 'replace', '-1', start)
  end)
  if not ok then
    mp.commandv('loadfile', path, 'replace', start) -- mpv < 0.38
  end
  mp.osd_message('Quality: ' .. label, 2)
end

-- ---------------------------------------------------------------- submenus

local function build_track_menu(track_type, prop, title, on_select)
  local items = {}
  local active = mp.get_property_native(prop)
  items[#items + 1] = {
    label = 'None',
    checked = (active == false or active == nil),
    action = function()
      mp.set_property(prop, 'no')
      if on_select then on_select(nil) end
      close_menu()
    end
  }
  for _, track in ipairs(mp.get_property_native('track-list') or {}) do
    if track.type == track_type then
      local label = string.format('%d: %s', track.id,
        track.title or track.lang or 'unknown')
      if track.title and track.lang then
        label = label .. ' (' .. track.lang .. ')'
      end
      items[#items + 1] = {
        label = label,
        checked = track.selected,
        action = function()
          mp.set_property_native(prop, track.id)
          if on_select then on_select(track) end
          close_menu()
        end
      }
    end
  end
  if #items == 1 and not mp.get_property('path') then
    items = { { label = '(no file playing)' } }
  end
  return { title = title, items = items }
end

local function set_caption_pref(pref, value)
  caption_pref = pref
  mp.commandv('script-message', 'ytshim', 'captions-pref', value)
end

-- remember menu choices so the next video keeps them; tracks without a
-- language cannot be matched later, so those leave the pref alone
local function record_sub_choice(track)
  if track == nil then
    set_caption_pref(nil, 'off')
  elseif track.lang then
    local auto = added_caption_urls[track['external-filename'] or ''] ~= nil
    set_caption_pref({ lang = track.lang, auto = auto }, (auto and 'auto:' or '') .. track.lang)
  end
end

local function lang_primary(lang)
  return string.lower(string.match(lang or '', '^[^-]+') or '')
end

-- subtitle variant of the track menu; auto captions are sub-added as
-- unselected tracks the moment the daemon pushes them, so they show up
-- here and in mpv's own ui as normal tracks
local function build_sub_menu()
  local menu = build_track_menu('sub', 'sid', 'Subtitles', record_sub_choice)
  menu.is_sub_tracks = true
  if captions == nil and mp.get_property('path') then
    menu.items[#menu.items + 1] = { label = 'Loading auto captions...' }
    mp.commandv('script-message', 'ytshim', 'request-captions')
  end
  return menu
end

-- load caption tracks into mpv without selecting them
local function add_caption_tracks()
  for _, c in ipairs(captions or {}) do
    if not added_caption_urls[c.url] then
      if mp.commandv('sub-add', c.url, 'auto', c.label, c.lang) then
        added_caption_urls[c.url] = true
      else
        msg.warn('failed to add caption track: ' .. c.label)
      end
    end
  end
end

-- reapply the remembered subtitle choice on a new video: native track on a
-- language match, auto captions otherwise; keeping subs on beats matching
-- the language exactly, so an off-language caption track is the last resort
local function restore_subs()
  if subs_restored or not caption_pref then
    return
  end
  subs_restored = true
  local sid = mp.get_property_native('sid')
  if sid ~= false and sid ~= nil then
    return -- something is already selected
  end
  local want = lang_primary(caption_pref.lang)
  local native, caption_match, caption_any
  for _, track in ipairs(mp.get_property_native('track-list') or {}) do
    if track.type == 'sub' then
      local is_caption = added_caption_urls[track['external-filename'] or ''] ~= nil
      local match = lang_primary(track.lang) == want
      if is_caption then
        caption_any = caption_any or track.id
        if match then
          caption_match = caption_match or track.id
        end
      elseif match then
        native = native or track.id
      end
    end
  end
  local pick
  if caption_pref.auto then
    pick = caption_match or native or caption_any
  else
    pick = native or caption_match or caption_any
  end
  if pick then
    mp.set_property_native('sid', pick)
  end
end

local function build_speed_menu()
  local current = mp.get_property_number('speed') or 1
  local items = {}
  for _, s in ipairs(SPEEDS) do
    items[#items + 1] = {
      label = string.format('%.2fx', s),
      checked = math.abs(current - s) < 0.01,
      action = function()
        mp.set_property_number('speed', s)
        mp.osd_message(string.format('Speed: %.2fx', s), 1)
        close_menu()
      end
    }
  end
  return { title = 'Playback speed', items = items }
end

local function build_quality_menu()
  local items = {}
  local active = quality_label()
  for _, q in ipairs(QUALITIES) do
    items[#items + 1] = {
      label = q.label,
      checked = (active == q.label),
      action = function()
        close_menu()
        reload_with_format(q.fmt, q.label)
      end
    }
  end
  return { title = 'Quality (reloads video)', items = items }
end

local function build_related_menu()
  local items = {}
  if related == nil then
    items[#items + 1] = { label = 'Loading recommendations...' }
    mp.commandv('script-message', 'ytshim', 'request-related')
  elseif #related == 0 then
    items[#items + 1] = { label = '(no recommendations available)' }
  else
    for _, video in ipairs(related) do
      local label = video.title or video.id
      items[#items + 1] = {
        label = label,
        hint = video.author,
        action = function()
          close_menu()
          mp.osd_message('Loading: ' .. label, 3)
          mp.commandv('script-message', 'ytshim', 'play', video.id)
        end
      }
    end
  end
  return { title = 'Up Next - Recommendations', items = items, is_related = true }
end

-- ---------------------------------------------------------------- sponsorblock

local SB_CATEGORY_NAMES = {
  sponsor = 'sponsor',
  selfpromo = 'self-promo',
  interaction = 'interaction reminder',
  intro = 'intro',
  outro = 'outro',
  preview = 'preview/recap',
  music_offtopic = 'non-music section',
  filler = 'filler',
}

local sb_ignore_seek = false

local function sb_category_name(category)
  return SB_CATEGORY_NAMES[category] or category
end

local function sb_find(pos, mode, margin)
  for _, seg in ipairs(sb_segments) do
    if seg.mode == mode and pos >= seg.start and pos < seg.end_ - (margin or 0.1) then
      return seg
    end
  end
  return nil
end

local function sb_skip_to(seg, silent)
  sb_ignore_seek = true
  mp.commandv('seek', seg.end_, 'absolute')
  if not silent then
    mp.osd_message('SponsorBlock: skipped ' .. sb_category_name(seg.category), 2)
  end
end

local function sb_clear_prompt()
  if sb_prompt_seg and #menu_stack == 0 then
    mp.commandv('show-text', '', '0', '1')
  end
  sb_prompt_seg = nil
end

local function sb_on_time(_, pos)
  sb_prev_pos = pos
  if pos == nil or not sponsorblock or #sb_segments == 0 then
    return
  end

  -- pending user seek: forward seek inside a prompt segment skips to its end
  if sb_seek_from ~= nil then
    local from = sb_seek_from
    sb_seek_from = nil
    local seg = sb_find(from, 'prompt', 0)
    if seg and pos > from and pos >= seg.start and pos < seg.end_ then
      sb_clear_prompt()
      sb_skip_to(seg)
      return
    end
    -- user seek landing outside all auto-skip segments re-arms the skip guard
    if not sb_find(pos, 'skip', 0) then
      sb_last_skip_end = nil
    end
  end

  -- auto-skip
  local skip_seg = sb_find(pos, 'skip')
  if skip_seg and sb_last_skip_end ~= skip_seg.end_ then
    sb_last_skip_end = skip_seg.end_
    sb_clear_prompt()
    sb_skip_to(skip_seg)
    return
  end

  -- seek-to-skip prompt
  local prompt_seg = sb_find(pos, 'prompt', 0.5)
  if prompt_seg then
    if sb_prompt_seg ~= prompt_seg and #menu_stack == 0 then
      sb_prompt_seg = prompt_seg
      local duration = math.min((prompt_seg.end_ - pos), 8) * 1000
      mp.commandv('show-text',
        'seek forward to skip ' .. sb_category_name(prompt_seg.category),
        string.format('%d', duration), '1')
    end
  elseif sb_prompt_seg then
    sb_clear_prompt()
  end
end

mp.observe_property('time-pos', 'number', sb_on_time)

mp.register_event('seek', function()
  if sb_ignore_seek then
    sb_ignore_seek = false
    return
  end
  sb_seek_from = sb_prev_pos
end)

local function set_stable_volume(enabled)
  return function()
    stable_volume = enabled
    close_menu()
    mp.commandv('script-message', 'ytshim', 'stable-volume', enabled and 'on' or 'off')
    mp.osd_message('Stable Volume: ' .. (enabled and 'on' or 'off'), 2)
  end
end

function build_stable_volume_menu()
  return {
    title = 'Stable Volume',
    is_stable_volume = true,
    items = {
      { label = 'Yes', checked = stable_volume, action = set_stable_volume(true) },
      { label = 'No', checked = not stable_volume, action = set_stable_volume(false) },
    }
  }
end

local function set_sponsorblock(enabled)
  return function()
    sponsorblock = enabled
    close_menu()
    mp.commandv('script-message', 'ytshim', 'sponsorblock', enabled and 'on' or 'off')
    mp.osd_message('SponsorBlock: ' .. (enabled and 'on' or 'off'), 2)
  end
end

function build_sponsorblock_menu()
  return {
    title = 'SponsorBlock',
    is_sponsorblock = true,
    items = {
      { label = 'Yes', checked = sponsorblock, action = set_sponsorblock(true) },
      { label = 'No', checked = not sponsorblock, action = set_sponsorblock(false) },
    }
  }
end

local function build_main_menu()
  return {
    title = 'youtube-mpv-shim',
    items = {
      { label = 'Up Next / Recommendations', submenu = build_related_menu },
      { label = 'Subtitles', submenu = build_sub_menu },
      { label = 'Audio Track', submenu = function() return build_track_menu('audio', 'aid', 'Audio Track') end },
      { label = 'Playback Speed', submenu = build_speed_menu },
      { label = 'Quality', hint = quality_label(), submenu = build_quality_menu },
      {
        label = 'Stable Volume',
        hint = stable_volume and 'On' or 'Off',
        submenu = build_stable_volume_menu
      },
      {
        label = 'SponsorBlock',
        hint = sponsorblock and 'On' or 'Off',
        submenu = build_sponsorblock_menu
      },
      { label = 'Close Menu', action = close_menu },
    }
  }
end

-- ---------------------------------------------------------------- input

local function nav(delta)
  local menu = menu_stack[#menu_stack]
  if not menu or #menu.items == 0 then
    return
  end
  menu.sel = ((menu.sel - 1 + delta) % #menu.items) + 1
  render()
end

local function activate()
  local menu = menu_stack[#menu_stack]
  if not menu then
    return
  end
  local item = menu.items[menu.sel]
  if not item then
    return
  end
  if item.submenu then
    push_menu(item.submenu())
  elseif item.action then
    item.action()
  end
end

local function back()
  if #menu_stack > 1 then
    menu_stack[#menu_stack] = nil
    render()
  else
    close_menu()
  end
end

local NAV_BINDINGS = {
  { 'UP', 'ytshim-up', function() nav(-1) end, { repeatable = true } },
  { 'DOWN', 'ytshim-down', function() nav(1) end, { repeatable = true } },
  { 'LEFT', 'ytshim-left', back, {} },
  { 'RIGHT', 'ytshim-right', activate, {} },
  { 'ESC', 'ytshim-esc', close_menu, {} },
}

function remove_nav_bindings()
  for _, b in ipairs(NAV_BINDINGS) do
    mp.remove_key_binding(b[2])
  end
end

local function add_nav_bindings()
  for _, b in ipairs(NAV_BINDINGS) do
    mp.add_forced_key_binding(b[1], b[2], b[3], b[4])
  end
end

local function on_enter()
  if #menu_stack == 0 then
    add_nav_bindings()
    push_menu(build_main_menu())
  else
    activate()
  end
end

mp.add_forced_key_binding('ENTER', 'ytshim-menu', on_enter)
mp.add_forced_key_binding('KP_ENTER', 'ytshim-menu-kp', on_enter)

-- ---------------------------------------------------------------- daemon messages

mp.register_script_message('ytshim-related', function(json)
  local parsed = utils.parse_json(json or '')
  related = (parsed and parsed.videos) or {}
  msg.info('received ' .. #related .. ' recommendations')
  local menu = menu_stack[#menu_stack]
  if menu and menu.is_related then
    local sel = menu.sel
    menu_stack[#menu_stack] = build_related_menu()
    menu_stack[#menu_stack].sel = math.min(sel, math.max(1, #menu_stack[#menu_stack].items))
    render()
  end
end)

mp.register_script_message('ytshim-captions', function(json)
  local parsed = utils.parse_json(json or '')
  captions = (parsed and parsed.tracks) or {}
  msg.info('received ' .. #captions .. ' auto caption track(s)')
  add_caption_tracks()
  restore_subs()
  local menu = menu_stack[#menu_stack]
  if menu and menu.is_sub_tracks then
    local sel = menu.sel
    menu_stack[#menu_stack] = build_sub_menu()
    menu_stack[#menu_stack].sel = math.min(sel, math.max(1, #menu_stack[#menu_stack].items))
    render()
  end
end)

-- remembered subtitle choice arrives on every spawn like the toggles
mp.register_script_message('ytshim-captions-pref', function(value)
  if not value or value == '' or value == 'off' then
    caption_pref = nil
    return
  end
  local auto_lang = string.match(value, '^auto:(.+)$')
  caption_pref = { lang = auto_lang or value, auto = auto_lang ~= nil }
end)

-- toggle states arrive on every spawn so they survive respawns and restarts
mp.register_script_message('ytshim-stable-volume', function(value)
  stable_volume = (value == 'on')
  local menu = menu_stack[#menu_stack]
  if menu and menu.is_stable_volume then
    local sel = menu.sel
    menu_stack[#menu_stack] = build_stable_volume_menu()
    menu_stack[#menu_stack].sel = sel
    render()
  end
end)

mp.register_script_message('ytshim-sponsorblock', function(value)
  sponsorblock = (value == 'on')
  local menu = menu_stack[#menu_stack]
  if menu and menu.is_sponsorblock then
    local sel = menu.sel
    menu_stack[#menu_stack] = build_sponsorblock_menu()
    menu_stack[#menu_stack].sel = sel
    render()
  end
end)

mp.register_script_message('ytshim-sponsorblock-segments', function(json)
  local parsed = utils.parse_json(json or '')
  sb_segments = {}
  for _, seg in ipairs((parsed and parsed.segments) or {}) do
    -- end is a lua keyword, so segments are stored with end_
    sb_segments[#sb_segments + 1] = {
      start = seg.start, end_ = seg['end'], category = seg.category, mode = seg.mode
    }
  end
  msg.info('sponsorblock: ' .. #sb_segments .. ' segment(s)')
end)

-- new video started, stale per-video data no longer applies
mp.register_event('start-file', function()
  related = nil
  captions = nil
  added_caption_urls = {}
  subs_restored = false
  sb_segments = {}
  sb_prompt_seg = nil
  sb_last_skip_end = nil
  sb_seek_from = nil
  sb_prev_pos = nil
end)
