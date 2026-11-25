use crate::shortcuts::Action;
use serde::Serialize;

pub type TabId = u64;

pub const HOME: TabId = 0;
pub const MAX_TABS: usize = 20;
pub const MAX_LABEL_CHARS: usize = 200;
const MAX_PATH_BYTES: usize = 2048;
const MAX_TASK_ID_CHARS: usize = 128;
const HOME_PATH: &str = "/";
const HOME_LABEL: &str = "Board";
const BOARD_TITLE: &str = "Agent Board";
const TITLE_SUFFIX: &str = " · Agent Board";
const ELLIPSIS: char = '…';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Backlog,
    Schedules,
    Closed,
    Settings,
    Task,
}

impl Page {
    pub fn path_label(self) -> &'static str {
        match self {
            Self::Backlog => "Backlog",
            Self::Schedules => "Schedules",
            Self::Closed => "Closed",
            Self::Settings => "Settings",
            Self::Task => "Task",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Home,
    Page(Page),
    Stay,
}

fn is_plain_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= MAX_PATH_BYTES
        && !path.chars().any(|character| {
            character.is_control() || character.is_whitespace() || character == '\\'
        })
}

pub fn pathname(path: &str) -> &str {
    let name = path.split(['?', '#']).next().unwrap_or_default();
    match name.strip_suffix('/') {
        Some(rest) if !rest.is_empty() => rest,
        _ => name,
    }
}

fn is_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_TASK_ID_CHARS
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub fn classify(path: &str) -> Route {
    if !is_plain_path(path) {
        return Route::Stay;
    }
    let name = pathname(path);
    if name == HOME_PATH {
        return Route::Home;
    }
    if name == "/backlog" {
        return Route::Page(Page::Backlog);
    }
    if name == "/schedules" {
        return Route::Page(Page::Schedules);
    }
    if name == "/closed" {
        return Route::Page(Page::Closed);
    }
    if name == "/settings" {
        return Route::Page(Page::Settings);
    }
    if name.strip_prefix("/tasks/").is_some_and(is_task_id) {
        return Route::Page(Page::Task);
    }
    Route::Stay
}

pub fn label_from_title(title: &str) -> Option<String> {
    if title.trim() == BOARD_TITLE {
        return None;
    }
    let name = title.strip_suffix(TITLE_SUFFIX).unwrap_or(title).trim();
    if name.is_empty() {
        return None;
    }
    if name.chars().count() <= MAX_LABEL_CHARS {
        return Some(name.to_owned());
    }
    let mut label: String = name.chars().take(MAX_LABEL_CHARS - 1).collect();
    label.push(ELLIPSIS);
    Some(label)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: TabId,
    pub path: String,
    pub label: String,
    pub loaded: bool,
    fallback_label: &'static str,
}

impl Tab {
    fn home() -> Self {
        Self {
            id: HOME,
            path: HOME_PATH.to_owned(),
            label: HOME_LABEL.to_owned(),
            loaded: true,
            fallback_label: HOME_LABEL,
        }
    }

    fn page(id: TabId, path: &str, page: Page, loaded: bool) -> Self {
        Self {
            id,
            path: path.to_owned(),
            label: page.path_label().to_owned(),
            loaded,
            fallback_label: page.path_label(),
        }
    }

