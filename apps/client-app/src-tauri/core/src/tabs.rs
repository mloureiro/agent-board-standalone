use crate::shortcuts::Action;
use serde::Serialize;

pub type TabId = u64;

pub const HOME: TabId = 0;
pub const MAX_TABS: usize = 20;
pub const MAX_LABEL_CHARS: usize = 200;
pub const MAX_PANES: usize = 4;
pub const MIN_PANE_FRACTION: f64 = 0.1;
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
    Layout,
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

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LayoutView {
    pub panes: Vec<PaneView>,
    pub focused: usize,
    pub split: Vec<f64>,
}

impl LayoutView {
    pub fn pane_of(&self, tab: TabId) -> Option<usize> {
        self.panes
            .iter()
            .position(|pane| pane.tabs.iter().any(|candidate| candidate.id == tab))
    }
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

    fn holding(tab: Tab) -> Self {
        Self {
            selected: tab.id,
            tabs: vec![tab],
        }
    }

    fn index_of(&self, tab: TabId) -> Option<usize> {
        self.tabs.iter().position(|candidate| candidate.id == tab)
    }

    fn take_selected_neighbour(&mut self, index: usize) -> Vec<Effect> {
        let neighbour = index.min(self.tabs.len() - 1);
        let next = &mut self.tabs[neighbour];
        let mut effects = Vec::new();
        if !next.loaded {
            next.loaded = true;
            effects.push(Effect::CreateWebview {
                tab: next.id,
                path: next.path.clone(),
            });
        }
        self.selected = next.id;
        effects.push(Effect::Show(next.id));
        effects
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
            effects.extend(self.take_selected_neighbour(index));
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

const EDGE_TOLERANCE: f64 = 1e-9;

pub struct PaneSpec<'a> {
    pub paths: Vec<&'a str>,
    pub selected: usize,
}

pub struct SavedPane<'a> {
    pub paths: Vec<&'a str>,
    pub selected: usize,
}

pub struct Saved<'a> {
    pub panes: Vec<SavedPane<'a>>,
    pub split: &'a [f64],
    pub focused: usize,
}

pub fn equal_split(panes: usize) -> Vec<f64> {
    (1..panes)
        .map(|index| index as f64 / panes as f64)
        .collect()
}

