-- wl-bridge: Creator Micro 2 session keys -> focus Claude Code sessions.
-- The pad's keys send Hyper+<digit> chords (set in Work Louder Input);
-- these bindings turn them into daemon /focus calls.
local hyper = {"cmd", "alt", "ctrl", "shift"}
local BRIDGE = "http://127.0.0.1:8377"

local function post(path, body)
  hs.http.asyncPost(BRIDGE .. path, hs.json.encode(body),
    {["Content-Type"] = "application/json"}, function() end)
end

for slot = 1, 4 do
  hs.hotkey.bind(hyper, tostring(slot), function()
    post("/focus", {slot = slot})
  end)
end

-- Hyper+9: jump to the neediest session (red beats amber beats green)
hs.hotkey.bind(hyper, "9", function()
  post("/focus", {which = "neediest"})
end)

-- Hyper+0: new session — opens a tab with `claude` pre-typed
hs.hotkey.bind(hyper, "0", function()
  post("/new", {})
end)