    fn identity(&self) -> &str {
        pathname(&self.path)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    CreateWebview { tab: TabId, path: String },
    Navigate { tab: TabId, path: String },
    Show(TabId),
    Hide(TabId),
    Close(TabId),
    UpdateBar,
    WriteTabFile,
    LimitReached,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TabView {
    pub id: TabId,
    pub label: String,
    pub home: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PaneView {
    pub selected: TabId,
    pub tabs: Vec<TabView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Pane {
    tabs: Vec<Tab>,
    selected: TabId,
}

impl Pane {
    fn new() -> Self {
        Self {
            tabs: vec![Tab::home()],
            selected: HOME,
        }
    }

    fn select(&mut self, tab: TabId) -> Vec<Effect> {
        if tab == self.selected {
            return Vec::new();
        }
        let Some(target) = self.tabs.iter_mut().find(|candidate| candidate.id == tab) else {
            return Vec::new();
        };
        let mut effects = Vec::new();
        if !target.loaded {
            target.loaded = true;
            effects.push(Effect::CreateWebview {
                tab,
                path: target.path.clone(),
            });
        }
        effects.extend([
            Effect::Hide(self.selected),
            Effect::Show(tab),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]);
        self.selected = tab;
        effects
    }

    fn close(&mut self, tab: TabId) -> Vec<Effect> {
        let Some(index) = self.tabs.iter().position(|candidate| candidate.id == tab) else {
            return Vec::new();
        };
        if tab == HOME {
            return Vec::new();
        }
        let closed = self.tabs.remove(index);
        let mut effects = Vec::new();
        if closed.loaded {
            effects.push(Effect::Close(tab));
        }
        if self.selected == tab {
            let neighbour = index.min(self.tabs.len() - 1);
            let next = &mut self.tabs[neighbour];
            if !next.loaded {
                next.loaded = true;
                effects.push(Effect::CreateWebview {
                    tab: next.id,
                    path: next.path.clone(),
                });
            }
            self.selected = next.id;
            effects.push(Effect::Show(next.id));
        }
        effects.extend([Effect::UpdateBar, Effect::WriteTabFile]);
        effects
    }

    fn close_to_home(&mut self, tab: TabId) -> Vec<Effect> {
        let previous = self.selected;
        self.tabs.retain(|candidate| candidate.id != tab);
        self.selected = HOME;
        let mut effects = vec![Effect::Close(tab)];
        if previous != HOME && previous != tab {
            effects.push(Effect::Hide(previous));
        }
        if previous != HOME {
            let home = &mut self.tabs[0];
            if !home.loaded {
                home.loaded = true;
                effects.push(Effect::CreateWebview {
                    tab: HOME,
                    path: home.path.clone(),
                });
            }
            effects.push(Effect::Show(HOME));
        }
        effects.extend([Effect::UpdateBar, Effect::WriteTabFile]);
        effects
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tabs {
    panes: Vec<Pane>,
    focused: usize,
    next_id: TabId,
}

impl Default for Tabs {
    fn default() -> Self {
        Self::new()
    }
}

impl Tabs {
    pub fn new() -> Self {
        Self {
            panes: vec![Pane::new()],
            focused: 0,
            next_id: HOME + 1,
        }
    }

    pub fn restore<'a>(paths: impl IntoIterator<Item = &'a str>, selected: usize) -> Self {
        let mut tabs = Self::new();
        let mut chosen = None;
        for (index, path) in paths.into_iter().enumerate() {
            let Route::Page(page) = classify(path) else {
                continue;
            };
            let pane = &mut tabs.panes[0];
            let duplicate = pane.tabs.iter().any(|tab| tab.identity() == pathname(path));
            if duplicate || pane.tabs.len() > MAX_TABS {
                continue;
            }
            let id = tabs.next_id;
            tabs.next_id += 1;
            tabs.panes[0].tabs.push(Tab::page(id, path, page, false));
            if index + 1 == selected {
                chosen = Some(id);
            }
        }
        let pane = &mut tabs.panes[0];
        if let Some(id) = chosen {
            pane.selected = id;
            pane.tabs[0].loaded = false;
            if let Some(tab) = pane.tabs.iter_mut().find(|tab| tab.id == id) {
                tab.loaded = true;
            }
        }
        tabs
    }

    pub fn start(&self) -> Vec<Effect> {
        let pane = self.pane();
        let Some(selected) = pane.tabs.iter().find(|tab| tab.id == pane.selected) else {
            return Vec::new();
        };
        vec![
            Effect::CreateWebview {
                tab: selected.id,
                path: selected.path.clone(),
            },
            Effect::Show(selected.id),
            Effect::UpdateBar,
        ]
    }

    pub fn saved(&self) -> (Vec<&str>, usize) {
        let pane = self.pane();
        let paths = pane
            .tabs
            .iter()
            .skip(1)
            .map(|tab| tab.path.as_str())
            .collect();
        let selected = pane
            .tabs
            .iter()
            .position(|tab| tab.id == pane.selected)
            .unwrap_or(0);
        (paths, selected)
    }

    pub fn selected(&self) -> TabId {
        self.pane().selected
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.pane().tabs
    }

    pub fn view(&self) -> Vec<PaneView> {
        self.panes
            .iter()
            .map(|pane| PaneView {
                selected: pane.selected,
                tabs: pane
                    .tabs
                    .iter()
                    .map(|tab| TabView {
                        id: tab.id,
                        label: tab.label.clone(),
                        home: tab.id == HOME,
                    })
                    .collect(),
            })
            .collect()
    }

    pub fn open(&mut self, path: &str) -> Vec<Effect> {
        match classify(path) {
            Route::Home => self.select(HOME),
            Route::Page(page) => self.open_page(path, page),
            Route::Stay => Vec::new(),
        }
    }

    fn open_page(&mut self, path: &str, page: Page) -> Vec<Effect> {
        let pane = self.pane();
        if let Some(existing) = pane
            .tabs
            .iter()
            .find(|tab| tab.identity() == pathname(path))
        {
            let id = existing.id;
            return self.select(id);
        }
        if pane.tabs.len() > MAX_TABS {
            return vec![Effect::LimitReached];
        }
        let id = self.next_id;
        self.next_id += 1;
        let pane = self.pane_mut();
        pane.tabs.push(Tab::page(id, path, page, true));
        let previous = std::mem::replace(&mut pane.selected, id);
        vec![
            Effect::CreateWebview {
                tab: id,
                path: path.to_owned(),
            },
            Effect::Hide(previous),
            Effect::Show(id),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    }

    pub fn route(&mut self, tab: TabId, path: &str) -> Vec<Effect> {
        let route = classify(path);
        if tab == HOME {
            return match route {
                Route::Page(_) => {
                    let mut effects = vec![Effect::Navigate {
                        tab: HOME,
                        path: HOME_PATH.to_owned(),
                    }];
                    effects.extend(self.open(path));
                    effects
                }
                Route::Home | Route::Stay => Vec::new(),
            };
        }
        let pane = self.pane_mut();
        let Some(current) = pane.tabs.iter_mut().find(|candidate| candidate.id == tab) else {
            return Vec::new();
        };
        match route {
            Route::Home if tab == pane.selected => pane.close_to_home(tab),
            Route::Home => pane.close(tab),
            Route::Page(page) if current.path != path => {
                let moved = current.identity() != pathname(path);
                current.path = path.to_owned();
                current.fallback_label = page.path_label();
                if !moved {
                    return vec![Effect::WriteTabFile];
                }
                current.fallback_label.clone_into(&mut current.label);
                vec![Effect::UpdateBar, Effect::WriteTabFile]
            }
            Route::Page(_) | Route::Stay => Vec::new(),
        }
    }

    pub fn title(&mut self, tab: TabId, title: &str) -> Vec<Effect> {
        if tab == HOME {
            return Vec::new();
        }
        let Some(current) = self
            .pane_mut()
            .tabs
            .iter_mut()
            .find(|candidate| candidate.id == tab)
        else {
            return Vec::new();
        };
        let label = label_from_title(title).unwrap_or_else(|| current.fallback_label.to_owned());
        if current.label == label {
            return Vec::new();
        }
        current.label = label;
        vec![Effect::UpdateBar]
    }

    pub fn select(&mut self, tab: TabId) -> Vec<Effect> {
        self.pane_mut().select(tab)
    }

    pub fn close(&mut self, tab: TabId) -> Vec<Effect> {
        self.pane_mut().close(tab)
    }

    pub fn middle_close(&mut self, tab: TabId) -> Vec<Effect> {
        self.close(tab)
    }

    pub fn close_selected(&mut self) -> Vec<Effect> {
        let selected = self.selected();
        self.close(selected)
    }

    pub fn select_nth(&mut self, position: u8) -> Vec<Effect> {
        let Some(index) = usize::from(position).checked_sub(1) else {
            return Vec::new();
        };
        let Some(tab) = self.pane().tabs.get(index) else {
            return Vec::new();
        };
        let id = tab.id;
        self.select(id)
    }

    pub fn cycle(&mut self, next: bool) -> Vec<Effect> {
        let pane = self.pane();
        let count = pane.tabs.len();
        let current = pane
            .tabs
            .iter()
            .position(|tab| tab.id == pane.selected)
            .unwrap_or(0);
        let target = if next {
            (current + 1) % count
        } else {
            (current + count - 1) % count
        };
        let id = pane.tabs[target].id;
        self.select(id)
    }

    pub fn apply(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::CloseTab => self.close_selected(),
            Action::Select(position) => self.select_nth(position),
            Action::Next => self.cycle(true),
            Action::Previous => self.cycle(false),
        }
    }

    fn pane(&self) -> &Pane {
        &self.panes[self.focused]
    }

    fn pane_mut(&mut self) -> &mut Pane {
        &mut self.panes[self.focused]
    }
}