pub fn valid_split(split: &[f64], panes: usize) -> bool {
    if split.len() + 1 != panes {
        return false;
    }
    let mut previous = 0.0;
    for &edge in split {
        if !edge.is_finite() || edge - previous < MIN_PANE_FRACTION - EDGE_TOLERANCE {
            return false;
        }
        previous = edge;
    }
    1.0 - previous >= MIN_PANE_FRACTION - EDGE_TOLERANCE
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tabs {
    panes: Vec<Pane>,
    focused: usize,
    split: Vec<f64>,
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
            split: Vec::new(),
            next_id: HOME + 1,
        }
    }

    pub fn restore<'a>(paths: impl IntoIterator<Item = &'a str>, selected: usize) -> Self {
        let spec = PaneSpec {
            paths: paths.into_iter().collect(),
            selected,
        };
        Self::restore_panes(&[spec], None, 0)
    }

    pub fn restore_panes(specs: &[PaneSpec<'_>], split: Option<&[f64]>, focused: usize) -> Self {
        let mut tabs = Self::new();
        let mut kept = vec![0];
        for (position, spec) in specs.iter().enumerate() {
            if position > 0 && tabs.panes.len() >= MAX_PANES {
                continue;
            }
            let mut local: Vec<Tab> = Vec::new();
            let mut chosen = None;
            for (index, path) in spec.paths.iter().enumerate() {
                let Route::Page(page) = classify(path) else {
                    continue;
                };
                let duplicate = tabs
                    .panes
                    .iter()
                    .flat_map(|pane| &pane.tabs)
                    .chain(&local)
                    .any(|tab| tab.identity() == pathname(path));
                if duplicate || tabs.count() + local.len() > MAX_TABS {
                    continue;
                }
                let id = tabs.next_id;
                tabs.next_id += 1;
                local.push(Tab::page(id, path, page, false));
                if index + 1 == spec.selected {
                    chosen = Some(id);
                }
            }
            if position == 0 {
                let pane = &mut tabs.panes[0];
                pane.tabs.extend(local);
                if let Some(id) = chosen {
                    pane.selected = id;
                    pane.tabs[0].loaded = false;
                    if let Some(tab) = pane.tabs.iter_mut().find(|tab| tab.id == id) {
                        tab.loaded = true;
                    }
                }
            } else if let Some(first) = local.first().map(|tab| tab.id) {
                let selected = chosen.unwrap_or(first);
                if let Some(tab) = local.iter_mut().find(|tab| tab.id == selected) {
                    tab.loaded = true;
                }
                tabs.panes.push(Pane {
                    tabs: local,
                    selected,
                });
                kept.push(position);
            }
        }
        let count = tabs.panes.len();
        tabs.split = match split {
            Some(edges) if valid_split(edges, specs.len()) => kept
                .iter()
                .skip(1)
                .map(|&position| edges[position - 1])
                .collect(),
            _ => equal_split(count),
        };
        if !valid_split(&tabs.split, count) {
            tabs.split = equal_split(count);
        }
        tabs.focused = kept
            .iter()
            .position(|&position| position == focused)
            .unwrap_or(0);
        tabs
    }

    pub fn start(&self) -> Vec<Effect> {
        let mut effects = Vec::new();
        let order = (0..self.panes.len())
            .filter(|&index| index != self.focused)
            .chain(std::iter::once(self.focused));
        for index in order {
            let pane = &self.panes[index];
            if let Some(selected) = pane.tabs.iter().find(|tab| tab.id == pane.selected) {
                effects.push(Effect::CreateWebview {
                    tab: selected.id,
                    path: selected.path.clone(),
                });
                effects.push(Effect::Show(selected.id));
            }
        }
        effects.push(Effect::UpdateBar);
        effects
    }

    pub fn saved(&self) -> Saved<'_> {
        let panes = self
            .panes
            .iter()
            .enumerate()
            .map(|(index, pane)| {
                let first = usize::from(index == 0);
                let position = pane
                    .tabs
                    .iter()
                    .position(|tab| tab.id == pane.selected)
                    .unwrap_or(0);
                SavedPane {
                    paths: pane
                        .tabs
                        .iter()
                        .skip(first)
                        .map(|tab| tab.path.as_str())
                        .collect(),
                    selected: if index == 0 { position } else { position + 1 },
                }
            })
            .collect();
        Saved {
            panes,
            split: &self.split,
            focused: self.focused,
        }
    }

    pub fn selected(&self) -> TabId {
        self.pane().selected
    }

    pub fn home_selected(&self) -> bool {
        self.panes[0].selected == HOME
    }

    pub fn focused(&self) -> usize {
        self.focused
    }

    pub fn pane_count(&self) -> usize {
        self.panes.len()
    }

    pub fn split(&self) -> &[f64] {
        &self.split
    }

    pub fn tabs(&self) -> &[Tab] {
        &self.pane().tabs
    }

    pub fn pane_tabs(&self, pane: usize) -> &[Tab] {
        self.panes
            .get(pane)
            .map_or(&[], |candidate| &candidate.tabs)
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

    pub fn layout(&self) -> LayoutView {
        LayoutView {
            panes: self.view(),
            focused: self.focused,
            split: self.split.clone(),
        }
    }

    pub fn open(&mut self, path: &str) -> Vec<Effect> {
        match classify(path) {
            Route::Home => self.select(HOME),
            Route::Page(page) => self.open_page(path, page),
            Route::Stay => Vec::new(),
        }
    }

    fn open_page(&mut self, path: &str, page: Page) -> Vec<Effect> {
        if let Some(existing) = self
            .panes
            .iter()
            .flat_map(|pane| &pane.tabs)
            .find(|tab| tab.identity() == pathname(path))
        {
            let id = existing.id;
            return self.select(id);
        }
        if self.count() > MAX_TABS {
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
        let Some(index) = self.pane_of(tab) else {
            return Vec::new();
        };
        if route == Route::Home {
            if index == 0 && self.panes[0].selected == tab {
                self.focused = 0;
                return self.panes[0].close_to_home(tab);
            }
            return self.close(tab);
        }
        let Some(current) = self.panes[index]
            .tabs
            .iter_mut()
            .find(|candidate| candidate.id == tab)
        else {
            return Vec::new();
        };
        match route {
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
            Route::Home | Route::Page(_) | Route::Stay => Vec::new(),
        }
    }

    pub fn title(&mut self, tab: TabId, title: &str) -> Vec<Effect> {
        if tab == HOME {
            return Vec::new();
        }
        let Some(index) = self.pane_of(tab) else {
            return Vec::new();
        };
        let Some(current) = self.panes[index]
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
        let Some(index) = self.pane_of(tab) else {
            return Vec::new();
        };
        let refocus = index != self.focused;
        self.focused = index;
        let effects = self.panes[index].select(tab);
        if refocus && effects.is_empty() {
            return vec![Effect::Show(tab), Effect::UpdateBar, Effect::WriteTabFile];
        }
        effects
    }

    pub fn close(&mut self, tab: TabId) -> Vec<Effect> {
        let Some(index) = self.pane_of(tab) else {
            return Vec::new();
        };
        if tab == HOME {
            return Vec::new();
        }
        if self.panes[index].tabs.len() == 1 {
            return self.remove_pane(index);
        }
        let was_selected = self.panes[index].selected == tab;
        let effects = self.panes[index].close(tab);
        if was_selected {
            self.focused = index;
        }
        effects
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

    pub fn split_tab(&mut self) -> Vec<Effect> {
        let from = self.focused;
        let full = self.panes.len() >= MAX_PANES;
        let pane = &mut self.panes[from];
        let tab = pane.selected;
        if tab == HOME || pane.tabs.len() < 2 || full {
            return Vec::new();
        }
        let Some(position) = pane.index_of(tab) else {
            return Vec::new();
        };
        let moved = pane.tabs.remove(position);
        let mut effects = pane.take_selected_neighbour(position);
        let start = if from > 0 { self.split[from - 1] } else { 0.0 };
        let end = self.split.get(from).copied().unwrap_or(1.0);
        self.panes.insert(from + 1, Pane::holding(moved));
        self.split.insert(from, (start + end) / 2.0);
        if !valid_split(&self.split, self.panes.len()) {
            self.split = equal_split(self.panes.len());
        }
        self.focused = from + 1;
        effects.extend([
            Effect::Show(tab),
            Effect::Layout,
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]);
        effects
    }

    pub fn move_tab(&mut self, tab: TabId, to: usize) -> Vec<Effect> {
        let Some(from) = self.pane_of(tab) else {
            return Vec::new();
        };
        if tab == HOME || to >= self.panes.len() || to == from {
            return Vec::new();
        }
        let source = &mut self.panes[from];
        let Some(position) = source.index_of(tab) else {
            return Vec::new();
        };
        let mut moved = source.tabs.remove(position);
        let emptied = source.tabs.is_empty();
        let mut effects = Vec::new();
        if source.selected == tab && !emptied {
            effects.extend(source.take_selected_neighbour(position));
        }
        if !moved.loaded {
            moved.loaded = true;
            effects.push(Effect::CreateWebview {
                tab,
                path: moved.path.clone(),
            });
        }
        let destination = &mut self.panes[to];
        effects.push(Effect::Hide(destination.selected));
        destination.tabs.push(moved);
        destination.selected = tab;
        effects.push(Effect::Show(tab));
        let mut target = to;
        if emptied {
            self.panes.remove(from);
            self.split.remove(from - 1);
            if to > from {
                target -= 1;
            }
        }
        self.focused = target;
        effects.extend([Effect::Layout, Effect::UpdateBar, Effect::WriteTabFile]);
        effects
    }

    pub fn move_selected(&mut self) -> Vec<Effect> {
        if self.panes.len() < 2 {
            return Vec::new();
        }
        let to = (self.focused + 1) % self.panes.len();
        self.move_tab(self.selected(), to)
    }

    pub fn close_pane(&mut self, pane: usize) -> Vec<Effect> {
        if pane == 0 || pane >= self.panes.len() {
            return Vec::new();
        }
        let closing = self.panes.remove(pane);
        let hidden = closing.selected;
        let neighbour = &mut self.panes[pane - 1];
        neighbour.tabs.extend(closing.tabs);
        let shown = neighbour.selected;
        self.split.remove(pane - 1);
        self.focused = pane - 1;
        vec![
            Effect::Hide(hidden),
            Effect::Show(shown),
            Effect::Layout,
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    }

    fn remove_pane(&mut self, index: usize) -> Vec<Effect> {
        let removed = self.panes.remove(index);
        self.split.remove(index - 1);
        let mut effects: Vec<Effect> = removed
            .tabs
            .iter()
            .filter(|tab| tab.loaded)
            .map(|tab| Effect::Close(tab.id))
            .collect();
        if self.focused == index {
            self.focused = index - 1;
            effects.push(Effect::Show(self.pane().selected));
        } else if self.focused > index {
            self.focused -= 1;
        }
        effects.extend([Effect::Layout, Effect::UpdateBar, Effect::WriteTabFile]);
        effects
    }

    pub fn focus_pane(&mut self, pane: usize) -> Vec<Effect> {
        if pane >= self.panes.len() || pane == self.focused {
            return Vec::new();
        }
        self.focused = pane;
        vec![
            Effect::Show(self.pane().selected),
            Effect::UpdateBar,
            Effect::WriteTabFile,
        ]
    }

    pub fn focus_next_pane(&mut self) -> Vec<Effect> {
        let next = (self.focused + 1) % self.panes.len();
        self.focus_pane(next)
    }

    pub fn focus_tab(&mut self, tab: TabId) -> Vec<Effect> {
        let Some(index) = self.pane_of(tab) else {
            return Vec::new();
        };
        if index == self.focused {
            return Vec::new();
        }
        self.focused = index;
        vec![Effect::UpdateBar, Effect::WriteTabFile]
    }

    pub fn resize(&mut self, divider: usize, position: f64, commit: bool) -> Vec<Effect> {
        let Some(&current) = self.split.get(divider) else {
            return Vec::new();
        };
        if !position.is_finite() {
            return Vec::new();
        }
        let low = if divider > 0 {
            self.split[divider - 1]
        } else {
            0.0
        } + MIN_PANE_FRACTION;
        let high = self.split.get(divider + 1).copied().unwrap_or(1.0) - MIN_PANE_FRACTION;
        if low > high {
            return Vec::new();
        }
        let clamped = position.clamp(low, high);
        if (clamped - current).abs() < EDGE_TOLERANCE {
            return if commit {
                vec![Effect::WriteTabFile]
            } else {
                Vec::new()
            };
        }
        self.split[divider] = clamped;
        let mut effects = vec![Effect::Layout, Effect::UpdateBar];
        if commit {
            effects.push(Effect::WriteTabFile);
        }
        effects
    }

    pub fn apply(&mut self, action: Action) -> Vec<Effect> {
        match action {
            Action::CloseTab => self.close_selected(),
            Action::Select(position) => self.select_nth(position),
            Action::Next => self.cycle(true),
            Action::Previous => self.cycle(false),
            Action::SplitTab => self.split_tab(),
            Action::MoveTab => self.move_selected(),
            Action::ClosePane => self.close_pane(self.focused),
            Action::FocusNextPane => self.focus_next_pane(),
        }
    }

    fn count(&self) -> usize {
        self.panes.iter().map(|pane| pane.tabs.len()).sum()
    }

    fn pane_of(&self, tab: TabId) -> Option<usize> {
        self.panes
            .iter()
            .position(|pane| pane.index_of(tab).is_some())
    }

    fn pane(&self) -> &Pane {
        &self.panes[self.focused]
    }

    fn pane_mut(&mut self) -> &mut Pane {
        &mut self.panes[self.focused]
    }
}
